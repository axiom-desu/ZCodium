import type { SessionEvent } from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import type {
  SessionsIndexTopicFrame,
  WorkspaceConfigState,
  WorkspaceConfigTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import {
  parseSessionsIndexTopic,
  parseWorkspaceConfigTopic,
  v4ConversationSubscribeParamsSchema,
} from "@zcode/shared/zcode-protocol-v4";
import { SessionsIndexPublisher } from "./sessions-index-publisher.js";
import { WorkspaceConfigPublisher } from "./workspace-config-publisher.js";
import type { GatewayState } from "./v4-gateway-state.js";
import type { V4SubscribeDispatchResult } from "./v4-gateway-contract.js";

/** 本域实际使用的根状态窄面。 */
type IndexconfigDomainState = Pick<
  GatewayState,
  | "configPublishers"
  | "controlReservations"
  | "createLogEpoch"
  | "disposed"
  | "flushStates"
  | "host"
  | "indexFanoutThrottle"
  | "indexPublishers"
  | "localTtft"
  | "now"
  | "pausedConnections"
  | "publishers"
>;
import * as flush from "./v4-gateway-flush.js";

/**
 * 把某会话的最新摘要推进到其 workspace 的 sessions-index publisher，并 flush 给列表订阅者。
 * projection 必须在无列表订阅者时也继续推进，保证下一次 snapshot 读取权威当前态；
 * 高频流式增量（ModelStreaming）不触发列表重算，避免抖动（预览在 turn 收口/其他事件时更新）。
 * 旧宿主无 getSessionWorkspaceId → 整体 no-op。
 */
export function fanOutToIndex(
  ctx: IndexconfigDomainState,
  sessionId: string,
  event: SessionEvent,
): void {
  if (event.type === SessionEventType.ModelStreaming) return;
  // 工作流进度同样是高频流（实测 8s 4000 条），但列表要继续动，所以不是丢弃而是
  // leading + trailing 窗口节流：窗内合并为窗末一帧，终态仍在一个窗口内送达。
  if (event.type === SessionEventType.DynamicWorkflowRunProgress) {
    ctx.indexFanoutThrottle.request(sessionId);
    return;
  }
  publishCurrentSummaryToIndex(ctx, sessionId);
}

/**
 * 把当前完整 projection 发布到 sessions-index。
 *
 * fork child 的 resume 会先用少量 live event 建出暂态 draft publisher，
 * 随后的 synthesized hydration 才补齐继承历史。只在 ingest(event) 时 fan-out 的话，
 * hydration 完成后若没有下一条 runtime event，child 就永远停在 draft 基线，
 * task-index syncer 无法观察到 draft→visible，也就不会创建侧栏 task row。
 */
export function publishCurrentSummaryToIndex(ctx: IndexconfigDomainState, sessionId: string): void {
  // 这一次发布带的就是窗内合并后的当前摘要：待发的 trailing 到此被满足，不重复发帧。
  ctx.indexFanoutThrottle.notePublished(sessionId);
  const getWorkspaceId = ctx.host.getSessionWorkspaceId;
  if (!getWorkspaceId) return;
  try {
    const workspaceId = getWorkspaceId.call(ctx.host, sessionId);
    if (!workspaceId) return;
    if (ctx.host.isDraftSession?.(sessionId)) return;
    const indexPublisher = ctx.indexPublishers.get(workspaceId);
    if (!indexPublisher) return;
    const conversationPublisher = ctx.publishers.get(sessionId);
    if (!conversationPublisher) return;
    const changed = indexPublisher.ingestConversation(
      conversationPublisher.getSnapshot(),
      resolveIndexMeta(ctx, sessionId),
    );
    if (changed) flushIndex(ctx, workspaceId);
  } catch (error) {
    ctx.host.onError?.("v4.sessionsIndex.ingest", error);
  }
}

/** 会话列表元信息（宿主 hook 缺省时的兜底：createdAt=0，lastActivityAt=now）。 */
function resolveIndexMeta(
  ctx: IndexconfigDomainState,
  sessionId: string,
): {
  createdAt: number;
  lastActivityAt: number;
  parentSessionId?: string;
} {
  const meta = ctx.host.getSessionIndexMeta?.(sessionId);
  return {
    createdAt: meta?.createdAt ?? 0,
    lastActivityAt: meta?.lastActivityAt ?? ctx.now(),
    ...(meta?.parentSessionId ? { parentSessionId: meta.parentSessionId } : {}),
  };
}

/** 把某 workspace index publisher 的未发增量帧推给所有列表订阅者。 */
export function flushIndex(
  ctx: IndexconfigDomainState,
  workspaceId: string,
  onlyConnectionId?: string,
): void {
  const publisher = ctx.indexPublishers.get(workspaceId);
  if (!publisher) return;
  for (const subscriptionId of publisher.subscriptionIds()) {
    const connectionId = publisher.connectionIdForSubscription(subscriptionId);
    if (
      connectionId === null ||
      ctx.pausedConnections.has(connectionId) ||
      (onlyConnectionId !== undefined && connectionId !== onlyConnectionId)
    ) {
      continue;
    }
    const reservation = publisher.reserveFlush(subscriptionId);
    if (!reservation) continue;
    try {
      flush.emitReservation(ctx, reservation);
    } catch (error) {
      ctx.host.onError?.("v4.sessionsIndex.emit", error);
    }
  }
}

/**
 * sessions-index 订阅：订阅某 workspace 的会话列表（与 conversation subscribe 并列，
 * 同一 RPC 方法按 topic 前缀分派）。冷启动：store 摘要种子 + 已加载会话 live 投影覆盖。
 */
export async function subscribeSessionsIndex(
  ctx: IndexconfigDomainState,
  rawParams: unknown,
): Promise<V4SubscribeDispatchResult<SessionsIndexTopicFrame>> {
  const dispatch = await subscribeSessionsIndexReserved(ctx, rawParams);
  dispatch.commit();
  return dispatch;
}

export async function subscribeSessionsIndexReserved(
  ctx: IndexconfigDomainState,
  rawParams: unknown,
): Promise<V4SubscribeDispatchResult<SessionsIndexTopicFrame>> {
  const params = v4ConversationSubscribeParamsSchema.parse(rawParams);
  const workspaceId = parseSessionsIndexTopic(params.topic);
  if (workspaceId === null) {
    throw new Error(`Not a sessions-index topic: ${params.topic}`);
  }
  const publisher = await ensureIndexPublisher(ctx, workspaceId, params.legacyTaskIds);
  // ensure 内部可能跨异步 store/claim；dispose 发生在 await 返回前时禁止继续登记订阅。
  ctx.indexPublishers.ensureActive();
  const result = publisher.subscribeReserved(params.connectionId, params.base);
  try {
    return flush.subscribeDispatch(
      ctx,
      {
        subscriptionId: result.subscriptionId,
        mode: result.mode,
        logEpoch: publisher.logEpoch,
      },
      result.reservation,
      () => flushIndex(ctx, workspaceId),
    );
  } catch (error) {
    // initial logical frame 在 physical encode 阶段即可因 16MiB 上限失败；
    // 已登记订阅/in-flight reservation 后失败必须 rollback，否则会留下永远无法退订的幽灵 owner。
    result.rollback();
    throw error;
  }
}

/** 建/取某 workspace 的 index publisher；建时 store 摘要种子 + live 投影覆盖。 */
async function ensureIndexPublisher(
  ctx: IndexconfigDomainState,
  workspaceId: string,
  legacyTaskIds?: readonly string[],
): Promise<SessionsIndexPublisher> {
  const existing = ctx.indexPublishers.get(workspaceId);
  const shouldRefreshLegacy =
    Boolean(legacyTaskIds?.length) && Boolean(ctx.host.refreshLegacySessionSummaries);
  if (existing && !shouldRefreshLegacy) return existing;

  return ctx.indexPublishers.runExclusive(workspaceId, () =>
    ensureIndexPublisherExclusive(ctx, workspaceId, legacyTaskIds),
  );
}

/** 同 workspace 串行区：可重试 claim/重读与 publisher 构造必须观察同一份最终快照。 */
async function ensureIndexPublisherExclusive(
  ctx: IndexconfigDomainState,
  workspaceId: string,
  legacyTaskIds?: readonly string[],
): Promise<SessionsIndexPublisher> {
  const refreshed =
    legacyTaskIds && legacyTaskIds.length > 0
      ? ((await ctx.host.refreshLegacySessionSummaries?.(workspaceId, legacyTaskIds)) ?? null)
      : null;
  const existing = ctx.indexPublishers.get(workspaceId);
  if (existing) {
    // claim 不能绑定到首次构造：空种子一旦进 Map 就永久挡住重试。
    // 重读只补缺失项，避免冷存储默认态覆盖已有 live projection。
    if (refreshed && existing.mergeMissingStoredSummaries(refreshed)) {
      flushIndex(ctx, workspaceId);
    }
    return existing;
  }
  const publisher = new SessionsIndexPublisher(
    workspaceId,
    ctx.createLogEpoch(`sessions-index/${workspaceId}`),
    ctx.now,
  );
  // 种子 1：store 里全部会话的轻量摘要（未加载的靠它进列表）。
  const stored = refreshed ?? (await ctx.host.getStoredSessionSummaries?.(workspaceId)) ?? [];
  for (const summary of stored) publisher.seed(summary);
  // 种子 2：已加载会话用 live 投影覆盖（更准的 phase/preview/backgroundWork）。
  const liveIds = ctx.host.listWorkspaceSessionIds?.(workspaceId) ?? [...ctx.publishers.keys()];
  for (const sessionId of liveIds) {
    const conversationPublisher = ctx.publishers.get(sessionId);
    if (!conversationPublisher) continue;
    // draft（deferred 未发首条）不进冷启动种子，与 fanOutToIndex 的过滤一致。
    if (ctx.host.isDraftSession?.(sessionId)) continue;
    publisher.ingestConversation(
      conversationPublisher.getSnapshot(),
      resolveIndexMeta(ctx, sessionId),
    );
  }
  ctx.indexPublishers.set(workspaceId, publisher);
  return publisher;
}

/**
 * workspace-config 订阅：订阅某 workspace 的配置目录（与 conversation subscribe 并列，
 * 同一 RPC 方法按 topic 前缀分派）。订阅时经宿主钩子拉取当前配置作种子。
 */
export async function subscribeWorkspaceConfig(
  ctx: IndexconfigDomainState,
  rawParams: unknown,
): Promise<V4SubscribeDispatchResult<WorkspaceConfigTopicFrame>> {
  const dispatch = await subscribeWorkspaceConfigReserved(ctx, rawParams);
  dispatch.commit();
  return dispatch;
}

export async function subscribeWorkspaceConfigReserved(
  ctx: IndexconfigDomainState,
  rawParams: unknown,
): Promise<V4SubscribeDispatchResult<WorkspaceConfigTopicFrame>> {
  const params = v4ConversationSubscribeParamsSchema.parse(rawParams);
  const workspaceId = parseWorkspaceConfigTopic(params.topic);
  if (workspaceId === null) {
    throw new Error(`Not a workspace-config topic: ${params.topic}`);
  }
  const publisher = await ensureConfigPublisher(ctx, workspaceId);
  const result = publisher.subscribeReserved(params.connectionId, params.base);
  try {
    return flush.subscribeDispatch(
      ctx,
      {
        subscriptionId: result.subscriptionId,
        mode: result.mode,
        logEpoch: publisher.logEpoch,
      },
      result.reservation,
      () => flushConfig(ctx, workspaceId),
    );
  } catch (error) {
    // 与 sessions-index 同一原子边界：encode 失败 = subscribe 未 admission。
    result.rollback();
    throw error;
  }
}

/**
 * 配置目录发布入口（宿主在 provider registry 应用 / workspace 默认项变更后调用，
 * 直接携带已构建好的目录，不回头重拉宿主，避免重复 buildWorkspaceState 的临时 app 成本）。
 * conflation 在 publisher 内完成（未变化不产帧）；无 publisher 时同步建一个空种子的
 * publisher 存住最新态，后续订阅者据此拿到完整 snapshot。
 */
export function publishWorkspaceConfig(
  ctx: IndexconfigDomainState,
  workspaceId: string,
  state: WorkspaceConfigState,
): void {
  if (ctx.disposed) return;
  let publisher = ctx.configPublishers.get(workspaceId);
  if (!publisher) {
    publisher = new WorkspaceConfigPublisher(
      workspaceId,
      ctx.createLogEpoch(`workspace-config/${workspaceId}`),
      ctx.now,
    );
    ctx.configPublishers.set(workspaceId, publisher);
  }
  try {
    if (publisher.publish(state)) flushConfig(ctx, workspaceId);
  } catch (error) {
    ctx.host.onError?.("v4.workspaceConfig.publish", error);
  }
}

async function pullWorkspaceConfig(
  ctx: IndexconfigDomainState,
  workspaceId: string,
): Promise<WorkspaceConfigState | null> {
  if (!ctx.host.getWorkspaceConfig) return null;
  return (await ctx.host.getWorkspaceConfig(workspaceId)) ?? null;
}

/** 建/取某 workspace 的 config publisher；建时经宿主钩子拉取当前目录作种子。 */
async function ensureConfigPublisher(
  ctx: IndexconfigDomainState,
  workspaceId: string,
): Promise<WorkspaceConfigPublisher> {
  const existing = ctx.configPublishers.get(workspaceId);
  if (existing) return existing;
  const publisher = new WorkspaceConfigPublisher(
    workspaceId,
    ctx.createLogEpoch(`workspace-config/${workspaceId}`),
    ctx.now,
  );
  const seed = await pullWorkspaceConfig(ctx, workspaceId).catch((error) => {
    ctx.host.onError?.("v4.workspaceConfig.seed", error);
    return null;
  });
  if (seed) publisher.publish(seed);
  // await 期间的并发订阅可能已注册同 workspace publisher → 以先注册者为准。
  const raced = ctx.configPublishers.get(workspaceId);
  if (raced) return raced;
  ctx.configPublishers.set(workspaceId, publisher);
  return publisher;
}

/** 把某 workspace config publisher 的未发增量帧推给所有订阅者。 */
export function flushConfig(
  ctx: IndexconfigDomainState,
  workspaceId: string,
  onlyConnectionId?: string,
): void {
  const publisher = ctx.configPublishers.get(workspaceId);
  if (!publisher) return;
  for (const subscriptionId of publisher.subscriptionIds()) {
    const connectionId = publisher.connectionIdForSubscription(subscriptionId);
    if (
      connectionId === null ||
      ctx.pausedConnections.has(connectionId) ||
      (onlyConnectionId !== undefined && connectionId !== onlyConnectionId)
    ) {
      continue;
    }
    const reservation = publisher.reserveFlush(subscriptionId);
    if (!reservation) continue;
    try {
      flush.emitReservation(ctx, reservation);
    } catch (error) {
      ctx.host.onError?.("v4.workspaceConfig.emit", error);
    }
  }
}
