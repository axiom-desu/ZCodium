/* eslint-disable max-lines -- 手机配对协议客户端：鉴权/信封收发/装配重传都在同一条 WebSocket 生命周期里，拆分会让序号、缓冲与定时器所有者分叉（与 rpcTransport.ts 同一口径）。 */
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { RemoteServiceAccess } from "@zcode/client";
import { ChannelClient, VSBuffer, ProxyChannel } from "@zcode/rpc";
import { IMobileProjectDirectoryService, type MobileProjectRoot } from "@zcode/client";
import { WorkspaceBridgeLifecycle } from "./workspaceBridgeLifecycle.js";
import {
  encodeWebRemoteControlRpcFrames,
  generateTraceId,
  parseWebRemoteControlRpcAckFrame,
  type WebRemoteControlAppPayload,
  WebRemoteControlRpcAckScheduler,
  WebRemoteControlRpcAssembler,
  WebRemoteControlRpcReplayBuffer,
  WEB_REMOTE_CONTROL_RPC_LIMITS,
  type WebRemoteControlRpcAssemblyEvent,
  type WebRemoteControlRpcMessageFrame,
  type WebRemoteControlRpcTransportFrame,
  type ZCodeMessageWithParts,
  type ZCodeStreamEvent,
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

/** `subscribeTaskStream` 参数：`workspaceKey` 供 Host 路由 bridge，路径/身份供 Host 过滤流。 */
export interface TaskStreamParams {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}

/** 事件流订阅句柄；dispose 幂等，socket 已断时 dispose 帧自然丢弃。 */
export interface TaskStreamSubscription {
  dispose(): void;
}

/** 读 task 快照 / 发 prompt 的公共参数（路径与身份由 task 反查传入）。 */
export interface TaskAccessParams {
  workspaceKey: string;
  taskId: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

const NOOP_TASK_STREAM_SUBSCRIPTION: TaskStreamSubscription = { dispose() {} };

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
  private readonly bridge = new WorkspaceBridgeLifecycle(
    () => this.releaseBridge(),
    (target, generation) => this.openWorkspaceBridge(target, generation),
  );
  private channelClient: ChannelClient | null = null;
  /** 当前 socket/bridge 生命周期内的任务事件流订阅；换代际时统一释放。 */
  private taskStreamSubscriptions = new Set<{ generation: number; dispose(): void }>();
  private serviceAccessorInstance: RemoteServiceAccess | null = null;
  private onRpcMessage: ((data: unknown) => void) | null = null;
  private disposed = false;
  private reconnectTimer: number | null = null;
  private connectAttempt = 0;
  private terminalFailure: { reason: string; closeCode?: number } | null = null;
  private endpointErrorCode: string | null = null;

  constructor(
    private readonly params: MobilePairingParams & { wsUrl: string },
    private readonly events: MobileClientEvents,
  ) {}

  connect(): void {
    if (this.terminalFailure) return;
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
    if (this.disposed || this.terminalFailure) return;
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
    if (this.disposed || this.terminalFailure) return;
    const socket = new WebSocket(this.params.wsUrl);
    this.socket = socket;
    this.endpointErrorCode = null;
    this.ensureAssemblySweepTimer();
    socket.addEventListener("open", () => {
      if (this.disposed || this.terminalFailure || this.socket !== socket) return;
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
      if (this.disposed || this.terminalFailure || this.socket !== socket) return;
      void this.handleMessage(event.data, socket);
    });
    socket.addEventListener("close", (event) => {
      if (this.socket !== socket || this.terminalFailure) return;
      // bridge 与 socket 同生共死；accessor 里可能还有在途请求，连同 RPC 序号一起作废。
      this.bridge.invalidate();
      this.clearAssemblySweepTimer();
      this.failPending(new Error(`mobile connection closed: ${event.code}`));
      if (
        event.code === 4002 ||
        event.code === 4003 ||
        (event.code === 4001 && this.endpointErrorCode !== "INTERNAL")
      ) {
        // LAN 的 INTERNAL 也用 4001 关闭；优先保留已收到的临时错误语义，不能误判为失效配对。
        // 其余拒绝/互踢/过期必须终止，自动重试会让旧链接反复抢占配对关系。
        const reason =
          event.code === 4002
            ? "KICKED"
            : event.code === 4003
              ? "AUTH_FAILED"
              : "CONNECTION_REJECTED";
        this.terminate(reason, event.code);
        return;
      }
      if (this.disposed) {
        this.setState("closed", { closeCode: event.code, reason: event.reason });
        return;
      }
      this.scheduleReconnect(event);
    });
    socket.addEventListener("error", () => {
      if (this.disposed || this.terminalFailure || this.socket !== socket) return;
      this.setState("error");
    });
  }

  /** 指数退避 + 抖动重连（上限 30s）；重连后走同一条 auth_init，配对信息不丢。 */
  private scheduleReconnect(event: CloseEvent): void {
    if (this.terminalFailure || this.reconnectTimer !== null) return;
    this.connectAttempt += 1;
    const backoff = Math.min(30_000, 1_000 * 2 ** Math.min(this.connectAttempt - 1, 5));
    const delay = backoff + Math.floor(Math.random() * 1_000);
    // 状态回到 connecting：UI 的「正在自动重连」才与实际行为一致。
    this.setState("connecting", { closeCode: event.code, reason: event.reason });
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.disposed && !this.terminalFailure) this.openSocket();
    }, delay);
  }

  dispose(): void {
    this.disposed = true;
    this.bridge.invalidate();
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearAssemblySweepTimer();
    this.rpcAckScheduler.dispose();
    this.rpcReplayBuffer.clear();
    this.socket?.close();
    this.socket = null;
    this.failPending(new Error("mobile client disposed"));
  }

  /**
   * 换代际：自增 `bridgeGeneration` 并释放当前所有任务流订阅。
   * socket 关闭、客户端 dispose、以及 `ensureWorkspaceBridge` 换 workspace 都走这里，
   * 保证旧订阅回调（迟到事件）无法写进新会话。
   */
  private releaseBridge(): void {
    for (const subscription of this.taskStreamSubscriptions) {
      try {
        subscription.dispose();
      } catch {
        // socket 已断时 EventDispose 帧发不出去，dispose 只回收本地引用，忽略异常。
      }
    }
    this.taskStreamSubscriptions.clear();
    // connectViaProtocol 不暴露 dispose；使用公开 ChannelClient/RemoteServiceAccess，
    // 拒绝旧在途 RPC，不能把已 Initialize 的旧 client 接到新桥。
    this.channelClient?.dispose(new Error("mobile bridge invalidated"));
    this.channelClient = null;
    this.serviceAccessorInstance = null;
    this.onRpcMessage = null;
    this.rpcAssembler = new WebRemoteControlRpcAssembler();
    this.rpcReplayBuffer.clear();
    this.rpcAckScheduler.clear();
  }

  /**
   * 订阅指定 task 的 replayable 事件流。
   *
   * 必须先握手 workspace bridge：`rpc-frame` 只有 bridge 存在时才被 Host 接收，
   * 否则动态事件订阅会挂起。`await` 返回点与回调都做代际 + 作用域校验，
   * 断线/换 workspace 后旧订阅自动失效，由上层重订阅 + 重读快照恢复。
   */
  async subscribeTaskStream(
    params: TaskStreamParams,
    onEvent: (event: ZCodeStreamEvent) => void,
  ): Promise<TaskStreamSubscription> {
    if (this.disposed) return NOOP_TASK_STREAM_SUBSCRIPTION;
    await this.ensureWorkspaceBridge({
      workspaceKey: params.workspaceKey,
      taskId: params.taskId,
    });
    if (this.disposed) return NOOP_TASK_STREAM_SUBSCRIPTION;
    // await 期间可能已断线或切 workspace：bridge 已作废就不订阅。
    if (!this.bridge.isReady(params.workspaceKey)) {
      return NOOP_TASK_STREAM_SUBSCRIPTION;
    }
    const generation = this.bridge.version;
    const { zcodeTaskService } = this.createServiceAccessor(params.workspaceKey);
    const disposable = zcodeTaskService.onDynamicTaskEvent({
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      taskId: params.taskId,
      deliveryKind: "replayable",
    })((event) => {
      if (this.disposed || !this.bridge.isCurrent(generation)) return;
      if (!this.bridge.isReady(params.workspaceKey)) return;
      onEvent(event);
    });
    let active = true;
    const subscription: { generation: number; dispose(): void } = {
      generation,
      dispose: () => {
        if (!active) return;
        active = false;
        disposable.dispose();
        this.taskStreamSubscriptions.delete(subscription);
      },
    };
    this.taskStreamSubscriptions.add(subscription);
    return subscription;
  }

  private readonly directoryEpochs = new WeakMap<
    MobileProjectRoot,
    { generation: number; workspaceKey: string }
  >();

  async readProjectDirectory(workspaceKey: string): Promise<MobileProjectRoot[] | null> {
    await this.ensureWorkspaceBridge({ workspaceKey });
    const generation = this.bridge.version;
    const channel = this.channelClient!;
    const capabilities = await channel.getCapabilities();
    this.bridge.assertCurrent(generation);
    if (!capabilities.mobileProjectDirectory) return null;
    const service = ProxyChannel.toService<IMobileProjectDirectoryService>(
      channel.getChannel(IMobileProjectDirectoryService.channelName),
    );
    const roots = await service.readProjects();
    this.bridge.assertCurrent(generation);
    for (const root of roots) this.directoryEpochs.set(root, { generation, workspaceKey });
    return roots;
  }

  async createProjectTask(root: MobileProjectRoot) {
    const epoch = this.directoryEpochs.get(root);
    if (
      !epoch ||
      !root.enabled ||
      !this.bridge.isCurrent(epoch.generation) ||
      !this.bridge.isReady(epoch.workspaceKey)
    )
      throw new Error("project.stale-attachment");
    const service = ProxyChannel.toService<IMobileProjectDirectoryService>(
      this.channelClient!.getChannel(IMobileProjectDirectoryService.channelName),
    );
    const result = await service.createTask(root);
    this.bridge.assertCurrent(epoch.generation);
    return result;
  }

  /** 读一次 task 权威快照；先握手 bridge，避免服务调用挂起。 */
  async readTaskSnapshot(
    params: TaskAccessParams & { limit?: number },
  ): Promise<ZCodeMessageWithParts[]> {
    await this.ensureWorkspaceBridge({ workspaceKey: params.workspaceKey, taskId: params.taskId });
    const { zcodeSessionService } = this.createServiceAccessor(params.workspaceKey);
    return zcodeSessionService.readSessionMessages({
      sessionId: params.taskId,
      workspacePath: params.workspacePath ?? "",
      workspaceIdentity: params.workspaceIdentity,
      remoteSessionId: params.remoteSessionId,
      limit: params.limit,
    });
  }

  /** 发送一条 prompt；clientMode 固定 `web-remote-replayable`（与桌面 continuous 语义分离）。 */
  async sendTaskPrompt(params: TaskAccessParams & { content: string }): Promise<void> {
    await this.ensureWorkspaceBridge({ workspaceKey: params.workspaceKey, taskId: params.taskId });
    const { zcodeTaskService } = this.createServiceAccessor(params.workspaceKey);
    // workspace 归属由 taskId 反查（task meta 持久化 workspacePath/Identity）；
    // 远端工作区的 session 路由显式带上 remoteSessionId。
    await zcodeTaskService.sendPrompt({
      taskId: params.taskId,
      traceId: generateTraceId(params.taskId),
      content: params.content,
      clientMode: "web-remote-replayable",
      remoteSessionId: params.remoteSessionId,
    });
  }

  getState(): MobileConnectionState {
    return this.state;
  }

  /** 发送应用信封并等待配对响应（bootstrap/workspace-list 等请求-响应模式）。 */
  request(
    payload: WebRemoteControlAppPayload & { requestId: string },
  ): Promise<WebRemoteControlAppPayload> {
    if (this.terminalFailure) {
      return Promise.reject(
        new Error(`mobile connection terminated: ${this.terminalFailure.reason}`),
      );
    }
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
    // Host attach 异步，旧 B 的首次 Initialize 可能晚于 A2 open；首见锁流无法隔离它。
    // 身份只由当前 open 的 bridgeSessionId 决定，message/ack/flow 都先过同一白名单。
    if (!this.channelClient || frame.streamId !== this.rpcStreamId) return;
    // ack 帧不进装配器：前向 ack 的语义是「桌面已连续装配到的 seq」，只推进窗口、释放
    // 已确认前缀；正常流水下 ack 必然滞后于 lastSentSeq（批量合并 + 在途帧），若在此按
    // (ackSeq, lastSentSeq] 重发，每个正常 ack 都会触发一次无意义重传。丢片重传由对端
    // nudge（gap / buffer-timeout）驱动，见 handleRpcAssemblyEvents。
    const ack = parseWebRemoteControlRpcAckFrame(frame);
    if (ack) {
      this.rpcReplayBuffer.acknowledge(ack.ackSeq);
      return;
    }
    this.handleRpcAssemblyEvents(this.rpcAssembler.push(frame));
  }

  /** 装配事件统一入口：装配成功交上层并排 ack；fault 上报降级。 */
  private handleRpcAssemblyEvents(events: WebRemoteControlRpcAssemblyEvent[]): void {
    for (const event of events) {
      if (event.kind === "message") {
        const generation = this.bridge.version;
        this.onRpcMessage?.(decodeRpcMessage(event.message));
        // 回调可能同步切桥；旧消息返回后不能再污染新世代的 ack 调度器。
        if (!this.bridge.isCurrent(generation)) return;
        // 不逐条立即 ack：交给批量调度，deadline 保证最后一个一定发出。
        this.rpcAckScheduler.record(event.seq);
        continue;
      }
      if (event.kind === "fault") {
        this.notifyBridgeDegraded({
          zcode_type: "bridge-degraded",
          bridgeSessionId: this.rpcStreamId,
          reason: event.reasonCode,
        } as WebRemoteControlAppPayload);
        return;
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
    if (this.disposed) throw new Error("mobile client disposed");
    await this.bridge.ensure(params);
    if (!this.bridge.isReady(params.workspaceKey)) throw new Error("workspace bridge superseded");
  }

  private async openWorkspaceBridge(
    params: { workspaceKey: string; taskId?: string },
    generation: number,
  ): Promise<void> {
    // Host Initialize 可能先于 ready 到达；必须先建新 client/装配器，ready 后不能再清 seq。
    this.rpcStreamId = `mobile-${generation}-${Math.random().toString(36).slice(2)}`;
    this.rpcSeq = 0;
    this.rpcAssembler = new WebRemoteControlRpcAssembler({ streamId: this.rpcStreamId });
    this.rpcReplayBuffer.clear();
    this.rpcAckScheduler.clear();
    this.serviceAccessorInstance = this.buildServiceAccessor();
    const requestId = `bridge-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const response = await this.request({
      zcode_type: "workspace-bridge-open",
      requestId,
      workspaceKey: params.workspaceKey,
      ...(params.taskId ? { taskId: params.taskId } : {}),
      bridgeSessionId: this.rpcStreamId,
      bridgeGeneration: generation,
    } as WebRemoteControlAppPayload & { requestId: string });
    this.bridge.assertCurrent(generation);
    if (response.zcode_type === "workspace-bridge-error") {
      throw new Error(`workspace bridge rejected: ${response.reason}`);
    }
    if (response.zcode_type !== "workspace-bridge-ready") {
      throw new Error(`unexpected workspace bridge response: ${response.zcode_type}`);
    }
  }

  /**
   * 从当前就绪桥获取 service 代理；ChannelClient 仅在 open 发出前创建。
   *
   * 按实例记忆化：每次调用都新建会把 protocol 的单槽 `onRpcMessage` 覆盖掉，
   * 上一个 accessor 的在途请求再也收不到回复（快照读取与发送都会调用，必现）。
   */
  private createServiceAccessor(workspaceKey: string): RemoteServiceAccess {
    // await ensure 返回与调用服务之间也可能切桥；不能临时创建 client 或借用其他目标的 accessor。
    if (!this.bridge.isReady(workspaceKey) || !this.serviceAccessorInstance) {
      throw new Error("workspace bridge superseded");
    }
    return this.serviceAccessorInstance;
  }

  private buildServiceAccessor(): RemoteServiceAccess {
    const generation = this.bridge.version;
    this.channelClient = new ChannelClient({
      onMessage: (listener) => {
        const onMessage = (data: unknown) => {
          if (this.bridge.isCurrent(generation) && data instanceof Uint8Array) {
            listener(VSBuffer.wrap(data));
          }
        };
        this.onRpcMessage = onMessage;
        return {
          dispose: () => {
            if (this.onRpcMessage === onMessage) this.onRpcMessage = null;
          },
        };
      },
      send: (buffer) => {
        if (this.disposed || !this.bridge.isCurrent(generation)) return;
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
          this.notifyBridgeDegraded({
            zcode_type: "bridge-degraded",
            bridgeSessionId: this.rpcStreamId,
            reason: error instanceof Error ? error.message : "rpc-transport-fault",
          });
          return;
        }
        // 入队失败就不发出半条：seq 不推进，对端期望值也不会跳过。
        const recorded = this.rpcReplayBuffer.record(seq, frames);
        if (!recorded.accepted) {
          this.notifyBridgeDegraded({
            zcode_type: "bridge-degraded",
            bridgeSessionId: this.rpcStreamId,
            reason: recorded.reasonCode,
          });
          return;
        }
        this.rpcSeq = seq;
        this.emitRpcFrames(frames);
      },
    });
    return new RemoteServiceAccess(this.channelClient);
  }

  private notifyBridgeDegraded(payload: WebRemoteControlAppPayload): void {
    // 降级不只是快照信号：旧 ready/accessor/订阅先失效，再通知视图重开桥。
    this.bridge.invalidate();
    this.events.onPayload(payload);
  }

  private async handleMessage(raw: unknown, socket: WebSocket): Promise<void> {
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
      // 鉴权计算异步完成时可能已断线、终止或重连；旧 challenge 不能再发送 proof。
      if (this.disposed || this.terminalFailure || this.socket !== socket) return;
      this.send({
        type: "auth_response",
        device_sid: this.params.deviceSid,
        proof,
        client_ts: Date.now(),
      });
      return;
    }
    if (type === "auth_ack" || type === "pair_status_ack") {
      const pairStatus = frame.pair_status;
      if (pairStatus !== "matched" && pairStatus !== "waiting") return;
      if (type === "auth_ack") this.connectAttempt = 0;
      this.setState(pairStatus === "matched" ? "paired" : "waiting");
      return;
    }
    if (type === "error") {
      const code = String(frame.code ?? "unknown");
      this.endpointErrorCode = code;
      if (["AUTH_FAILED", "KICKED", "WRONG_PARAM"].includes(code)) {
        this.terminate(code);
      } else {
        this.setState("error", { reason: code });
        this.failPending(new Error(code));
      }
      return;
    }
    if (type === "data") {
      const payload = frame.payload as WebRemoteControlAppPayload;
      if (payload.zcode_type === "rpc-frame" || payload.zcode_type === "rpc-frame-ack") {
        this.acceptRpcFrame(payload.frame);
        return;
      }
      if (payload.zcode_type === "bridge-degraded") {
        if (payload.bridgeSessionId !== this.rpcStreamId) return;
        this.notifyBridgeDegraded(payload);
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

  private calculateProof(nonce: string): string {
    // WebCrypto 在非安全上下文的 LAN HTTP 中没有 subtle；Noble 的纯 JS 实现与 HTTPS
    // 共用同一 UTF-8 HMAC 路径，避免鉴权降级，也正确处理 SHA-256 长 key 预处理。
    const signature = hmac(
      sha256,
      new TextEncoder().encode(this.params.passHash),
      new TextEncoder().encode(`${nonce}|mobile|${this.params.deviceSid}`),
    );
    return toBase64Url(signature);
  }

  private terminate(reason: string, closeCode?: number): void {
    if (this.terminalFailure) return;
    this.terminalFailure = { reason, ...(closeCode === undefined ? {} : { closeCode }) };
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // 终止时释放旧 bridge/RPC 请求；保留客户端终态，禁止 close、迟到帧或外部重试复活。
    this.bridge.invalidate();
    this.clearAssemblySweepTimer();
    this.failPending(new Error(reason));
    const detail = { reason, ...(closeCode === undefined ? {} : { closeCode }) };
    if (this.state === "error") this.events.onStateChange("error", detail);
    else this.setState("error", detail);
    this.socket?.close();
  }

  private send(frame: unknown): void {
    if (!this.terminalFailure && this.socket?.readyState === WebSocket.OPEN) {
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
