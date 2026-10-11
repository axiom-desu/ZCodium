import { randomUUID } from "node:crypto";
import { type MessagePortMain, MessageChannelMain } from "electron";
import { type MessagePortLike, type MessagePortPayload } from "@zcode/rpc";
import { HostMessageTypes } from "@zcode/shared";
import type { WebRemoteControlLogger } from "./logger.js";
import { createWebRemoteControlServicePipe } from "./servicePipe.js";
import type { WindowHostAttachmentScope } from "@zcode/shared";
import {
  encodeWebRemoteControlRpcFrames,
  parseWebRemoteControlRpcAckFrame,
  WebRemoteControlRpcAckScheduler,
  WebRemoteControlRpcAssembler,
  WebRemoteControlRpcEncodingError,
  WebRemoteControlRpcReplayBuffer,
  WEB_REMOTE_CONTROL_RPC_FAULT_REASONS,
  WEB_REMOTE_CONTROL_RPC_LIMITS,
  type WebRemoteControlRpcAssemblyEvent,
  type WebRemoteControlRpcMessageFrame,
  type WebRemoteControlRpcTransportFrame,
} from "@zcode/shared";

/**
 * 手机 ↔ 桌面已有 Host 的 RPC 桥接：
 * - main 侧向窗口 Host 进程申请一条 `web-remote-replayable` 的本地 service port
 *   （复用 renderer reload / 远端重连同一条 AttachServicePort 通道，不新起 Agent/Host）；
 * - 装配器把该 port 上的协议消息与传输层 rpc-frame 互转：保序 + ack + 体积上限。
 *
 * 边界：bridge 不参与 run owner/lease；stale run 防护仍由 Host 侧决定。
 */

export interface WebRemoteControlHostAttachment {
  attachmentId: string;
  port: MessagePortMain;
  dispose(): void;
}

export interface WebRemoteControlRpcBridge {
  /** 传输层 → 桌面：手机侧 rpc-frame 进入桥接（ack/flow 帧在此消费）。 */
  acceptFrame(frame: WebRemoteControlRpcTransportFrame): void;
  /** 桌面 → 传输层：当前只用 ack；消息帧由 `sendToMobile`（Host port 收到的消息）发出。 */
  emitAck(seq: number): void;
  dispose(): void;
}

export function attachWorkspaceHostPort(params: {
  windowId: number;
  webContentsId: number;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  resolveHostProcess(webContentsId: number): ElectronUtilityProcessLike | undefined;
  logger: WebRemoteControlLogger;
}): WebRemoteControlHostAttachment {
  const hostProcess = params.resolveHostProcess(params.webContentsId);
  if (!hostProcess) {
    throw new Error("Web remote control host process is unavailable for this window");
  }
  // 远端 workspace 必须绑到它自己的 remote session host：绑成 local 会把手机远控挂到本地
  // host 上，目标 workspace 的会话/文件全都对不上。remote scope 三项都是必填（见
  // shared/validation.ts 的 windowHostAttachmentScopeSchema），缺 identity 就明确失败，
  // 不做「按路径回退」——同路径可能属于不同 identity。
  if (params.remoteSessionId && !params.workspaceIdentity) {
    throw new Error(
      "Remote web remote control attachment requires workspaceIdentity alongside remoteSessionId",
    );
  }
  const scope: WindowHostAttachmentScope = params.remoteSessionId
    ? {
        kind: "remote",
        remoteSessionId: params.remoteSessionId,
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity!,
      }
    : { kind: "local" };
  const attachmentId = randomUUID();
  const { port1, port2 } = new MessageChannelMain();
  hostProcess.postMessage(
    {
      type: HostMessageTypes.AttachServicePort,
      requestId: randomUUID(),
      attachmentId,
      // 手机链路必须是 replayable：与桌面 continuous 语义分离（AGENTS.md 硬约束）。
      clientMode: "web-remote-replayable",
      scope,
    },
    [port2],
  );
  params.logger.info("[web-remote-control] attached window host port", {
    windowId: params.windowId,
    attachmentId,
    workspacePath: params.workspacePath,
    remoteSessionId: params.remoteSessionId ?? "none",
  });
  return {
    attachmentId,
    port: port1,
    dispose() {
      hostProcess.postMessage({
        type: HostMessageTypes.DetachServicePort,
        attachmentId,
      });
      port1.close();
    },
  };
}

/** Uint8Array ↔ JSON 安全表示：rpc-frame 要过 JSON 序列化才能进传输层。 */
function encodePortMessage(data: unknown): unknown {
  if (data instanceof Uint8Array) {
    return { __zcodeBytes: Buffer.from(data).toString("base64") };
  }
  if (data instanceof ArrayBuffer) {
    return { __zcodeBytes: Buffer.from(new Uint8Array(data)).toString("base64") };
  }
  return data;
}

function decodePortMessage(value: unknown): unknown {
  if (value && typeof value === "object" && "__zcodeBytes" in (value as object)) {
    const base64 = (value as { __zcodeBytes?: unknown }).__zcodeBytes;
    if (typeof base64 === "string") {
      return new Uint8Array(Buffer.from(base64, "base64"));
    }
  }
  return value;
}

export interface OpenHostBridgeParams {
  attachment: WebRemoteControlHostAttachment;
  /** 桌面 → 手机：把 rpc-frame 信封交给传输层。 */
  emitFrame(envelope: {
    zcode_type: "rpc-frame";
    frame: WebRemoteControlRpcTransportFrame;
  }): boolean;
  onDegraded(reason: string): void;
  logger: WebRemoteControlLogger;
}

export interface OpenHostBridgeResult {
  bridge: WebRemoteControlRpcBridge;
  dispose(): void;
}

export function openWebRemoteControlHostBridge(params: OpenHostBridgeParams): OpenHostBridgeResult {
  const streamId = params.attachment.attachmentId;
  let outboundSeq = 0;
  const assembler = new WebRemoteControlRpcAssembler();
  // 出站重传缓冲 + ack 批量调度：单序号空间 `(ackedSeq, lastSentSeq]`，与接收侧装配器各自一侧。
  const replayBuffer = new WebRemoteControlRpcReplayBuffer();
  let disposed = false;

  function sendAck(ackSeq: number): void {
    if (disposed) return;
    const ackFrame: WebRemoteControlRpcTransportFrame = {
      streamId,
      seq: ackSeq,
      kind: "ack",
      ackSeq,
    };
    params.emitFrame({ zcode_type: "rpc-frame", frame: ackFrame });
  }

  const ackScheduler = new WebRemoteControlRpcAckScheduler({ onFlush: sendAck });

  /** 按序发出重传帧；对端未挂载就停下（后续重连再靠同一缓冲重放），返回是否全部发出。 */
  function emitReplayFrames(frames: readonly WebRemoteControlRpcMessageFrame[]): boolean {
    for (const frame of frames) {
      if (!params.emitFrame({ zcode_type: "rpc-frame", frame })) return false;
    }
    return true;
  }

  /** 接收侧装配事件统一入口：装配成功交上层并排 ack；fault 上报降级。 */
  function handleAssemblyEvents(events: WebRemoteControlRpcAssemblyEvent[]): void {
    for (const event of events) {
      switch (event.kind) {
        case "message": {
          // 透明转发：装配出来的手机消息直接写进 Host port（Host 的 ChannelServer 在另一端），
          // main 不解析、不代理 service。
          pipe.acceptMobileMessage(decodePortMessage(event.message) as MessagePortPayload);
          // 不逐条立即 ack：交给批量调度，deadline 保证最后一个一定发出。
          ackScheduler.record(event.seq);
          break;
        }
        case "fault": {
          params.logger.warn("[web-remote-control] rpc transport fault", {
            attachmentId: streamId,
            seq: event.seq,
            reasonCode: event.reasonCode,
            expected: assembler.acknowledgedSeq + 1,
          });
          params.onDegraded(event.reasonCode);
          if (
            event.reasonCode === WEB_REMOTE_CONTROL_RPC_FAULT_REASONS.frameGap ||
            event.reasonCode === WEB_REMOTE_CONTROL_RPC_FAULT_REASONS.bufferTimeout
          ) {
            // 丢片：把「最后连续装配到的 seq」再 ack 一次，对端据此从 ackSeq+1 重传；
            // 不新增 wire 帧类型，仍复用单序号空间的 ack。本方向也按窗口 go-back-N，双向收敛。
            ackScheduler.record(assembler.acknowledgedSeq);
            emitReplayFrames(replayBuffer.replayUnacknowledged());
          }
          break;
        }
        case "pending":
        case "ignored":
          break;
      }
    }
  }

  /**
   * Host → 手机方向的唯一出口：编码分片 → 重传入队 → 发射。
   * 返回是否确实交给了传输层；pipe 用它决定要不要 warn「手机未挂载」。
   */
  function sendToMobile(data: MessagePortPayload): boolean {
    if (disposed) return false;
    const seq = outboundSeq + 1;
    let frames: WebRemoteControlRpcMessageFrame[];
    try {
      // 分片与超限判定都在共享编码器里（限额单一来源 PROTOCOL_V4_LIMITS）。
      frames = encodeWebRemoteControlRpcFrames(encodePortMessage(data), {
        streamId,
        seq,
      });
    } catch (error) {
      const reasonCode =
        error instanceof WebRemoteControlRpcEncodingError
          ? error.reasonCode
          : "rpc-transport-fault";
      params.logger.warn("[web-remote-control] rpc message rejected", {
        attachmentId: streamId,
        seq,
        reasonCode,
      });
      params.onDegraded(reasonCode);
      return false;
    }
    // 入队失败就不发出半条：seq 不推进，对端期望值也不会跳过。
    const recorded = replayBuffer.record(seq, frames);
    if (!recorded.accepted) {
      params.logger.warn("[web-remote-control] rpc replay buffer overflow", {
        attachmentId: streamId,
        seq,
        reasonCode: recorded.reasonCode,
      });
      params.onDegraded(recorded.reasonCode);
      return false;
    }
    outboundSeq = seq;
    return emitReplayFrames(frames);
  }

  // main 只做透明转发：把 Host port 适配成 MessagePortLike，收到的每条 Host 消息走
  // sendToMobile；手机装配出来的消息由 pipe.acceptMobileMessage 写回 Host port。
  // 不在 main 建 ChannelClient/ChannelServer：服务端唯一在 Host 进程，流控端到端。
  const hostPort = wrapElectronPort(params.attachment.port);
  const pipe = createWebRemoteControlServicePipe({
    hostPort,
    sendToMobile,
    attachmentId: streamId,
    logger: params.logger,
  });
  hostPort.start();

  const bridge: WebRemoteControlRpcBridge = {
    acceptFrame(frame) {
      if (disposed) return;
      // ack 帧不进装配器：前向 ack 的语义是「对端已连续装配到的 seq」，只推进窗口、释放
      // 已确认前缀；正常流水下 ack 必然滞后于 lastSentSeq（批量合并 + 在途帧），若在此按
      // (ackSeq, lastSentSeq] 重发，每个正常 ack 都会触发一次无意义重传。丢片重传由对端
      // nudge（gap / buffer-timeout）驱动，见 handleAssemblyEvents。
      const ack = parseWebRemoteControlRpcAckFrame(frame);
      if (ack) {
        replayBuffer.acknowledge(ack.ackSeq);
        return;
      }
      // 装配状态的唯一所有者在这里：单槽、只装期望的 seq，装配成功才 ack（批量调度）。
      handleAssemblyEvents(assembler.push(frame));
    },
    emitAck(seq) {
      sendAck(seq);
    },
    dispose() {
      disposed = true;
      clearInterval(sweepTimer);
      ackScheduler.dispose();
      replayBuffer.clear();
      pipe.dispose();
    },
  };

  // 装配槽周期清扫：链路静默时残片不会永久占槽（超时只在有帧到达时不会被评估）。
  const sweepTimer = setInterval(() => {
    if (disposed) return;
    handleAssemblyEvents(assembler.sweep());
  }, WEB_REMOTE_CONTROL_RPC_LIMITS.assemblySweepIntervalMs);

  return {
    bridge,
    dispose() {
      bridge.dispose();
      params.attachment.dispose();
    },
  };
}

/**
 * Electron MessagePortMain → RPC 层 MessagePortLike 的适配（与 host/electronPort.ts 同构）。
 *
 * 这里内联一份而不是 import host 目录：`tsconfig.main.json` 的 rootDir 是 `src/main`，
 * 跨 rootDir 引用会把 host 源文件拉进 main 工程并触发 TS6059。
 */
function wrapElectronPort(port: MessagePortMain): MessagePortLike {
  return {
    addEventListener(_type, listener) {
      port.on("message", listener);
    },
    removeEventListener(_type, listener) {
      port.off("message", listener);
    },
    postMessage(data) {
      port.postMessage(data);
    },
    start() {
      port.start();
    },
    close() {
      port.close();
    },
  };
}

interface ElectronUtilityProcessLike {
  postMessage(message: unknown, transfer?: MessagePortMain[]): void;
}
