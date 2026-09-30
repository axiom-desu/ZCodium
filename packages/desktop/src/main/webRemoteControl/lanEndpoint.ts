import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import {
  webRemoteControlAppPayloadSchema,
  webRemoteControlMobileToEndpointFrameSchema,
  type WebRemoteControlAppPayload,
  type WebRemoteControlEndpointToMobileFrame,
  type WebRemoteControlPairStatus,
} from "@zcode/shared";
import type { WebRemoteControlLogger } from "./logger.js";
import { createMobileAppStaticHandler } from "./mobileAppAssets.js";

/**
 * LAN 直连带端（默认传输）：桌面自身承担「设备注册 / 配对 / 转发」。
 *
 * - HTTP 同端口提供移动端静态页与 /healthz；WS 路径 `/ws` 走与官方兼容的 wire 帧；
 * - 绑定集合默认 = loopback + 本机 IPv4（LAN）；不绑 0.0.0.0，公网暴露由用户显式配置；
 * - 配对关系只在内存：端点重启即失效，业务状态不受影响（见 spec 状态所有者）。
 */

const WS_PATH = "/ws";
const PAIR_IDLE_TTL_MS = 24 * 60 * 60 * 1000;

export type WebRemoteControlEndpointDeviceState =
  | "connecting"
  | "registering"
  | "authenticating"
  | "waiting_terminal"
  | "paired"
  | "error";

export interface LanEndpointDeviceHandlers {
  onStateChange(state: WebRemoteControlEndpointDeviceState): void;
  onPayload(payload: WebRemoteControlAppPayload): void;
  onRegisteredAuth(auth: { deviceSid: string; passHash: string }): void;
  onError(error: Error): void;
  /** 持久化 sid 已失效：调用方应清档并转注册流程重新配对。 */
  onInvalidPersistedAuth(): void;
  onMobileDisconnected(): void;
}

export interface LanEndpointDeviceHandle {
  readonly deviceSid: string;
  sendPayload(payload: WebRemoteControlAppPayload): boolean;
  dispose(): void;
}

export interface LanEndpointOptions {
  logger: WebRemoteControlLogger;
  deviceMid: string;
  deviceName: string;
  appVersion: string;
  /**
   * 移动端 payload 的目的地。带 deviceSid：端点可能同时服务多个窗口的配对，
   * manager 据此路由到对应运行时。
   */
  handleMobilePayload(deviceSid: string, payload: WebRemoteControlAppPayload): void;
  maxPhysicalFrameBytes: number;
  /** 0 = 随机端口；显式端口便于用户配防火墙。 */
  port?: number;
}

interface DeviceSide {
  handle: LanEndpointDeviceHandle;
  handlers: LanEndpointDeviceHandlers;
}

interface PairEntry {
  deviceSid: string;
  passHash: string;
  device?: DeviceSide;
  mobile?: WebSocket;
  mobileNonce?: string;
  pairStatus: WebRemoteControlPairStatus;
  lastSeenAt: number;
}

interface LanEndpointInfo {
  port: number;
  /** 可达 base URL：loopback 在前（同机调试），LAN 地址是给手机的 QR 目标。 */
  baseUrls: string[];
}

export class LanRemoteControlEndpoint {
  private readonly servers = new Map<string, Server>();
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly pairs = new Map<string, PairEntry>();
  private readonly staticHandler: ReturnType<typeof createMobileAppStaticHandler>;
  private readonly maxFrameBytes: number;
  private info: LanEndpointInfo | null = null;
  private pairSweepTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: LanEndpointOptions) {
    this.staticHandler = createMobileAppStaticHandler({ logger: options.logger });
    this.maxFrameBytes = options.maxPhysicalFrameBytes;
  }

  get baseUrls(): string[] {
    return this.info?.baseUrls ?? [];
  }

  get isRunning(): boolean {
    return this.info !== null;
  }

  /** 释放设备侧会话（窗口停止/刷新配对时调用；仅摘除本端设备，不动配对表其他项）。 */
  releaseDevice(deviceSid: string): void {
    const entry = this.pairs.get(deviceSid);
    if (!entry) return;
    entry.device = undefined;
    if (!entry.mobile) {
      this.pairs.delete(deviceSid);
    }
  }

  async start(): Promise<LanEndpointInfo> {
    const requestedPort = this.options.port ?? 0;
    let boundPort = 0;
    for (const address of this.collectBindAddresses()) {
      const server = createServer((req, res) => this.handleHttp(req, res));
      server.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head));
      const bound = await new Promise<{ port: number } | null>((resolveListen) => {
        server.once("error", () => resolveListen(null));
        server.listen(boundPort || requestedPort, address, () => {
          const info = server.address();
          resolveListen(info && typeof info === "object" ? { port: info.port } : null);
        });
      });
      if (!bound) {
        server.close();
        continue;
      }
      if (boundPort === 0) {
        boundPort = bound.port;
      } else if (bound.port !== boundPort) {
        server.close();
        continue;
      }
      this.servers.set(address, server);
    }
    if (this.servers.size === 0 || boundPort === 0) {
      throw new Error("Web remote control LAN endpoint failed to bind any address");
    }
    const baseUrls = [...this.servers.keys()].map(
      (address) => `http://${address === "127.0.0.1" ? "127.0.0.1" : address}:${boundPort}/`,
    );
    baseUrls.sort((a, b) => (a.includes("127.0.0.1") ? -1 : b.includes("127.0.0.1") ? 1 : 0));
    this.info = { port: boundPort, baseUrls };
    this.pairSweepTimer = setInterval(() => this.sweepIdlePairs(), 60 * 60 * 1000);
    this.options.logger.info("[web-remote-control] LAN endpoint listening", {
      port: boundPort,
      addresses: [...this.servers.keys()],
    });
    return this.info;
  }

  async stop(): Promise<void> {
    if (this.pairSweepTimer) {
      clearInterval(this.pairSweepTimer);
      this.pairSweepTimer = null;
    }
    for (const entry of this.pairs.values()) {
      entry.mobile?.close(1001, "endpoint-stopped");
      entry.device?.handlers.onMobileDisconnected();
    }
    this.pairs.clear();
    for (const server of this.servers.values()) {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
    this.servers.clear();
    this.info = null;
  }

  /** 创建设备侧会话（桌面用）：register 生成新 sid；persisted 续用（无效则 error）。 */
  registerDevice(
    auth:
      | { mode: "register"; passHash: string }
      | { mode: "persisted"; deviceSid: string; passHash: string },
    handlers: LanEndpointDeviceHandlers,
  ): LanEndpointDeviceHandle {
    // device handle 的发送必须落到配对中的手机 socket；空桩会让桌面出站全部静默丢弃。
    const makeHandle = (sid: string): LanEndpointDeviceHandle => ({
      deviceSid: sid,
      sendPayload: (payload) => this.deliverToMobile(sid, payload),
      dispose: () => this.releaseDevice(sid),
    });

    if (auth.mode === "persisted") {
      const existing = this.pairs.get(auth.deviceSid);
      if (!existing || existing.passHash !== auth.passHash || existing.device) {
        // 旧 sid 已失效（TTL / 端点重启 / 刷新配对）：按 error 处理，
        // 由调用方转注册流程重新配对。
        handlers.onStateChange("error");
        handlers.onError(new Error("Persisted web remote control device auth is no longer valid"));
        handlers.onInvalidPersistedAuth();
        return makeHandle(auth.deviceSid);
      }
      existing.device = { handle: makeHandle(existing.deviceSid), handlers };
      this.enterWaitingTerminal(existing);
      return existing.device.handle;
    }
    const deviceSid = randomBytes(16).toString("base64url");
    const entry: PairEntry = {
      deviceSid,
      passHash: auth.passHash,
      pairStatus: "waiting",
      lastSeenAt: Date.now(),
    };
    entry.device = { handle: makeHandle(deviceSid), handlers };
    this.pairs.set(deviceSid, entry);
    handlers.onStateChange("registering");
    handlers.onRegisteredAuth({ deviceSid, passHash: auth.passHash });
    this.enterWaitingTerminal(entry);
    return entry.device.handle;
  }

  private enterWaitingTerminal(entry: PairEntry): void {
    entry.pairStatus = "waiting";
    entry.device?.handlers.onStateChange("waiting_terminal");
  }

  private collectBindAddresses(): string[] {
    const addresses = new Set<string>(["127.0.0.1"]);
    for (const list of Object.values(networkInterfaces())) {
      for (const item of list ?? []) {
        if (item.family === "IPv4" && !item.internal) {
          addresses.add(item.address);
        }
      }
    }
    return [...addresses];
  }

  private handleUpgrade(req: IncomingMessage, socket: unknown, head: unknown): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== WS_PATH) {
      (socket as { destroy(): void }).destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket as never, head as never, (ws: WebSocket) => {
      void this.attachMobileSocket(ws);
    });
  }

  private async attachMobileSocket(ws: WebSocket): Promise<void> {
    let entry: PairEntry | null = null;
    const send = (frame: WebRemoteControlEndpointToMobileFrame): void => {
      ws.send(JSON.stringify(frame));
    };
    const fail = (code: "AUTH_FAILED" | "WRONG_PARAM" | "INTERNAL", message?: string): void => {
      send({ type: "error", code, message });
      ws.close(4001, code);
    };

    ws.on("message", (raw) => {
      const text = typeof raw === "string" ? raw : raw.toString();
      if (Buffer.byteLength(text) > this.maxFrameBytes) {
        this.options.logger.warn("[web-remote-control] oversize mobile frame dropped", {
          bytes: Buffer.byteLength(text),
          maxBytes: this.maxFrameBytes,
        });
        fail("WRONG_PARAM", "frame too large");
        return;
      }
      let parsed: ReturnType<typeof webRemoteControlMobileToEndpointFrameSchema.safeParse>;
      try {
        parsed = webRemoteControlMobileToEndpointFrameSchema.safeParse(JSON.parse(text));
      } catch {
        fail("WRONG_PARAM", "invalid json");
        return;
      }
      if (!parsed.success) {
        fail("WRONG_PARAM", "invalid frame");
        return;
      }
      const frame = parsed.data;
      switch (frame.type) {
        case "auth_init": {
          if (frame.role !== "mobile") {
            fail("AUTH_FAILED");
            return;
          }
          const candidate = this.pairs.get(frame.device_sid);
          if (!candidate) {
            fail("AUTH_FAILED");
            return;
          }
          entry = candidate;
          entry.mobileNonce = randomBytes(16).toString("base64url");
          send({ type: "auth_challenge", nonce: entry.mobileNonce });
          return;
        }
        case "auth_response": {
          if (!entry || !entry.mobileNonce) {
            fail("AUTH_FAILED");
            return;
          }
          const expected = calculateProof(
            entry.passHash,
            entry.mobileNonce,
            "mobile",
            entry.deviceSid,
          );
          if (!safeEqual(expected, frame.proof)) {
            entry.mobileNonce = undefined;
            fail("AUTH_FAILED");
            return;
          }
          entry.mobileNonce = undefined;
          if (entry.mobile && entry.mobile !== ws) {
            // 单页面互踢：先给旧连接发 error{KICKED}（桌面/移动端据此映射
            // session-conflict），再关闭；只关不发会让旧页面静默掉线。
            const stale = entry.mobile;
            stale.send(JSON.stringify({ type: "error", code: "KICKED", message: "kicked" }));
            stale.close(4002, "kicked");
          }
          entry.mobile = ws;
          entry.pairStatus = "matched";
          entry.lastSeenAt = Date.now();
          entry.device?.handlers.onStateChange("paired");
          send({ type: "auth_ack", pair_status: "matched" });
          return;
        }
        case "pair_status_query": {
          if (!entry || this.pairs.get(frame.device_sid) !== entry) {
            fail("AUTH_FAILED");
            return;
          }
          entry.lastSeenAt = Date.now();
          send({ type: "pair_status_ack", pair_status: entry.pairStatus });
          return;
        }
        case "data": {
          if (!entry || entry.mobile !== ws) {
            fail("AUTH_FAILED");
            return;
          }
          entry.lastSeenAt = Date.now();
          const payload = webRemoteControlAppPayloadSchema.safeParse(frame.payload);
          if (!payload.success) {
            this.options.logger.warn("[web-remote-control] invalid app payload dropped");
            return;
          }
          this.options.handleMobilePayload(entry.deviceSid, payload.data);
          return;
        }
        default:
          fail("WRONG_PARAM");
      }
    });

    ws.on("close", () => {
      if (!entry || entry.mobile !== ws) return;
      entry.mobile = undefined;
      entry.pairStatus = "waiting";
      entry.device?.handlers.onMobileDisconnected();
    });
    ws.on("error", (error) => {
      this.options.logger.warn("[web-remote-control] mobile socket error", {
        message: error.message,
      });
    });
  }

  /** 端点 → 设备侧的 payload 下发（桌面状态机走这里发给手机）。 */
  deliverToMobile(deviceSid: string, payload: WebRemoteControlAppPayload): boolean {
    const entry = this.pairs.get(deviceSid);
    const mobile = entry?.mobile;
    if (!entry || !mobile) {
      return false;
    }
    const frame: WebRemoteControlEndpointToMobileFrame = { type: "data", payload };
    const serialized = JSON.stringify(frame);
    if (Buffer.byteLength(serialized) > this.maxFrameBytes) {
      this.options.logger.warn("[web-remote-control] dropped oversize app payload", {
        zcodeType: payload.zcode_type,
        bytes: Buffer.byteLength(serialized),
        maxBytes: this.maxFrameBytes,
      });
      return false;
    }
    mobile.send(serialized);
    return true;
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          status: "ok",
          pairs: this.pairs.size,
          addresses: [...this.servers.keys()],
        }),
      );
      return;
    }
    void this.staticHandler(url.pathname).then((result) => {
      res.writeHead(result.status, {
        "content-type": result.contentType ?? "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(result.body ?? "");
    });
  }

  private sweepIdlePairs(): void {
    const now = Date.now();
    for (const [sid, entry] of this.pairs) {
      if (now - entry.lastSeenAt < PAIR_IDLE_TTL_MS) continue;
      entry.mobile?.close(4003, "pair-expired");
      entry.device?.handlers.onMobileDisconnected();
      this.pairs.delete(sid);
      this.options.logger.info("[web-remote-control] idle pair expired", {
        deviceSidSuffix: sid.slice(-6),
      });
    }
  }
}

function calculateProof(passHash: string, nonce: string, role: string, deviceSid: string): string {
  return createHmac("sha256", passHash).update(`${nonce}|${role}|${deviceSid}`).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
