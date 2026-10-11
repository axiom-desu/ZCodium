/* eslint-disable max-lines -- 手机配对协议客户端：鉴权/信封收发/装配重传都在同一条 WebSocket 生命周期里，拆分会让序号、缓冲与定时器所有者分叉（与 rpcTransport.ts 同一口径）。 */
import { connectViaProtocol } from "@zcode/client";
import { VSBuffer } from "@zcode/rpc";
import {
  encodeWebRemoteControlRpcFrames,
  parseWebRemoteControlRpcAckFrame,
  type WebRemoteControlAppPayload,
  WebRemoteControlRpcAckScheduler,
  WebRemoteControlRpcAssembler,
  WebRemoteControlRpcReplayBuffer,
  WEB_REMOTE_CONTROL_RPC_FAULT_REASONS,
  WEB_REMOTE_CONTROL_RPC_LIMITS,
  type WebRemoteControlRpcAssemblyEvent,
  type WebRemoteControlRpcMessageFrame,
  type WebRemoteControlRpcTransportFrame,
} from "@zcode/shared";

/**
 * 移动端配对协议客户端：与桌面 LAN 端点（`LanRemoteControlEndpoint`）按同一份
 * shared wire 契约通信。职责只有三件：鉴权配对、应用信封收发、把 rpc-frame
 * 还原成 @zcode/rpc 的 IMessagePassingProtocol（聊天走既有 ChannelClient）。
 */

export interface MobilePairingParams {
  deviceSid: string;
  passHash: string;
  deviceMid?: string;
  deviceName?: string;
  appVersion?: string;
}

export type MobileConnectionState =
  | "connecting"
  | "authenticating"
  | "waiting"
  | "paired"
  | "closed"
  | "error";

export interface MobileClientEvents {
  onStateChange(
    state: MobileConnectionState,
    detail?: { closeCode?: number; reason?: string },
  ): void;
  onPayload(payload: WebRemoteControlAppPayload): void;
}

interface PendingRequest {
  resolve(payload: WebRemoteControlAppPayload): void;
  reject(error: Error): void;
  timer: number;
}

const REQUEST_TIMEOUT_MS = 30_000;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** rpc-frame 载荷 ↔ WebCrypto 可签名字节。 */
function encodeRpcMessage(message: unknown): unknown {
  if (message instanceof Uint8Array) {
    return { __zcodeBytes: toBase64Url(message) };
  }
  return message;
}

function decodeRpcMessage(value: unknown): unknown {
  if (value && typeof value === "object" && "__zcodeBytes" in (value as object)) {
    const base64 = (value as { __zcodeBytes?: unknown }).__zcodeBytes;
    if (typeof base64 === "string") return fromBase64(base64);
  }
  return value;
}

export class MobileRemoteControlClient {
  private socket: WebSocket | null = null;
  private state: MobileConnectionState = "connecting";
  private requestSeq = 0;
  private pending = new Map<string, PendingRequest>();
  private rpcSeq = 0;
  private rpcStreamId = `mobile-${Math.random().toString(36).slice(2)}`;
  /** 桌面 → 手机方向的装配器；单槽、只装期望的 seq（与桌面侧同一份实现）。 */
  private rpcAssembler = new WebRemoteControlRpcAssembler();
  /** 手机 → 桌面方向的重传缓冲；单序号空间 `(ackedSeq, lastSentSeq]`。 */
  private rpcReplayBuffer = new WebRemoteControlRpcReplayBuffer();
  /** ack 批量调度：合并窗口 + deadline 兜底（远小于对端 ackWatchdogMs）。 */
  private rpcAckScheduler = new WebRemoteControlRpcAckScheduler({
    onFlush: (ackSeq) => this.sendAckFrame(ackSeq),
  });
  /** 装配槽周期清扫定时器（静默链路也收敛残片）。 */
  private assemblySweepTimer: number | null = null;
  /** 已握手成功的 workspace bridge（桌面按 workspaceKey 路由，rpc-frame 只有在 bridge 存在时才被接收）。 */
  private bridgeReadyWorkspaceKey: string | null = null;
  private serviceAccessorInstance: ReturnType<typeof connectViaProtocol> | null = null;
  private onRpcMessage: ((data: unknown) => void) | null = null;
  private disposed = false;
  private reconnectTimer: number | null = null;
  private connectAttempt = 0;

  constructor(
    private readonly params: MobilePairingParams & { wsUrl: string },
    private readonly events: MobileClientEvents,
  ) {}

  connect(): void {
    this.disposed = false;
    this.openSocket();
  }

  /**
   * 网络切换 / 息屏回前台后立刻重连。
   *
   * 只在确实断开（closed/error，且当前 socket 不处于 OPEN/CONNECTING）时动手：首屏 pageshow
   * 也会触发这个入口，那时正在连接中，强行重连反而会把刚建立的链路踢掉。
   */
  retryNow(): void {
    if (this.disposed) return;
    const readyState = this.socket?.readyState;
    if (readyState === WebSocket.OPEN || readyState === WebSocket.CONNECTING) return;
    if (this.state !== "closed" && this.state !== "error") return;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connectAttempt = 0;
    this.openSocket();
  }

  private openSocket(): void {
    const socket = new WebSocket(this.params.wsUrl);
    this.socket = socket;
    this.ensureAssemblySweepTimer();
    socket.addEventListener("open", () => {
      this.connectAttempt = 0;
      this.setState("authenticating");
      this.send({
        type: "auth_init",
        role: "mobile",
        device_sid: this.params.deviceSid,
        meta: {
          platform: "mobile-web",
          version: this.params.appVersion,
          name: this.params.deviceName,
        },
        client_ts: Date.now(),
      });
    });
    socket.addEventListener("message", (event) => {
      void this.handleMessage(event.data);
    });
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket) return;
      // bridge 与 socket 同生共死；accessor 里可能还有在途请求，连同 RPC 序号一起作废。
      this.bridgeReadyWorkspaceKey = null;
      this.serviceAccessorInstance = null;
      this.rpcSeq = 0;
      this.rpcAssembler = new WebRemoteControlRpcAssembler();
      this.rpcReplayBuffer.clear();
      this.rpcAckScheduler.clear();
      this.clearAssemblySweepTimer();
      this.failPending(new Error(`mobile connection closed: ${event.code}`));
      if (this.disposed) {
        this.setState("closed", { closeCode: event.code, reason: event.reason });
        return;
      }
      this.scheduleReconnect(event);
    });
    socket.addEventListener("error", () => {
      this.setState("error");
    });
  }

  /** 指数退避 + 抖动重连（上限 30s）；重连后走同一条 auth_init，配对信息不丢。 */
  private scheduleReconnect(event: CloseEvent): void {
    if (this.reconnectTimer !== null) return;
    this.connectAttempt += 1;
    const backoff = Math.min(30_000, 1_000 * 2 ** Math.min(this.connectAttempt - 1, 5));
    const delay = backoff + Math.floor(Math.random() * 1_000);
    // 状态回到 connecting：UI 的「正在自动重连」才与实际行为一致。
    this.setState("connecting", { closeCode: event.code, reason: event.reason });
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.disposed) this.openSocket();
    }, delay);
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearAssemblySweepTimer();
    this.rpcAckScheduler.dispose();
    this.rpcReplayBuffer.clear();
    this.bridgeReadyWorkspaceKey = null;
    this.serviceAccessorInstance = null;
    this.socket?.close();
    this.socket = null;
    this.failPending(new Error("mobile client disposed"));
  }

  getState(): MobileConnectionState {
    return this.state;
  }

  /** 发送应用信封并等待配对响应（bootstrap/workspace-list 等请求-响应模式）。 */
  request(
    payload: WebRemoteControlAppPayload & { requestId: string },
  ): Promise<WebRemoteControlAppPayload> {
    const { requestId } = payload;
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`web remote control request timed out: ${payload.zcode_type}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      this.send({ type: "data", payload });
    });
  }

  /** 发送应用信封（无响应期望，如 mobile-view-state-update）。 */
  sendPayload(payload: WebRemoteControlAppPayload): void {
    this.send({ type: "data", payload });
  }

  /**
   * 桌面 → 手机的 rpc-frame 入口：交给装配器（分片还原 + CRC32 校验），
   * 只有整条消息装配成功才交付并排 ack（ack 语义 = 已连续装配到的逻辑 seq，走批量调度）。
   */
  acceptRpcFrame(frame: WebRemoteControlRpcTransportFrame): void {
    // ack 帧不进装配器：推进重传窗口，并重发仍未确认的帧（幂等）。
    const ack = parseWebRemoteControlRpcAckFrame(frame);
    if (ack) {
      this.emitRpcFrames(this.rpcReplayBuffer.acknowledge(ack.ackSeq));
      return;
    }
    this.handleRpcAssemblyEvents(this.rpcAssembler.push(frame));
  }

  /** 装配事件统一入口：装配成功交上层并排 ack；fault 上报降级。 */
  private handleRpcAssemblyEvents(events: WebRemoteControlRpcAssemblyEvent[]): void {
    for (const event of events) {
      if (event.kind === "message") {
        this.onRpcMessage?.(decodeRpcMessage(event.message));
        // 不逐条立即 ack：交给批量调度，deadline 保证最后一个一定发出。
        this.rpcAckScheduler.record(event.seq);
        continue;
      }
      if (event.kind === "fault") {
        console.warn("[mobile-remote] rpc transport fault", event.reasonCode, event.seq);
        this.events.onPayload?.({
          zcode_type: "bridge-degraded",
          bridgeSessionId: this.rpcStreamId,
          reason: event.reasonCode,
        } as WebRemoteControlAppPayload);
        if (
          event.reasonCode === WEB_REMOTE_CONTROL_RPC_FAULT_REASONS.frameGap ||
          event.reasonCode === WEB_REMOTE_CONTROL_RPC_FAULT_REASONS.bufferTimeout
        ) {
          // 丢片：把「最后连续装配到的 seq」再 ack 一次，对端据此从 ackSeq+1 重传；
          // 不新增 wire 帧类型，仍复用单序号空间的 ack。本方向也按窗口 go-back-N，双向收敛。
          this.rpcAckScheduler.record(this.rpcAssembler.acknowledgedSeq);
          this.emitRpcFrames(this.rpcReplayBuffer.replayUnacknowledged());
        }
      }
    }
  }

  private sendAckFrame(ackSeq: number): void {
    this.send({
      type: "data",
      payload: {
        zcode_type: "rpc-frame",
        frame: { streamId: this.rpcStreamId, seq: ackSeq, kind: "ack", ackSeq },
      },
    });
  }

  /** 按序发出（重传）逻辑帧；socket 非 OPEN 时 `send` 静默丢弃，重连后由同一缓冲重放。 */
  private emitRpcFrames(frames: readonly WebRemoteControlRpcMessageFrame[]): void {
    for (const frame of frames) {
      this.send({ type: "data", payload: { zcode_type: "rpc-frame", frame } });
    }
  }

  /** 装配槽周期清扫：链路静默时残片不会永久占槽。 */
  private ensureAssemblySweepTimer(): void {
    if (this.assemblySweepTimer !== null) return;
    this.assemblySweepTimer = window.setInterval(() => {
      if (this.disposed) return;
      this.handleRpcAssemblyEvents(this.rpcAssembler.sweep());
    }, WEB_REMOTE_CONTROL_RPC_LIMITS.assemblySweepIntervalMs);
  }

  private clearAssemblySweepTimer(): void {
    if (this.assemblySweepTimer !== null) {
      window.clearInterval(this.assemblySweepTimer);
      this.assemblySweepTimer = null;
    }
  }

  /**
   * 打开当前 workspace 的 RPC bridge。
   *
   * 桌面侧 `payloadRouter` 对 `rpc-frame` 只做 `runtime.bridge?.acceptFrame(...)`：bridge 不存在
   * 时帧被静默丢弃，手机端的服务调用会一直挂起。所以用 rpc 服务代理之前必须先握手：
   * 发 `workspace-bridge-open`（桌面按 `workspaceKey` 在窗口运行时里反查目标），等
   * `workspace-bridge-ready` / `workspace-bridge-error`。
   */
  async ensureWorkspaceBridge(params: { workspaceKey: string; taskId?: string }): Promise<void> {
    if (this.bridgeReadyWorkspaceKey === params.workspaceKey) return;
    const requestId = `bridge-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const response = await this.request({
      zcode_type: "workspace-bridge-open",
      requestId,
      workspaceKey: params.workspaceKey,
      ...(params.taskId ? { taskId: params.taskId } : {}),
      bridgeSessionId: this.rpcStreamId,
    } as WebRemoteControlAppPayload & { requestId: string });
    if (response.zcode_type === "workspace-bridge-error") {
      throw new Error(`workspace bridge rejected: ${response.reason}`);
    }
    if (response.zcode_type !== "workspace-bridge-ready") {
      throw new Error(`unexpected workspace bridge response: ${response.zcode_type}`);
    }
    // 桌面每次 openBridge 都会新建 hostBridge（内部装配器从 seq 1 开始），换 workspace 时
    // 我们必须同时重置出站序号、装配器与重传/ack 状态，否则新 bridge 收到 seq>1 会判成 rpc-frame-gap。
    this.rpcSeq = 0;
    this.rpcAssembler = new WebRemoteControlRpcAssembler();
    this.rpcReplayBuffer.clear();
    this.rpcAckScheduler.clear();
    this.bridgeReadyWorkspaceKey = params.workspaceKey;
  }

  /**
   * 把配对 WS 包装成 @zcode/rpc 的 IMessagePassingProtocol（结构化声明，避免浏览器包
   * 直接依赖 @zcode/rpc / @zcode/services），经 @zcode/client 的 connectViaProtocol
   * 拿到与桌面同构的 service 代理。
   *
   * 按实例记忆化：每次调用都新建会把 protocol 的单槽 `onRpcMessage` 覆盖掉，
   * 上一个 accessor 的在途请求再也收不到回复（任务视图每 4s 拉一次，必现）。
   */
  createServiceAccessor(): ReturnType<typeof connectViaProtocol> {
    if (this.serviceAccessorInstance) return this.serviceAccessorInstance;
    this.serviceAccessorInstance = this.buildServiceAccessor();
    return this.serviceAccessorInstance;
  }

  private buildServiceAccessor(): ReturnType<typeof connectViaProtocol> {
    return connectViaProtocol({
      onMessage: (listener) => {
        this.onRpcMessage = (data) => {
          if (data instanceof Uint8Array) {
            listener(VSBuffer.wrap(data));
          }
        };
        return {
          dispose: () => {
            this.onRpcMessage = null;
          },
        };
      },
      send: (buffer) => {
        const seq = this.rpcSeq + 1;
        let frames: WebRemoteControlRpcMessageFrame[];
        try {
          frames = encodeWebRemoteControlRpcFrames(
            encodeRpcMessage(new Uint8Array(buffer.buffer)),
            {
              streamId: this.rpcStreamId,
              seq,
            },
          );
        } catch (error) {
          console.warn("[mobile-remote] rpc message rejected", error);
          return;
        }
        // 入队失败就不发出半条：seq 不推进，对端期望值也不会跳过。
        const recorded = this.rpcReplayBuffer.record(seq, frames);
        if (!recorded.accepted) {
          console.warn("[mobile-remote] rpc replay buffer overflow", recorded.reasonCode);
          return;
        }
        this.rpcSeq = seq;
        this.emitRpcFrames(frames);
      },
    });
  }

  private async handleMessage(raw: unknown): Promise<void> {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(typeof raw === "string" ? raw : String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = frame.type;
    if (type === "auth_challenge") {
      const nonce = String(frame.nonce ?? "");
      const proof = await this.calculateProof(nonce);
      this.send({
        type: "auth_response",
        device_sid: this.params.deviceSid,
        proof,
        client_ts: Date.now(),
      });
      return;
    }
    if (type === "auth_ack" || type === "pair_status_ack") {
      const pairStatus = String(frame.pair_status ?? "");
      this.setState(pairStatus === "matched" ? "paired" : "waiting");
      return;
    }
    if (type === "error") {
      this.setState("error", { reason: String(frame.code ?? "unknown") });
      this.failPending(new Error(String(frame.message ?? frame.code ?? "relay error")));
      return;
    }
    if (type === "data") {
      const payload = frame.payload as WebRemoteControlAppPayload;
      if (payload.zcode_type === "rpc-frame" || payload.zcode_type === "rpc-frame-ack") {
        this.acceptRpcFrame(payload.frame);
        return;
      }
      const requestId = "requestId" in payload ? payload.requestId : undefined;
      const pending = requestId ? this.pending.get(requestId) : undefined;
      if (pending) {
        window.clearTimeout(pending.timer);
        this.pending.delete(requestId as string);
        pending.resolve(payload);
        return;
      }
      this.events.onPayload(payload);
    }
  }

  private async calculateProof(nonce: string): Promise<string> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(this.params.passHash),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(`${nonce}|mobile|${this.params.deviceSid}`),
    );
    return toBase64Url(new Uint8Array(signature));
  }

  private send(frame: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(frame));
    }
  }

  private failPending(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      window.clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(requestId);
    }
  }

  private setState(
    state: MobileConnectionState,
    detail?: { closeCode?: number; reason?: string },
  ): void {
    if (this.state === state) return;
    this.state = state;
    this.events.onStateChange(state, detail);
  }
}

/** 从二维码 URL 解析配对参数。 */
export function readPairingParamsFromLocation(): MobilePairingParams & { wsUrl: string } {
  const params = new URLSearchParams(window.location.search);
  const deviceSid = params.get("sid") ?? "";
  const passHash = params.get("hash") ?? "";
  if (!deviceSid || !passHash) {
    throw new Error("远程控制链接缺少配对参数");
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return {
    deviceSid,
    passHash,
    deviceMid: params.get("mid") ?? undefined,
    deviceName: params.get("name") ?? undefined,
    appVersion: params.get("app_version") ?? undefined,
    wsUrl: `${protocol}//${window.location.host}/ws`,
  };
}
