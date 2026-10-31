/* eslint-disable max-lines -- 所有 transport 生命周期共享同一个 registry 状态机，必须原子演进。 */
import { createHash } from "node:crypto";
import { resolveServerRemoteEndpoints } from "./serverRemoteConnection.js";
import {
  SOURCE_SERVER_IDENTITY_CHANGE_PENDING_ERROR_CODE,
  buildRemoteWorkspaceIdentity,
  buildServerRemoteWorkspaceIdentity,
  buildSshRemoteHostKey,
  stripRemoteTargetSecrets,
  type RemoteTarget,
  type SourceServerArtifactPolicy,
  type WindowHostAttachmentScope,
  type WindowHostRemoteWorkspaceDescriptor,
  type WorkspacePurpose,
} from "@zcode/shared";

interface WindowRemoteAssetDirs {
  bundledRemoteAssetsDir?: string;
  /** UI 请求的制品策略；Host 仍以 fork 版本/显式 CDN base 为权威。 */
  sourceServerArtifactPolicy?: SourceServerArtifactPolicy;
}

export interface WindowRemoteConnectionCloseEvent {
  exitCode: number | null;
  signal: string | null;
  error?: string;
}

export interface WindowRemoteConnectionHandle<TServices, TCapabilities = never> {
  services: TServices;
  capabilities?: TCapabilities;
  /**
   * Source 身份只能来自已鉴权握手；URL/路径/route 输入不得写入这里。
   * 有值时 registry 会按它做原子 claim，派生 `entriesBySourceServerId` 索引。
   */
  sourceServerId?: string;
  /** 握手声明的 virtualProjects 能力；缺失表示只能走 legacy 单 root 只读适配。 */
  virtualProjects?: boolean;
  /** 握手报告的产品版本；仅用于展示/兼容快照，不参与 identity。 */
  serverVersion?: string;
  /**
   * 本次连接已鉴权证明的临时摘要（由 ingress secret 派生）。
   * 只用于同一入口内 owner claim，不持久化、不进日志/snapshot/identity。
   */
  sourceServerAuthProofDigest?: string;
  /** 本次请求实际复用的在线连接（已脱敏）；只是一次请求事实，不是持久状态。 */
  reusedConnectionTarget?: RemoteTarget;
  dispose(): void | Promise<void>;
  onDidClose?(listener: (event: WindowRemoteConnectionCloseEvent) => void): { dispose(): void };
}

export interface WindowRemoteConnectionConnectRequest {
  target: RemoteTarget;
  remoteAssets: WindowRemoteAssetDirs;
  signal: AbortSignal;
  /** 用户在向导中确认后才会安装/升级；未确认时 connect 必须返回 typed 错误且零上传。 */
  confirmSourceServerInstall?: boolean;
  /** 已确认的 Source 身份；握手得到别的 id 即 identity-change-pending，不自动改路由。 */
  existingSourceServerId?: string;
}

type WindowRemoteConnectionState = "connecting" | "online" | "closing" | "failed" | "disconnected";

interface WindowRemoteLogicalSessionSnapshot {
  remoteSessionId: string;
  requestId: string;
  target: RemoteTarget;
  sourceServerId?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspacePurpose?: WorkspacePurpose;
  generation: number;
  state: WindowRemoteConnectionState;
  sourceAvailability: "online" | "offline";
}

class WindowRemoteSourceIdentityChangedError extends Error {
  public readonly code = SOURCE_SERVER_IDENTITY_CHANGE_PENDING_ERROR_CODE;
  constructor(expected: string, actual: string | undefined) {
    super(
      `Source Server 身份已变化（expected=${expected}, actual=${actual ?? "unknown"}）；不自动把旧会话重发到新 Source`,
    );
    this.name = "WindowRemoteSourceIdentityChangedError";
  }
}

class WindowRemoteConnectCancelledError extends Error {
  constructor() {
    super("远程连接已取消");
    this.name = "WindowRemoteConnectCancelledError";
  }
}

class WindowRemoteConnectionUnavailableError extends Error {
  constructor(remoteSessionId: string) {
    super(`远程连接当前不可用，remoteSessionId=${remoteSessionId}`);
    this.name = "WindowRemoteConnectionUnavailableError";
  }
}

interface ConnectionEntry<TServices, TCapabilities> {
  key: string;
  target: RemoteTarget;
  /** 握手确认后的 Source 身份；也是 entriesBySourceServerId 的索引键。 */
  sourceServerId?: string;
  /** 本次连接的已鉴权证明摘要；仅内存 owner claim 使用。 */
  sourceServerAuthProofDigest?: string;
  state: WindowRemoteConnectionState;
  abortController: AbortController;
  sessions: Set<string>;
  ready: Promise<WindowRemoteConnectionHandle<TServices, TCapabilities>>;
  handle?: WindowRemoteConnectionHandle<TServices, TCapabilities>;
  closeSubscription?: { dispose(): void };
  disposePromise?: Promise<void>;
  disposed: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  idleReason: string;
  workspaceKeys: Set<string>;
  runningTaskCountByWorkspaceKey: Map<string, number>;
  workspaceRuntimeByKey: Map<string, WorkspaceRuntimeState>;
}

interface RemoteWorkspaceContext {
  workspacePath: string;
  workspaceIdentity?: string;
}

interface WorkspaceRuntimeState {
  context: RemoteWorkspaceContext;
  generation: number;
  pendingReleaseGeneration?: number;
  releaseInFlight?: Promise<void>;
}

interface LogicalSession<TServices, TCapabilities> {
  remoteSessionId: string;
  requestId: string;
  target: RemoteTarget;
  sourceServerId?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspacePurpose?: WorkspacePurpose;
  generation: number;
  state: WindowRemoteConnectionState;
  sourceAvailability: "online" | "offline";
  entry: ConnectionEntry<TServices, TCapabilities>;
  workspaceKey?: string;
  workspaceGeneration?: number;
  workspaceReady: Promise<void>;
  workspaceReadyState: "pending" | "ready" | "failed";
  cancelled: boolean;
  rejectCancellation: (error: WindowRemoteConnectCancelledError) => void;
  cancellation: Promise<never>;
}

function normalizeWslSegment(value: string | undefined): string {
  return value?.trim() || "<default>";
}

function buildConnectionKey(target: RemoteTarget, remoteSessionId: string): string {
  switch (target.kind) {
    case "ssh":
      return `ssh:${buildSshRemoteHostKey(target)}`;
    case "wsl":
      return `wsl:${normalizeWslSegment(target.distro)}\0${normalizeWslSegment(target.user)}`;
    case "docker":
      // Docker 保持现有 dedicated logical session 生命周期，不按 target 复用。
      return `${target.kind}:dedicated:${remoteSessionId}`;
    case "server":
      // Bug 原因：host-only 会在鉴权前复用另一 token/base path 的服务。
      // 与真实 connector 共用 endpoint 规范化；摘要仅驻内存，不进 descriptor/日志/持久化。
      return `server:${createHash("sha256")
        .update(
          JSON.stringify([
            resolveServerRemoteEndpoints(target.url).infoUrl,
            target.token?.trim() ?? "",
          ]),
        )
        .digest("hex")}`;
  }
}

function toSessionSnapshot<TServices, TCapabilities>(
  session: LogicalSession<TServices, TCapabilities>,
): WindowRemoteLogicalSessionSnapshot {
  return {
    remoteSessionId: session.remoteSessionId,
    requestId: session.requestId,
    target: stripRemoteTargetSecrets(session.target),
    ...(session.sourceServerId ? { sourceServerId: session.sourceServerId } : {}),
    ...(session.workspacePath ? { workspacePath: session.workspacePath } : {}),
    ...(session.workspaceIdentity ? { workspaceIdentity: session.workspaceIdentity } : {}),
    ...(session.workspacePurpose ? { workspacePurpose: session.workspacePurpose } : {}),
    generation: session.generation,
    state: session.state,
    sourceAvailability: session.sourceAvailability,
  };
}

export function createWindowRemoteConnectionRegistry<TServices, TCapabilities = never>(options: {
  connect: (
    request: WindowRemoteConnectionConnectRequest,
  ) => Promise<WindowRemoteConnectionHandle<TServices, TCapabilities>>;
  createId: () => string;
  onSessionClosed?: (event: WindowRemoteConnectionCloseEvent & { remoteSessionId: string }) => void;
  releaseWorkspace?: (services: TServices, context: RemoteWorkspaceContext) => Promise<void>;
  onWorkspaceReleaseError?: (context: RemoteWorkspaceContext, error: unknown) => void;
  wslIdleTtlMs?: number;
}) {
  const entriesByKey = new Map<string, ConnectionEntry<TServices, TCapabilities>>();
  // 派生索引：sourceServerId → 唯一 owner entry。只由握手 claim 写入，profile/route 不能提供 owner。
  const entriesBySourceServerId = new Map<string, ConnectionEntry<TServices, TCapabilities>>();
  const sessionsById = new Map<string, LogicalSession<TServices, TCapabilities>>();
  const pendingSessionsByRequestId = new Map<string, LogicalSession<TServices, TCapabilities>>();
  let disposed = false;
  let disposePromise: Promise<void> | null = null;
  const wslIdleTtlMs = options.wslIdleTtlMs ?? 60_000;

  function clearIdleTimer(entry: ConnectionEntry<TServices, TCapabilities>): void {
    if (!entry.idleTimer) {
      return;
    }
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }

  function hasRunningTasks(entry: ConnectionEntry<TServices, TCapabilities>): boolean {
    return Array.from(entry.runningTaskCountByWorkspaceKey.values()).some((count) => count > 0);
  }

  function sessionOwnsWorkspace(
    session: LogicalSession<TServices, TCapabilities>,
    entry: ConnectionEntry<TServices, TCapabilities>,
    workspaceKey: string,
  ): boolean {
    return (
      !session.cancelled &&
      session.entry === entry &&
      session.workspaceKey === workspaceKey &&
      sessionsById.get(session.remoteSessionId) === session
    );
  }

  function hasOtherWorkspaceOwner(
    entry: ConnectionEntry<TServices, TCapabilities>,
    workspaceKey: string,
    excludedRemoteSessionId: string,
  ): boolean {
    return Array.from(sessionsById.values()).some(
      (candidate) =>
        candidate.remoteSessionId !== excludedRemoteSessionId &&
        sessionOwnsWorkspace(candidate, entry, workspaceKey),
    );
  }

  function startWorkspaceRelease(
    entry: ConnectionEntry<TServices, TCapabilities>,
    workspaceKey: string,
    state: WorkspaceRuntimeState,
    generation: number,
  ): Promise<void> | undefined {
    if (
      entry.target.kind !== "wsl" ||
      state.generation !== generation ||
      state.releaseInFlight ||
      !entry.handle ||
      entry.state !== "online" ||
      !options.releaseWorkspace
    ) {
      return state.releaseInFlight;
    }
    state.pendingReleaseGeneration = undefined;
    const release = options
      .releaseWorkspace(entry.handle.services, state.context)
      .catch((error) => {
        options.onWorkspaceReleaseError?.(state.context, error);
        throw error;
      })
      .finally(() => {
        if (state.releaseInFlight === release) {
          state.releaseInFlight = undefined;
        }
        if (
          state.generation === generation &&
          !state.pendingReleaseGeneration &&
          !Array.from(sessionsById.values()).some((candidate) =>
            sessionOwnsWorkspace(candidate, entry, workspaceKey),
          )
        ) {
          entry.workspaceRuntimeByKey.delete(workspaceKey);
        }
      });
    // release 由 dispose/running-task 事件触发；失败由结构化回调记录，同时保留 rejecting
    // Promise 给同 workspace 的下一代 acquire，使其 fail-closed 而不是踩过未完成清理。
    void release.catch(() => undefined);
    state.releaseInFlight = release;
    return release;
  }

  function requestWorkspaceRelease(params: {
    entry: ConnectionEntry<TServices, TCapabilities>;
    remoteSessionId: string;
    workspaceKey?: string;
    workspaceGeneration?: number;
  }): Promise<void> | undefined {
    const { entry, workspaceKey, workspaceGeneration } = params;
    if (entry.target.kind !== "wsl" || !workspaceKey || !workspaceGeneration) {
      return undefined;
    }
    if (hasOtherWorkspaceOwner(entry, workspaceKey, params.remoteSessionId)) {
      return undefined;
    }
    const state = entry.workspaceRuntimeByKey.get(workspaceKey);
    if (!state || state.generation !== workspaceGeneration) {
      return undefined;
    }
    if ((entry.runningTaskCountByWorkspaceKey.get(workspaceKey) ?? 0) > 0) {
      state.pendingReleaseGeneration = workspaceGeneration;
      return undefined;
    }
    return startWorkspaceRelease(entry, workspaceKey, state, workspaceGeneration);
  }

  function prepareWorkspaceRuntime(
    session: LogicalSession<TServices, TCapabilities>,
  ): Promise<void> {
    if (session.entry.target.kind !== "wsl" || !session.workspacePath || !session.workspaceKey) {
      session.workspaceReadyState = "ready";
      session.workspaceReady = Promise.resolve();
      return session.workspaceReady;
    }
    const workspaceKey = session.workspaceKey;
    const entry = session.entry;
    const existing = entry.workspaceRuntimeByKey.get(workspaceKey);
    const hasOtherOwner = hasOtherWorkspaceOwner(entry, workspaceKey, session.remoteSessionId);
    const state =
      existing ??
      ({
        context: {
          workspacePath: session.workspacePath,
          ...(session.workspaceIdentity ? { workspaceIdentity: session.workspaceIdentity } : {}),
        },
        generation: 0,
      } satisfies WorkspaceRuntimeState);
    entry.workspaceRuntimeByKey.set(workspaceKey, state);
    state.context = {
      workspacePath: session.workspacePath,
      ...(session.workspaceIdentity ? { workspaceIdentity: session.workspaceIdentity } : {}),
    };
    if (!hasOtherOwner) {
      state.generation += 1;
      // 上一代 release 仍因 running task 等待时，新 logical owner 已重新持有
      // workspace；尚未开始的旧 release 必须失效，不能在 task 归零后误清新 runtime。
    }
    state.pendingReleaseGeneration = undefined;
    session.workspaceGeneration = state.generation;
    session.workspaceReadyState = "pending";
    const releaseToWait = state.releaseInFlight;
    const ready = (releaseToWait ?? Promise.resolve())
      .then(() => {
        if (
          sessionsById.get(session.remoteSessionId) !== session ||
          session.cancelled ||
          entry.workspaceRuntimeByKey.get(workspaceKey)?.generation !== session.workspaceGeneration
        ) {
          throw new WindowRemoteConnectCancelledError();
        }
        session.workspaceReadyState = "ready";
      })
      .catch((error) => {
        session.workspaceReadyState = "failed";
        throw error;
      });
    session.workspaceReady = ready;
    return ready;
  }

  function scheduleWslIdleDispose(
    entry: ConnectionEntry<TServices, TCapabilities>,
    reason: string,
  ): void {
    clearIdleTimer(entry);
    entry.idleReason = reason;
    if (
      entry.target.kind !== "wsl" ||
      entry.disposed ||
      entry.sessions.size > 0 ||
      hasRunningTasks(entry)
    ) {
      return;
    }
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined;
      if (
        entriesByKey.get(entry.key) !== entry ||
        entry.disposed ||
        entry.sessions.size > 0 ||
        hasRunningTasks(entry)
      ) {
        return;
      }
      void disposeEntry(entry);
    }, wslIdleTtlMs);
  }

  async function disposeEntry(entry: ConnectionEntry<TServices, TCapabilities>): Promise<void> {
    if (entry.disposePromise) {
      return entry.disposePromise;
    }
    entry.disposed = true;
    clearIdleTimer(entry);
    entry.state = "closing";
    entry.abortController.abort();
    entry.closeSubscription?.dispose();
    entry.closeSubscription = undefined;
    if (entriesByKey.get(entry.key) === entry) {
      entriesByKey.delete(entry.key);
    }
    releaseSourceOwnerIndex(entry);
    entry.disposePromise = Promise.resolve(entry.handle?.dispose()).then(() => undefined);
    return entry.disposePromise;
  }

  function handleConnectionClosed(
    entry: ConnectionEntry<TServices, TCapabilities>,
    event: WindowRemoteConnectionCloseEvent,
  ): void {
    if (entry.disposed || entry.state === "closing") {
      return;
    }
    entry.state = "disconnected";
    clearIdleTimer(entry);
    if (entriesByKey.get(entry.key) === entry) {
      entriesByKey.delete(entry.key);
    }
    releaseSourceOwnerIndex(entry);
    for (const remoteSessionId of entry.sessions) {
      const session = sessionsById.get(remoteSessionId);
      if (!session) {
        continue;
      }
      session.state = "disconnected";
      session.sourceAvailability = "offline";
      options.onSessionClosed?.({ remoteSessionId, ...event });
    }
  }

  function releaseSourceOwnerIndex(entry: ConnectionEntry<TServices, TCapabilities>): void {
    if (entry.sourceServerId && entriesBySourceServerId.get(entry.sourceServerId) === entry) {
      entriesBySourceServerId.delete(entry.sourceServerId);
    }
  }

  /**
   * 用握手得到的 Source 身份建立索引。claim 是同步原子块：重复 profile 指向同一 Source 时
   * 只有先到者成为 owner，后来者加入既有 owner，绝不产生第二个在线 owner。
   */
  function claimSourceOwner(
    entry: ConnectionEntry<TServices, TCapabilities>,
    sourceServerId: string,
    authProofDigest: string | undefined,
  ): { owner: ConnectionEntry<TServices, TCapabilities>; duplicate: boolean } {
    if (entry.sourceServerId && entry.sourceServerId !== sourceServerId) {
      // 同一物理 entry 在重连后握手返回了不同 Source id：不能静默改写旧会话的授权范围。
      throw new WindowRemoteSourceIdentityChangedError(entry.sourceServerId, sourceServerId);
    }
    const existing = entriesBySourceServerId.get(sourceServerId);
    if (
      existing &&
      existing !== entry &&
      !existing.disposed &&
      existing.abortController.signal.aborted === false &&
      (existing.state === "connecting" || existing.state === "online") &&
      (existing.state === "connecting" || existing.handle)
    ) {
      // Bug 原因：sourceServerId 是可被另一服务自报的普通 id，单独用它 join 会把不同凭据/
      // 未知授权范围折叠成一个 owner，并把旧会话重发到新 authority。只有双方都持有本次
      // 连接派生的临时已鉴权证明且摘要一致时才允许加入；缺失/不一致一律 fail-closed。
      if (
        !authProofDigest ||
        !existing.sourceServerAuthProofDigest ||
        authProofDigest !== existing.sourceServerAuthProofDigest
      ) {
        throw new WindowRemoteSourceIdentityChangedError(
          sourceServerId,
          `${sourceServerId} (authorization proof mismatch)`,
        );
      }
      return { owner: existing, duplicate: true };
    }
    entry.sourceServerId = sourceServerId;
    if (authProofDigest) {
      entry.sourceServerAuthProofDigest = authProofDigest;
    }
    entriesBySourceServerId.set(sourceServerId, entry);
    return { owner: entry, duplicate: false };
  }

  function resolveStableWorkspaceIdentity(
    session: LogicalSession<TServices, TCapabilities>,
    workspacePath: string,
    hint: string | undefined,
  ): string {
    if (!session.sourceServerId) {
      return hint?.trim() || buildRemoteWorkspaceIdentity(workspacePath, session.target);
    }
    const canonical = buildServerRemoteWorkspaceIdentity({
      serverId: session.sourceServerId,
      workspacePath,
    });
    const identity = hint?.trim();
    if (!identity || identity === canonical) {
      // 同目录 rebind 不能把已验证 legacy 主 key 降为 canonical alias，避免历史/执行上下文合并。
      const currentIdentity = session.workspaceIdentity;
      if (
        session.workspacePath === workspacePath &&
        session.entry.handle?.sourceServerAuthProofDigest &&
        session.target.kind !== "server" &&
        currentIdentity === buildRemoteWorkspaceIdentity(workspacePath, session.target)
      )
        return currentIdentity;
      return canonical;
    }
    // Bug 原因：把 legacy 只留 alias 会合并 execution/history，手机 exact scope 必然不一致。
    // 真实握手证明 + 原 transport/authority/path 全等才能保留主 key；未知 hint 不自动迁移。
    if (
      session.entry.handle?.sourceServerAuthProofDigest &&
      session.target.kind !== "server" &&
      identity === buildRemoteWorkspaceIdentity(workspacePath, session.target)
    )
      return identity;
    throw new WindowRemoteSourceIdentityChangedError(identity, session.sourceServerId);
  }

  function applyStableWorkspaceIdentity(session: LogicalSession<TServices, TCapabilities>): void {
    if (!session.workspacePath) return;
    session.workspaceIdentity = resolveStableWorkspaceIdentity(
      session,
      session.workspacePath,
      session.workspaceIdentity,
    );
    session.workspaceKey = session.workspaceIdentity;
    session.entry.workspaceKeys.add(session.workspaceIdentity);
  }

  function createEntry(params: {
    key: string;
    target: RemoteTarget;
    remoteAssets: WindowRemoteAssetDirs;
    confirmSourceServerInstall?: boolean;
    existingSourceServerId?: string;
  }): ConnectionEntry<TServices, TCapabilities> {
    const abortController = new AbortController();
    const entry: ConnectionEntry<TServices, TCapabilities> = {
      key: params.key,
      target: params.target,
      state: "connecting" as const,
      abortController,
      sessions: new Set<string>(),
      ready: Promise.resolve(undefined as never),
      disposed: false,
      idleReason: "wsl-host-idle",
      workspaceKeys: new Set(),
      runningTaskCountByWorkspaceKey: new Map(),
      workspaceRuntimeByKey: new Map(),
    };
    entry.ready = options
      .connect({
        target: params.target,
        remoteAssets: params.remoteAssets,
        signal: abortController.signal,
        ...(params.confirmSourceServerInstall ? { confirmSourceServerInstall: true } : {}),
        ...(params.existingSourceServerId
          ? { existingSourceServerId: params.existingSourceServerId }
          : {}),
      })
      .then(async (handle) => {
        entry.handle = handle;
        if (entry.disposed || entry.sessions.size === 0) {
          // 底层 SSH/WSL connector 可能无法中断认证或部署。
          // 最后一个 logical owner 取消后，迟到的成功结果必须立即释放，不能复活旧连接。
          await disposeEntry(entry);
          return handle;
        }
        entry.state = "online";
        entry.closeSubscription = handle.onDidClose?.((event) => {
          handleConnectionClosed(entry, event);
        });
        for (const remoteSessionId of entry.sessions) {
          const session = sessionsById.get(remoteSessionId);
          if (!session || session.cancelled) {
            continue;
          }
          session.state = "online";
          session.sourceAvailability = "online";
        }
        return handle;
      })
      .catch((error) => {
        entry.state = "failed";
        if (entriesByKey.get(entry.key) === entry) {
          entriesByKey.delete(entry.key);
        }
        for (const remoteSessionId of Array.from(entry.sessions)) {
          const session = sessionsById.get(remoteSessionId);
          if (!session) {
            continue;
          }
          session.state = "failed";
          session.sourceAvailability = "offline";
          sessionsById.delete(remoteSessionId);
          pendingSessionsByRequestId.delete(session.requestId);
        }
        entry.sessions.clear();
        throw error;
      });
    entriesByKey.set(entry.key, entry);
    return entry;
  }

  function resolveEntry(params: {
    key: string;
    target: RemoteTarget;
    remoteAssets: WindowRemoteAssetDirs;
    confirmSourceServerInstall?: boolean;
    existingSourceServerId?: string;
  }): ConnectionEntry<TServices, TCapabilities> {
    const existing = entriesByKey.get(params.key);
    if (
      existing &&
      !existing.disposed &&
      !existing.abortController.signal.aborted &&
      (existing.state === "connecting" || existing.state === "online")
    ) {
      clearIdleTimer(existing);
      return existing;
    }
    return createEntry(params);
  }

  async function connect(params: {
    requestId: string;
    target: RemoteTarget;
    remoteAssets: WindowRemoteAssetDirs;
    workspacePath?: string;
    workspaceIdentity?: string;
    workspacePurpose?: WorkspacePurpose;
    confirmSourceServerInstall?: boolean;
    existingSourceServerId?: string;
  }): Promise<WindowHostRemoteWorkspaceDescriptor> {
    if (disposed) {
      throw new Error("窗口 Host 的远程连接 registry 已释放");
    }
    if (pendingSessionsByRequestId.has(params.requestId)) {
      throw new Error(`远程连接 requestId 重复，requestId=${params.requestId}`);
    }

    const remoteSessionId = options.createId();
    const key = buildConnectionKey(params.target, remoteSessionId);
    const entry = resolveEntry({
      key,
      target: params.target,
      remoteAssets: params.remoteAssets,
      ...(params.confirmSourceServerInstall ? { confirmSourceServerInstall: true } : {}),
      ...(params.existingSourceServerId
        ? { existingSourceServerId: params.existingSourceServerId }
        : {}),
    });
    let rejectCancellation!: (error: WindowRemoteConnectCancelledError) => void;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const session: LogicalSession<TServices, TCapabilities> = {
      remoteSessionId,
      requestId: params.requestId,
      target: params.target,
      ...(params.workspacePath ? { workspacePath: params.workspacePath } : {}),
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
      ...(params.workspacePurpose ? { workspacePurpose: params.workspacePurpose } : {}),
      generation: 1,
      state: entry.state === "online" ? "online" : "connecting",
      sourceAvailability: entry.state === "online" ? "online" : "offline",
      entry,
      workspaceReady: Promise.resolve(),
      workspaceReadyState: "pending",
      cancelled: false,
      rejectCancellation,
      cancellation,
    };
    entry.sessions.add(remoteSessionId);
    const initialWorkspaceKey = params.workspaceIdentity?.trim() || params.workspacePath;
    if (initialWorkspaceKey) {
      entry.workspaceKeys.add(initialWorkspaceKey);
      session.workspaceKey = initialWorkspaceKey;
    }
    sessionsById.set(remoteSessionId, session);
    pendingSessionsByRequestId.set(params.requestId, session);

    let reusedConnectionTarget: RemoteTarget | undefined;
    try {
      await Promise.race([entry.ready, cancellation]);
      const handle = entry.handle;
      if (!handle) {
        throw new WindowRemoteConnectCancelledError();
      }
      const handshakeSourceId = handle.sourceServerId?.trim() || undefined;
      const handshakeAuthProof = handle.sourceServerAuthProofDigest?.trim() || undefined;
      if (params.target.kind === "server" && !handshakeSourceId) {
        // 直连请求即使自带旧 hint/serverId，也不能替缺少身份的握手发布 scope 或凭据 slot。
        throw new WindowRemoteSourceIdentityChangedError("authenticated Source id", undefined);
      }
      if (params.existingSourceServerId && handshakeSourceId !== params.existingSourceServerId) {
        // 不能把已确认的旧 Source 地址当成新 Source 使用：显式 typed pending，由上层重新确认。
        throw new WindowRemoteSourceIdentityChangedError(
          params.existingSourceServerId,
          handshakeSourceId,
        );
      }
      let duplicateOwner: ConnectionEntry<TServices, TCapabilities> | undefined;
      if (handshakeSourceId) {
        const claim = claimSourceOwner(entry, handshakeSourceId, handshakeAuthProof);
        if (claim.duplicate) {
          // 同一 Source 的重复 profile：加入既有 owner，绝不出现两个在线 owner。
          if (sessionsById.get(remoteSessionId) !== session || session.cancelled) {
            throw new WindowRemoteConnectCancelledError();
          }
          entry.sessions.delete(remoteSessionId);
          claim.owner.sessions.add(remoteSessionId);
          session.entry = claim.owner;
          session.generation += 1;
          duplicateOwner = claim.owner;
          reusedConnectionTarget = stripRemoteTargetSecrets(params.target);
        }
        session.sourceServerId = handshakeSourceId;
      }
      if (duplicateOwner) {
        // 加入一个仍在 connecting 的 owner 时，必须等它真正上线再返回 descriptor；
        // owner 失败会沿这里向上抛出，不会留下已发布的假在线 session。
        await Promise.race([duplicateOwner.ready, cancellation]);
        if (entry.sessions.size === 0) {
          await disposeEntry(entry);
        }
      }
      applyStableWorkspaceIdentity(session);
      await Promise.race([prepareWorkspaceRuntime(session), cancellation]);
      if (session.cancelled || !sessionsById.has(remoteSessionId)) {
        throw new WindowRemoteConnectCancelledError();
      }
      session.state = "online";
      session.sourceAvailability = "online";
      // descriptor 的 Source 目标由握手结果固定：renderer 传入的 serverId 只是展示/旧 hint，
      // 不能覆盖已鉴权 serverInfo.serverId。Main/UI 都按这个 descriptor 转发与建身份。
      const descriptorTarget = stripRemoteTargetSecrets(params.target);
      const authoritativeTarget =
        session.sourceServerId && descriptorTarget.kind === "server"
          ? { ...descriptorTarget, serverId: session.sourceServerId }
          : descriptorTarget;
      session.target = authoritativeTarget;
      return {
        remoteSessionId,
        target: authoritativeTarget,
        ...(session.sourceServerId ? { sourceServerId: session.sourceServerId } : {}),
        ...(session.workspacePath ? { workspacePath: session.workspacePath } : {}),
        ...(session.workspaceIdentity ? { workspaceIdentity: session.workspaceIdentity } : {}),
        ...(session.workspacePurpose ? { workspacePurpose: session.workspacePurpose } : {}),
        ...(reusedConnectionTarget ? { reusedConnectionTarget } : {}),
        generation: session.generation,
      };
    } catch (error) {
      if (sessionsById.get(remoteSessionId) === session) {
        sessionsById.delete(remoteSessionId);
        session.entry.sessions.delete(remoteSessionId);
        session.state = "failed";
        session.sourceAvailability = "offline";
        const owner = session.entry;
        if (
          owner.sessions.size === 0 &&
          (owner.target.kind === "docker" || owner.target.kind === "server")
        ) {
          await disposeEntry(owner);
        }
      }
      throw error;
    } finally {
      if (pendingSessionsByRequestId.get(params.requestId) === session) {
        pendingSessionsByRequestId.delete(params.requestId);
      }
    }
  }

  function cancelConnect(requestId: string): void {
    const session = pendingSessionsByRequestId.get(requestId);
    if (!session || session.cancelled) {
      return;
    }
    session.cancelled = true;
    pendingSessionsByRequestId.delete(requestId);
    sessionsById.delete(session.remoteSessionId);
    session.entry.sessions.delete(session.remoteSessionId);
    const workspaceRelease = requestWorkspaceRelease({
      entry: session.entry,
      remoteSessionId: session.remoteSessionId,
      workspaceKey: session.workspaceKey,
      workspaceGeneration: session.workspaceGeneration,
    });
    void workspaceRelease?.catch(() => undefined);
    session.rejectCancellation(new WindowRemoteConnectCancelledError());
    if (session.entry.sessions.size === 0) {
      if (session.entry.target.kind === "ssh" && session.entry.state === "connecting") {
        // 最后一个 waiter 取消后，旧 entry 仍以 connecting 留在复用表；立即重连会
        // 继续等待已经 aborted 的 readiness，并沿用上一次凭据。先按对象身份退休旧 entry，
        // 再触发底层取消；迟到的旧 completion 不能删除或复活同 key 的新连接。
        if (entriesByKey.get(session.entry.key) === session.entry) {
          entriesByKey.delete(session.entry.key);
        }
        session.entry.state = "closing";
        session.entry.abortController.abort();
      } else if (session.entry.target.kind === "wsl" && session.entry.state === "online") {
        scheduleWslIdleDispose(session.entry, "cancelled-logical-connect");
      } else if (session.entry.target.kind === "ssh" && session.entry.state === "online") {
        // ready SSH connection 是窗口 cache；取消一次 logical attach 不应把后续 workspace 的
        // 复用连接一并销毁，真实窗口 Host shutdown 时统一释放。
        clearIdleTimer(session.entry);
      } else if (session.entry.handle) {
        void disposeEntry(session.entry);
      }
    }
  }

  function bindWorkspaceContext(params: {
    remoteSessionId: string;
    workspacePath: string;
    workspaceIdentity: string;
    workspacePurpose?: WorkspacePurpose;
    legacyRouteHint?: string;
  }): Promise<void> {
    const session = sessionsById.get(params.remoteSessionId);
    if (!session) {
      throw new Error(`未找到远程 logical session，remoteSessionId=${params.remoteSessionId}`);
    }
    const previousOwnership = {
      entry: session.entry,
      remoteSessionId: session.remoteSessionId,
      workspaceKey: session.workspaceKey,
      workspaceGeneration: session.workspaceGeneration,
    };
    // 先验证再写状态：失败的 hint 不得留下半更新的 descriptor/execution scope。
    const workspaceIdentity = resolveStableWorkspaceIdentity(
      session,
      params.workspacePath,
      params.legacyRouteHint?.trim() || params.workspaceIdentity,
    );
    session.workspacePath = params.workspacePath;
    session.workspaceIdentity = workspaceIdentity;
    if (params.workspacePurpose) {
      session.workspacePurpose = params.workspacePurpose;
    }
    session.generation += 1;
    session.workspaceKey = session.workspaceIdentity?.trim() || params.workspacePath;
    session.entry.workspaceKeys.add(session.workspaceKey);
    const ready = prepareWorkspaceRuntime(session);
    if (previousOwnership.workspaceKey !== session.workspaceKey) {
      const release = requestWorkspaceRelease(previousOwnership);
      void release?.catch(() => undefined);
    }
    return ready;
  }

  function resolveScopedHandle(
    scope: WindowHostAttachmentScope,
  ): WindowRemoteConnectionHandle<TServices, TCapabilities> {
    if (scope.kind !== "remote") {
      throw new Error("远程连接 registry 不能解析 local attachment scope");
    }
    const session = sessionsById.get(scope.remoteSessionId);
    if (!session) {
      throw new WindowRemoteConnectionUnavailableError(scope.remoteSessionId);
    }
    if (
      scope.kind === "remote" &&
      scope.sourceServerId &&
      session.sourceServerId !== scope.sourceServerId
    ) {
      throw new WindowRemoteConnectionUnavailableError(scope.remoteSessionId);
    }
    const identityMatches = session.workspaceIdentity === scope.workspaceIdentity;
    if (session.workspacePath !== scope.workspacePath || !identityMatches) {
      throw new Error(
        `远程 attachment scope 与 logical session 不匹配，remoteSessionId=${scope.remoteSessionId}`,
      );
    }
    if (
      session.state !== "online" ||
      session.sourceAvailability !== "online" ||
      session.workspaceReadyState !== "ready" ||
      !session.entry.handle
    ) {
      throw new WindowRemoteConnectionUnavailableError(scope.remoteSessionId);
    }
    return session.entry.handle;
  }

  function resolveScopedServices(scope: WindowHostAttachmentScope): TServices {
    return resolveScopedHandle(scope).services;
  }

  function resolveScopedCapabilities(scope: WindowHostAttachmentScope): TCapabilities | undefined {
    return resolveScopedHandle(scope).capabilities;
  }

  async function disposeSession(remoteSessionId: string): Promise<void> {
    const session = sessionsById.get(remoteSessionId);
    if (!session) {
      return;
    }
    sessionsById.delete(remoteSessionId);
    pendingSessionsByRequestId.delete(session.requestId);
    session.entry.sessions.delete(remoteSessionId);
    const workspaceRelease = requestWorkspaceRelease({
      entry: session.entry,
      remoteSessionId,
      workspaceKey: session.workspaceKey,
      workspaceGeneration: session.workspaceGeneration,
    });
    if (session.entry.sessions.size === 0) {
      if (session.entry.target.kind === "wsl" && session.entry.state === "online") {
        scheduleWslIdleDispose(session.entry, "last-logical-session-disposed");
      } else if (session.entry.target.kind === "ssh" && session.entry.state === "online") {
        // 只迁移 SSH pool 的 owner：ready connection 继续保持 window-scoped cache，
        // logical session 清空不等于连接退出；真实窗口 Host shutdown 时统一释放。
        clearIdleTimer(session.entry);
      } else {
        await disposeEntry(session.entry);
      }
    }
    await workspaceRelease?.catch(() => undefined);
  }

  return {
    connect,
    cancelConnect,
    bindWorkspaceContext,
    resolveScopedServices,
    resolveScopedCapabilities,
    getSession(remoteSessionId: string): WindowRemoteLogicalSessionSnapshot | null {
      const session = sessionsById.get(remoteSessionId);
      return session ? toSessionSnapshot(session) : null;
    },
    listSessions(): WindowRemoteLogicalSessionSnapshot[] {
      return Array.from(sessionsById.values(), toSessionSnapshot);
    },
    findSessionForWorkspace(params: {
      workspacePath: string;
      workspaceIdentity?: string;
    }): WindowRemoteLogicalSessionSnapshot | null {
      // 只查 actual 主 key；canonical 新 context 不得反查到同路径的多个旧 legacy 上下文。
      const matches = Array.from(sessionsById.values()).filter(
        (session) =>
          session.workspacePath === params.workspacePath &&
          session.workspaceIdentity === params.workspaceIdentity,
      );
      const onlineMatches = matches.filter(
        (session) => session.state === "online" && session.sourceAvailability === "online",
      );
      if (onlineMatches.length > 1 || (onlineMatches.length === 0 && matches.length > 1)) {
        throw new Error(
          `远程 workspace scope 匹配到多个 logical session，workspacePath=${params.workspacePath}`,
        );
      }
      const match = onlineMatches[0] ?? matches[0];
      return match ? toSessionSnapshot(match) : null;
    },
    getStats(): {
      connectionCount: number;
      logicalSessionCount: number;
      sourceCount: number;
    } {
      return {
        connectionCount: entriesByKey.size,
        logicalSessionCount: sessionsById.size,
        sourceCount: entriesBySourceServerId.size,
      };
    },
    /**
     * 已在线 Source 的只读枚举（每个 Source 一个 owner）。
     * 用于把桌面侧的 app 级选择推给现有 attachment；不创建、不重建任何连接。
     */
    listOnlineSources(): Array<{ sourceServerId: string; services: TServices }> {
      const online: Array<{ sourceServerId: string; services: TServices }> = [];
      for (const [sourceServerId, entry] of entriesBySourceServerId) {
        if (entry.disposed || entry.state !== "online" || !entry.handle) continue;
        online.push({ sourceServerId, services: entry.handle.services });
      }
      return online;
    },
    /**
     * 只解析已在线 Source 的既有 owner；缺失即 undefined。调用方（项目树、Source 设置）
     * 不能据此创建第二个 Host/Agent。
     */
    getOnlineSource(sourceServerId: string): {
      sourceServerId: string;
      services: TServices;
      virtualProjects: boolean;
      serverVersion?: string;
      capabilities?: TCapabilities;
    } | null {
      const onlineEntry = entriesBySourceServerId.get(sourceServerId);
      if (
        !onlineEntry ||
        onlineEntry.disposed ||
        onlineEntry.state !== "online" ||
        !onlineEntry.handle
      ) {
        return null;
      }
      return {
        sourceServerId,
        services: onlineEntry.handle.services,
        virtualProjects: onlineEntry.handle.virtualProjects === true,
        ...(onlineEntry.handle.serverVersion
          ? { serverVersion: onlineEntry.handle.serverVersion }
          : {}),
        ...(onlineEntry.handle.capabilities
          ? { capabilities: onlineEntry.handle.capabilities }
          : {}),
      };
    },
    /** 管理入口断开 Source：只释放该 owner 及其 logical session，不触碰其他 Source。 */
    async disposeSource(sourceServerId: string): Promise<void> {
      const entry = entriesBySourceServerId.get(sourceServerId);
      if (!entry) {
        return;
      }
      for (const session of Array.from(sessionsById.values())) {
        if (session.entry !== entry) {
          continue;
        }
        sessionsById.delete(session.remoteSessionId);
        pendingSessionsByRequestId.delete(session.requestId);
        session.cancelled = true;
        session.state = "closing";
        session.sourceAvailability = "offline";
        session.rejectCancellation(new WindowRemoteConnectCancelledError());
      }
      entry.sessions.clear();
      await disposeEntry(entry);
    },
    resolveSourceScopedServices(sourceServerId: string): TServices {
      const online = entriesBySourceServerId.get(sourceServerId);
      if (!online || online.disposed || online.state !== "online" || !online.handle) {
        throw new WindowRemoteConnectionUnavailableError(sourceServerId);
      }
      return online.handle.services;
    },
    setWorkspaceRunningTaskCount(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      runningTaskCount: number;
    }): void {
      const workspaceKey = params.workspaceIdentity?.trim() || params.workspacePath;
      for (const entry of entriesByKey.values()) {
        if (entry.target.kind !== "wsl" || !entry.workspaceKeys.has(workspaceKey)) {
          continue;
        }
        if (params.runningTaskCount > 0) {
          entry.runningTaskCountByWorkspaceKey.set(workspaceKey, params.runningTaskCount);
          clearIdleTimer(entry);
        } else {
          entry.runningTaskCountByWorkspaceKey.delete(workspaceKey);
          const state = entry.workspaceRuntimeByKey.get(workspaceKey);
          if (state?.pendingReleaseGeneration) {
            void startWorkspaceRelease(
              entry,
              workspaceKey,
              state,
              state.pendingReleaseGeneration,
            )?.catch(() => undefined);
          }
          scheduleWslIdleDispose(entry, entry.idleReason);
        }
      }
    },
    async waitForScopedServices(scope: WindowHostAttachmentScope): Promise<TServices> {
      if (scope.kind !== "remote") {
        throw new Error("远程连接 registry 不能解析 local attachment scope");
      }
      const session = sessionsById.get(scope.remoteSessionId);
      if (!session) {
        throw new WindowRemoteConnectionUnavailableError(scope.remoteSessionId);
      }
      await session.workspaceReady;
      return resolveScopedServices(scope);
    },
    disposeSession,
    async dispose(): Promise<void> {
      if (disposePromise) {
        return disposePromise;
      }
      disposed = true;
      for (const requestId of Array.from(pendingSessionsByRequestId.keys())) {
        cancelConnect(requestId);
      }
      const entries = new Set(Array.from(sessionsById.values(), (session) => session.entry));
      for (const entry of entriesByKey.values()) {
        entries.add(entry);
      }
      sessionsById.clear();
      pendingSessionsByRequestId.clear();
      disposePromise = Promise.all(Array.from(entries, disposeEntry)).then(() => undefined);
      return disposePromise;
    },
  };
}
