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
import {
  encodeWebRemoteControlRpcFrames,
  WebRemoteControlRpcAssembler,
  WebRemoteControlRpcEncodingError,
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
  const attachmentId = randomUUID();
  const { port1, port2 } = new MessageChannelMain();
  hostProcess.postMessage(
    {
      type: HostMessageTypes.AttachServicePort,
      requestId: randomUUID(),
      attachmentId,
      // 手机链路必须是 replayable：与桌面 continuous 语义分离（AGENTS.md 硬约束）。
      clientMode: "web-remote-replayable",
      scope: { kind: "local" },
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
  let disposed = false;
  const messageListeners = new Set<(event: { data: MessagePortPayload }) => void>();

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
      outboundSeq += 1;
      let frames: WebRemoteControlRpcMessageFrame[];
      try {
        // 分片与超限判定都在共享编码器里（限额单一来源 PROTOCOL_V4_LIMITS）。
        frames = encodeWebRemoteControlRpcFrames(encodePortMessage(data), {
          streamId,
          seq: outboundSeq,
        });
      } catch (error) {
        const reasonCode =
          error instanceof WebRemoteControlRpcEncodingError
            ? error.reasonCode
            : "rpc-transport-fault";
        params.logger.warn("[web-remote-control] rpc message rejected", {
          attachmentId: streamId,
          seq: outboundSeq,
          reasonCode,
        });
        params.onDegraded(reasonCode);
        return;
      }
      for (const [index, frame] of frames.entries()) {
        if (params.emitFrame({ zcode_type: "rpc-frame", frame })) continue;
        params.logger.warn("[web-remote-control] rpc frame dropped: mobile not attached", {
          attachmentId: streamId,
          seq: outboundSeq,
          fragmentIndex: index,
          fragmentCount: frames.length,
        });
        break;
      }
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
      // 装配状态的唯一所有者在这里：单槽、只装期望的 seq，装配成功才 ack。
      for (const event of assembler.push(frame)) {
        switch (event.kind) {
          case "message": {
            const decoded = decodePortMessage(event.message);
            const payload = { data: decoded as MessagePortPayload };
            for (const listener of messageListeners) {
              listener(payload);
            }
            bridge.emitAck(event.seq);
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
            break;
          }
          case "pending":
          case "ignored":
            break;
        }
      }
    },
    emitAck(seq) {
      if (disposed) return;
      const ackFrame: WebRemoteControlRpcTransportFrame = {
        streamId,
        seq,
        kind: "ack",
        ackSeq: seq,
      };
      params.emitFrame({ zcode_type: "rpc-frame", frame: ackFrame });
    },
    dispose() {
      disposed = true;
      messageListeners.clear();
      protocol.disconnect();
    },
  };

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
