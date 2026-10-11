import { randomUUID } from "node:crypto";
import { type MessagePortMain, MessageChannelMain } from "electron";
import {
  ChannelClient,
  MessagePortProtocol,
  ProxyChannel,
  type MessagePortLike,
  type MessagePortPayload,
} from "@zcode/rpc";
import { HostMessageTypes } from "@zcode/shared";
import {
  IZCodeAgentService,
  IZCodeSessionService,
  IZCodeTaskService,
  IModelSelectionService,
} from "@zcode/services";
import type { WebRemoteControlLogger } from "./logger.js";
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
  /** 桌面 → 传输层：当前只用 ack；消息帧由 port 的 postMessage 路径发出。 */
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
  services: {
    zcodeTaskService: IZCodeTaskService;
    zcodeSessionService: IZCodeSessionService;
    zcodeAgentService: IZCodeAgentService;
    modelSelectionService: IModelSelectionService;
  };
  dispose(): void;
}

export function openWebRemoteControlHostBridge(params: OpenHostBridgeParams): OpenHostBridgeResult {
  const streamId = params.attachment.attachmentId;
  let outboundSeq = 0;
  const assembler = new WebRemoteControlRpcAssembler();
  // 出站重传缓冲 + ack 批量调度：单序号空间 `(ackedSeq, lastSentSeq]`，与接收侧装配器各自一侧。
  const replayBuffer = new WebRemoteControlRpcReplayBuffer();
  let disposed = false;
  const messageListeners = new Set<(event: { data: MessagePortPayload }) => void>();

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

  /** 按序发出重传帧；对端未挂载就停下（后续重连再靠同一缓冲重放）。 */
  function emitReplayFrames(frames: readonly WebRemoteControlRpcMessageFrame[]): void {
    for (const frame of frames) {
      if (params.emitFrame({ zcode_type: "rpc-frame", frame })) continue;
      params.logger.warn("[web-remote-control] rpc replay frame dropped: mobile not attached", {
        attachmentId: streamId,
        seq: frame.seq,
      });
      return;
    }
  }

  /** 接收侧装配事件统一入口：装配成功交上层并排 ack；fault 上报降级。 */
  function handleAssemblyEvents(events: WebRemoteControlRpcAssemblyEvent[]): void {
    for (const event of events) {
      switch (event.kind) {
        case "message": {
          const decoded = decodePortMessage(event.message);
          const payload = { data: decoded as MessagePortPayload };
          for (const listener of messageListeners) {
            listener(payload);
          }
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

  const portLike: MessagePortLike = {
    addEventListener(type, listener) {
      if (type !== "message") return;
      messageListeners.add(listener as (event: { data: MessagePortPayload }) => void);
    },
    removeEventListener(type, listener) {
      if (type !== "message") return;
      messageListeners.delete(listener as (event: { data: MessagePortPayload }) => void);
    },
    postMessage(data) {
      if (disposed) return;
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
        return;
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
        return;
      }
      outboundSeq = seq;
      emitReplayFrames(frames);
    },
    start() {
      params.attachment.port.start();
    },
    close() {
      // port 生命周期由 attachment 持有；桥接销毁只停转发。
    },
  };

  const protocol = new MessagePortProtocol(portLike);
  const client = new ChannelClient(protocol);
  const services = {
    zcodeTaskService: ProxyChannel.toService<IZCodeTaskService>(
      client.getChannel(IZCodeTaskService.channelName),
    ),
    zcodeSessionService: ProxyChannel.toService<IZCodeSessionService>(
      client.getChannel(IZCodeSessionService.channelName),
    ),
    zcodeAgentService: ProxyChannel.toService<IZCodeAgentService>(
      client.getChannel(IZCodeAgentService.channelName),
    ),
    modelSelectionService: ProxyChannel.toService<IModelSelectionService>(
      client.getChannel(IModelSelectionService.channelName),
    ),
  };

  const bridge: WebRemoteControlRpcBridge = {
    acceptFrame(frame) {
      if (disposed) return;
      // ack 帧不进装配器：推进重传窗口，并从 ackSeq+1 重发仍未确认的帧（幂等）。
      const ack = parseWebRemoteControlRpcAckFrame(frame);
      if (ack) {
        emitReplayFrames(replayBuffer.acknowledge(ack.ackSeq));
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
      messageListeners.clear();
      protocol.disconnect();
    },
  };

  // 装配槽周期清扫：链路静默时残片不会永久占槽（超时只在有帧到达时不会被评估）。
  const sweepTimer = setInterval(() => {
    if (disposed) return;
    handleAssemblyEvents(assembler.sweep());
  }, WEB_REMOTE_CONTROL_RPC_LIMITS.assemblySweepIntervalMs);

  return {
    bridge,
    services,
    dispose() {
      bridge.dispose();
      params.attachment.dispose();
    },
  };
}

interface ElectronUtilityProcessLike {
  postMessage(message: unknown, transfer?: MessagePortMain[]): void;
}
