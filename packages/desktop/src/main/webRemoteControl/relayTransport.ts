import { WebSocket } from "ws";
import {
  webRemoteControlAppPayloadSchema,
  webRemoteControlEndpointToClientFrameSchema,
  type WebRemoteControlAppPayload,
  type WebRemoteControlTransportState,
} from "@zcode/shared";
import type { WebRemoteControlLogger } from "./logger.js";

/**
 * 用户自备 relay 的设备传输（P4）：桌面 outbound 连用户填的 wss 端点，按官方 wire 收发。
 *
 * 与 LAN 传输的边界保持清晰：本文件只做鉴权、配对、心跳、转发与重连续配（spec：relay 与
 * Main 不保存业务状态）；应用信封照原样进出，由 manager 路由。
 */

const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_JITTER_MS = 2_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_JITTER_MS = 1_000;
export interface WebRemoteControlDeviceTransportEvents {
  onStateChange(state: WebRemoteControlTransportState): void;
  onPayload(payload: WebRemoteControlAppPayload): void;
  onRegisteredAuth(auth: { deviceSid: string; passHash: string }): void;
  onError(error: Error): void;
  onInvalidPersistedAuth(): Promise<void>;
}

export interface WebRemoteControlDeviceTransport {
  start(): Promise<void>;
  sendPayload(payload: WebRemoteControlAppPayload): boolean;
  dispose(): void;
}

export interface RelayDeviceTransportOptions {
  logger: WebRemoteControlLogger;
  relayWsUrl: string;
  deviceMid: string;
  deviceName: string;
  appVersion: string;
  maxPhysicalFrameBytes: number;
  auth:
    | { mode: "register"; passHash: string }
    | { mode: "persisted"; deviceSid: string; passHash: string };
  events: WebRemoteControlDeviceTransportEvents;
}

/** 创建用户自备 relay 的设备传输；start 完成握手并进入等待手机配对。 */
export function createRelayDeviceTransport(
  options: RelayDeviceTransportOptions,
): WebRemoteControlDeviceTransport {
  let socket: WebSocket | null = null;
  let disposed = false;
  let state: WebRemoteControlTransportState = "idle";
  let deviceSid = options.auth.mode === "persisted" ? options.auth.deviceSid : "";
  let auth: RelayDeviceTransportOptions["auth"] = options.auth;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let connectAttempt = 0;
  let invalidPersistedRetryUsed = false;
  let suppressNextCloseReconnect = false;

  function setState(next: WebRemoteControlTransportState): void {
    if (state === next) return;
    state = next;
    if (!disposed) options.events.onStateChange(next);
  }

  function sendFrame(frame: unknown): boolean {
    if (disposed || !socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(frame));
    return true;
  }

  function scheduleHeartbeat(): void {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    const jitter = Math.floor(Math.random() * HEARTBEAT_JITTER_MS);
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = null;
      if (disposed || !deviceSid) return;
      if (state !== "paired" && state !== "waiting_terminal") return;
      sendFrame({ type: "pair_status_query", device_sid: deviceSid, client_ts: Date.now() });
      scheduleHeartbeat();
    }, HEARTBEAT_INTERVAL_MS + jitter);
    heartbeatTimer.unref?.();
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function scheduleReconnect(delayMs: number): void {
    if (disposed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!disposed) connect();
    }, delayMs);
    reconnectTimer.unref?.();
  }

  function reconnectBackoff(): number {
    connectAttempt += 1;
    const exponential = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** Math.min(connectAttempt - 1, 5),
    );
    return exponential + Math.floor(Math.random() * RECONNECT_JITTER_MS);
  }

  function connect(): void {
    if (disposed) return;
    stopHeartbeat();
    setState("connecting");
    const url = new URL(options.relayWsUrl);
    url.searchParams.set("mid", options.deviceMid);
    const ws = new WebSocket(url.toString(), {
      perMessageDeflate: true,
      headers: { "X-Device-ID": options.deviceMid },
    });
    socket = ws;

    ws.on("open", () => {
      if (disposed || ws !== socket) return;
      if (auth.mode === "register") {
        setState("registering");
        sendFrame({
          type: "device_register_init",
          device_mid: options.deviceMid,
          pass_hash: auth.passHash,
          meta: {
            platform: process.platform,
            version: options.appVersion,
            name: options.deviceName,
          },
          client_ts: Date.now(),
        });
        return;
      }
      sendAuthInit(auth.deviceSid);
    });

    ws.on("message", (raw) => {
      if (disposed || ws !== socket) return;
      const text = typeof raw === "string" ? raw : raw.toString();
      if (Buffer.byteLength(text) > options.maxPhysicalFrameBytes) {
        options.logger.warn("[web-remote-control] oversize relay message dropped", {
          bytes: Buffer.byteLength(text),
          maxBytes: options.maxPhysicalFrameBytes,
        });
        return;
      }
      let parsed: ReturnType<typeof webRemoteControlEndpointToClientFrameSchema.safeParse>;
      try {
        parsed = webRemoteControlEndpointToClientFrameSchema.safeParse(JSON.parse(text));
      } catch {
        options.logger.warn("[web-remote-control] invalid relay message");
        return;
      }
      if (!parsed.success) {
        options.logger.warn("[web-remote-control] invalid relay frame");
        return;
      }
      void handleFrame(parsed.data);
    });

    ws.on("error", (error) => {
      if (ws !== socket) return;
      options.logger.warn("[web-remote-control] relay socket error", { message: error.message });
      options.events.onError(error);
    });

    ws.on("close", () => {
      if (ws !== socket) return;
      stopHeartbeat();
      if (disposed) return;
      if (suppressNextCloseReconnect) {
        suppressNextCloseReconnect = false;
        return;
      }
      setState("error");
      scheduleReconnect(reconnectBackoff());
    });
  }

  function sendAuthInit(sid: string): void {
    deviceSid = sid;
    setState("authenticating");
    sendFrame({
      type: "auth_init",
      role: "device",
      device_sid: sid,
      meta: {
        platform: process.platform,
        version: options.appVersion,
        name: options.deviceName,
      },
      client_ts: Date.now(),
    });
  }

  async function handleFrame(frame: unknown): Promise<void> {
    const parsed = webRemoteControlEndpointToClientFrameSchema.safeParse(frame);
    if (!parsed.success) return;
    const inbound = parsed.data as {
      type: string;
      device_sid?: string;
      pair_status?: string;
      payload?: unknown;
      code?: string;
      message?: string;
    };
    switch (inbound.type) {
      case "device_register_ack": {
        if (auth.mode !== "register") return;
        deviceSid = inbound.device_sid ?? "";
        const registered = { deviceSid, passHash: auth.passHash };
        auth = { mode: "persisted", deviceSid, passHash: auth.passHash };
        options.events.onRegisteredAuth(registered);
        sendAuthInit(deviceSid);
        return;
      }
      case "auth_challenge": {
        const nonce = (inbound as { nonce?: string }).nonce ?? "";
        if (auth.mode !== "persisted") return;
        // proof = HMAC-SHA256(passHash, `${nonce}|device|${deviceSid}`)（与 authProvider 同公式）
        const proof = await calculateProof(auth.passHash, nonce, "device", deviceSid);
        sendFrame({ type: "auth_response", device_sid: deviceSid, proof, client_ts: Date.now() });
        return;
      }
      case "auth_ack":
      case "pair_status_ack": {
        applyPairStatus(inbound.pair_status === "matched" ? "matched" : "waiting");
        return;
      }
      case "data": {
        if (state !== "paired") return;
        const payload = webRemoteControlAppPayloadSchema.safeParse(inbound.payload);
        if (!payload.success) {
          options.logger.warn("[web-remote-control] invalid relay app payload dropped");
          return;
        }
        options.events.onPayload(payload.data);
        return;
      }
      case "error": {
        await handleRelayError(inbound.code, inbound.message);
        return;
      }
      default:
        return;
    }
  }

  function applyPairStatus(pairStatus: "waiting" | "matched"): void {
    if (pairStatus === "matched") {
      scheduleHeartbeat();
      setState("paired");
      return;
    }
    setState("waiting_terminal");
    scheduleHeartbeat();
  }

  async function handleRelayError(
    code: string | undefined,
    message: string | undefined,
  ): Promise<void> {
    if (code === "KICKED") {
      options.logger.warn("[web-remote-control] relay kicked device", { message });
      socket?.close();
      return;
    }
    if (code === "AUTH_FAILED" && auth.mode === "persisted" && !invalidPersistedRetryUsed) {
      invalidPersistedRetryUsed = true;
      await options.events.onInvalidPersistedAuth();
      auth = { mode: "register", passHash: auth.passHash };
      deviceSid = "";
      suppressNextCloseReconnect = true;
      socket?.close();
      scheduleReconnect(0);
      return;
    }
    if (code === "INTERNAL" && (state === "paired" || state === "waiting_terminal")) {
      setState("waiting_terminal");
      return;
    }
    options.events.onError(new Error(message ?? code ?? "relay error"));
    setState("error");
  }

  return {
    async start() {
      connect();
      // 握手（register → auth_ack）最高等 30s；未就绪即失败，由调用方停掉运行时重试。
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("Web remote control relay handshake timed out."));
        }, 30_000);
        const poll = setInterval(() => {
          if (disposed) {
            cleanup();
            resolve();
            return;
          }
          if (state === "waiting_terminal" || state === "paired") {
            cleanup();
            resolve();
            return;
          }
          if (state === "error" && connectAttempt === 0) {
            cleanup();
            reject(new Error("Web remote control relay handshake failed."));
          }
        }, 50);
        function cleanup(): void {
          clearTimeout(timer);
          clearInterval(poll);
        }
        poll.unref?.();
        timer.unref?.();
      });
    },
    sendPayload(payload) {
      if (disposed || state !== "paired" || !deviceSid) return false;
      const frame = { type: "data", payload };
      const serialized = JSON.stringify(frame);
      if (Buffer.byteLength(serialized) > options.maxPhysicalFrameBytes) {
        options.logger.warn("[web-remote-control] dropped oversize relay payload", {
          zcodeType: payload.zcode_type,
          bytes: Buffer.byteLength(serialized),
          maxBytes: options.maxPhysicalFrameBytes,
        });
        return false;
      }
      return sendFrame(frame);
    },
    dispose() {
      stopHeartbeat();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      // 主动作废配对：否则旧二维码链接在 relay 上仍然有效（直到 TTL），
      // 「刷新后旧链接失效」不成立。必须先发再置 disposed（sendFrame 有守卫），
      // socket 已断时由 relay 侧 TTL 兜底。
      if (deviceSid && socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "device_unregister", device_sid: deviceSid }));
      }
      disposed = true;
      socket?.close();
      socket = null;
    },
  };
}

/** 与 authProvider.calculateProof 同一公式；传输层内联避免跨模块单例。 */
async function calculateProof(
  passHash: string,
  nonce: string,
  role: string,
  deviceSid: string,
): Promise<string> {
  const { createHmac } = await import("node:crypto");
  return createHmac("sha256", passHash).update(`${nonce}|${role}|${deviceSid}`).digest("base64url");
}
