import type { ConversationTopicFrame, RoutedTopicFrame } from "@zcode/shared/zcode-protocol-v4";
import {
  DELIVERY_PROFILES,
  parseConversationTopic,
  parseSessionsIndexTopic,
  parseWorkspaceConfigTopic,
  v4ConnectionFlowParamsSchema,
  v4ConversationResyncParamsSchema,
  v4ConversationSubscribeParamsSchema,
  v4ConversationUnsubscribeParamsSchema,
} from "@zcode/shared/zcode-protocol-v4";
import type { GatewayState } from "./v4-gateway-state.js";
import { subscriptionRouteKey, type V4SubscribeDispatchResult } from "./v4-gateway-contract.js";

/** 本域实际使用的根状态窄面。 */
type SubscriptionsDomainState = Pick<
  GatewayState,
  | "attachmentUploads"
  | "coldResume"
  | "configPublishers"
  | "controlReservations"
  | "createLogEpoch"
  | "detachedLiveSessions"
  | "disposed"
  | "flushStates"
  | "host"
  | "hydratedSessions"
  | "hydrationBuffers"
  | "hydrationInFlight"
  | "indexFanoutThrottle"
  | "indexPublishers"
  | "localTtft"
  | "now"
  | "pausedConnections"
  | "projectionEventCommitWaiters"
  | "publishers"
  | "rawSequenceStates"
  | "readyFlights"
>;
import * as indexconfig from "./v4-gateway-index-config.js";
import * as flush from "./v4-gateway-flush.js";
import * as hydration from "./v4-gateway-hydration.js";

export function setConnectionFlowState(ctx: SubscriptionsDomainState, rawParams: unknown): void {
  const params = v4ConnectionFlowParamsSchema.parse(rawParams);
  if (params.state === "closed") {
    ctx.pausedConnections.delete(params.connectionId);
    clearConnectionFlushTimers(ctx, params.connectionId);
    ctx.attachmentUploads.clearConnection(params.connectionId);
    return;
  }
  if (params.state === "saturated") {
    if (ctx.pausedConnections.has(params.connectionId)) return;
    ctx.pausedConnections.add(params.connectionId);
    clearConnectionFlushTimers(ctx, params.connectionId);
    return;
  }
  if (!ctx.pausedConnections.delete(params.connectionId)) return;
  flushConnection(ctx, params.connectionId);
}

function clearConnectionFlushTimers(ctx: SubscriptionsDomainState, connectionId: string): void {
  for (const state of ctx.flushStates.values()) {
    if (state.connectionId !== connectionId || state.timer === null) continue;
    clearTimeout(state.timer);
    state.timer = null;
  }
}

function flushConnection(ctx: SubscriptionsDomainState, connectionId: string): void {
  for (const [routeKey, state] of ctx.flushStates) {
    if (state.connectionId !== connectionId) continue;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    const publisher = ctx.publishers.get(state.sessionId);
    if (!publisher?.hasSubscription(state.subscriptionId, connectionId)) {
      ctx.flushStates.delete(routeKey);
      continue;
    }
    const reservation = publisher.reserveFlush(state.subscriptionId);
    if (!reservation) continue;
    try {
      flush.emitReservation(ctx, reservation);
    } catch (error) {
      ctx.host.onError?.("v4.frame.emit", error);
    }
  }
  for (const workspaceId of ctx.indexPublishers.keys()) {
    indexconfig.flushIndex(ctx, workspaceId, connectionId);
  }
  for (const workspaceId of ctx.configPublishers.keys()) {
    indexconfig.flushConfig(ctx, workspaceId, connectionId);
  }
}

/** v4/conversation/subscribe：裁决 + server 内部 initial frame，公共响应由 server 只取 ACK。 */
export async function subscribe(
  ctx: SubscriptionsDomainState,
  rawParams: unknown,
): Promise<V4SubscribeDispatchResult<ConversationTopicFrame>> {
  const dispatch = await subscribeReserved(ctx, rawParams);
  dispatch.commit();
  return dispatch;
}

export async function subscribeReserved(
  ctx: SubscriptionsDomainState,
  rawParams: unknown,
): Promise<V4SubscribeDispatchResult<ConversationTopicFrame>> {
  const params = v4ConversationSubscribeParamsSchema.parse(rawParams);
  const sessionId = parseConversationTopic(params.topic);
  if (sessionId === null) {
    throw new Error(`Unsupported topic: ${params.topic}`);
  }
  const isLiveConversation = hydration.hasLiveConversation(ctx, sessionId);
  ctx.host.onDebug?.(
    `subscribe conversation session=${sessionId} coldResume=${String(!isLiveConversation)}`,
  );
  // Hydration：首次订阅时从权威来源重建投影。
  // - 无 publisher（cold）→ 建 + 重放。
  // - 有 publisher 但事件日志覆盖不了 transcript（fork child：resume 的 ingest 抢先
  //   建了个只含 fork 事件的 cold publisher）→ 用 transcript 合成**重建**。
  // - 有 publisher 且事件日志完整（流式 live）→ 保留，重放会双计且打断流。
  const restoreStartedAt = performance.now();
  const existingReady = ctx.readyFlights.get(sessionId);
  const publisher = existingReady
    ? await existingReady
    : !isLiveConversation
      ? await hydration.ensureColdReadyPublisher(
          ctx,
          sessionId,
          params.resumeThoughtLevel,
          params.workspace,
          params.additionalDirectories,
        )
      : await hydration.hydratePublisher(ctx, sessionId);
  const cliSessionRestoreMs = !isLiveConversation
    ? Math.max(0, Math.round(performance.now() - restoreStartedAt))
    : undefined;
  // 旧入口允许 UI 自选 deliveryProfile，桌面调用遗漏时还会默认成
  // replayable。现在只认 host attachment 注入的可信 clientMode。
  const profileName = params.clientMode === "desktop-continuous" ? "continuous" : "replayable";
  // subscribeReserved 已构建 wire projection；若在它之后才开始计时，大会话的
  // 行过滤/窗口截断会落在 restore 与 encode 两段之外。起点必须覆盖构建与 physical encode。
  const initialFrameEncodeStartedAt = performance.now();
  const result = publisher.subscribeReserved({
    connectionId: params.connectionId,
    base: params.base,
    deliveryProfile: profileName,
    // 与 clientMode 同族的可信注入：能力位来自该连接的 clientHello，缺席一律按旧消费者办
    // （整键 patch + 旧界裁剪）。resync / rehydrate 沿用订阅上已记下的这一位，不再重取。
    workflowRunDeltas: params.workflowRunDeltas === true,
  });
  const routeKey = subscriptionRouteKey(
    params.topic,
    result.ack.subscriptionId,
    params.connectionId,
  );
  let dispatch: V4SubscribeDispatchResult<ConversationTopicFrame>;
  try {
    dispatch = flush.subscribeDispatch(ctx, result.ack, result.reservation, () => {
      const state = ctx.flushStates.get(routeKey);
      if (state) flush.scheduleFlush(ctx, routeKey, state, publisher);
    });
    dispatch.ack = {
      ...dispatch.ack,
      openTiming: {
        version: 1,
        ...(cliSessionRestoreMs !== undefined ? { cliSessionRestoreMs } : {}),
        initialFrameEncodeMs: Math.max(
          0,
          Math.round(performance.now() - initialFrameEncodeStartedAt),
        ),
        sessionRuntimeState: isLiveConversation ? "warm" : "cold",
        snapshotRowCount: publisher.getSnapshot().rows.window.length,
      },
    };
  } catch (error) {
    // 重订 initial encode 失败时客户端仍持有旧 subId；replacement 必须
    // 原子 rollback，旧 publisher subscription 与 flush timer 都继续有效。
    result.rollback();
    throw error;
  }
  // encode 成功后 replacement 才 admission；此时再清旧调度状态，失败路径不碰旧 owner。
  for (const [staleRouteKey, staleState] of ctx.flushStates) {
    if (staleState.sessionId !== sessionId) continue;
    if (publisher.hasSubscription(staleState.subscriptionId, staleState.connectionId)) {
      continue;
    }
    if (staleState.timer) clearTimeout(staleState.timer);
    ctx.flushStates.delete(staleRouteKey);
  }
  ctx.flushStates.set(routeKey, {
    sessionId,
    topic: params.topic,
    subscriptionId: result.ack.subscriptionId,
    connectionId: params.connectionId,
    deliveryProfile: profileName,
    flushWindowMs: DELIVERY_PROFILES[profileName].flushWindowMs,
    timer: null,
  });
  return dispatch;
}

/**
 * v4/conversation/resync：按 owned topic/connection 精确命中现有 subscription，
 * 保持 subId/profile 不变，从客户端 base 重新裁决 resume/snapshot。
 */
export function resyncReserved(
  ctx: SubscriptionsDomainState,
  rawParams: unknown,
): V4SubscribeDispatchResult<RoutedTopicFrame> {
  const params = v4ConversationResyncParamsSchema.parse(rawParams);
  const request = {
    base: params.base,
    ...(params.forceSnapshot !== undefined ? { forceSnapshot: params.forceSnapshot } : {}),
  };
  const sessionId = parseConversationTopic(params.topic);
  if (sessionId !== null) {
    const publisher = ctx.publishers.get(sessionId);
    if (!publisher?.hasSubscription(params.subscriptionId, params.connectionId)) {
      throw new Error("fault.subscription.notOwned");
    }
    const routeKey = subscriptionRouteKey(params.topic, params.subscriptionId, params.connectionId);
    const flushState = ctx.flushStates.get(routeKey);
    if (flushState?.timer) {
      clearTimeout(flushState.timer);
      flushState.timer = null;
    }
    const result = publisher.resyncReserved(params.subscriptionId, request);
    if (!result) throw new Error("fault.subscription.notOwned");
    try {
      return flush.subscribeDispatch(ctx, result.ack, result.reservation, () => {
        const state = ctx.flushStates.get(routeKey);
        if (state) flush.scheduleFlush(ctx, routeKey, state, publisher);
      });
    } catch (error) {
      // physical encode 在 ACK admission 前失败时，same-sub recovery
      // 不能留下新的 inFlight 或取消旧 online flush；原子恢复旧状态后重挂 timer。
      result.rollback();
      if (flushState) flush.scheduleFlush(ctx, routeKey, flushState, publisher);
      throw error;
    }
  }

  const indexWorkspaceId = parseSessionsIndexTopic(params.topic);
  if (indexWorkspaceId !== null) {
    const publisher = ctx.indexPublishers.get(indexWorkspaceId);
    if (!publisher?.hasSubscription(params.subscriptionId, params.connectionId)) {
      throw new Error("fault.subscription.notOwned");
    }
    const result = publisher.resyncReserved(params.subscriptionId, request);
    if (!result) throw new Error("fault.subscription.notOwned");
    try {
      return flush.subscribeDispatch(
        ctx,
        {
          subscriptionId: result.subscriptionId,
          mode: result.mode,
          logEpoch: publisher.logEpoch,
        },
        result.reservation,
        () => indexconfig.flushIndex(ctx, indexWorkspaceId),
      );
    } catch (error) {
      result.rollback();
      throw error;
    }
  }

  const configWorkspaceId = parseWorkspaceConfigTopic(params.topic);
  if (configWorkspaceId !== null) {
    const publisher = ctx.configPublishers.get(configWorkspaceId);
    if (!publisher?.hasSubscription(params.subscriptionId, params.connectionId)) {
      throw new Error("fault.subscription.notOwned");
    }
    const result = publisher.resyncReserved(params.subscriptionId, request);
    if (!result) throw new Error("fault.subscription.notOwned");
    try {
      return flush.subscribeDispatch(
        ctx,
        {
          subscriptionId: result.subscriptionId,
          mode: result.mode,
          logEpoch: publisher.logEpoch,
        },
        result.reservation,
        () => indexconfig.flushConfig(ctx, configWorkspaceId),
      );
    } catch (error) {
      result.rollback();
      throw error;
    }
  }
  throw new Error(`Unsupported topic: ${params.topic}`);
}

/** v4/conversation/unsubscribe。 */
export function unsubscribe(ctx: SubscriptionsDomainState, rawParams: unknown): void {
  const params = v4ConversationUnsubscribeParamsSchema.parse(rawParams);
  const sessionId = parseConversationTopic(params.topic);
  if (sessionId === null) {
    const workspaceId = parseSessionsIndexTopic(params.topic);
    if (workspaceId !== null) {
      ctx.indexPublishers.get(workspaceId)?.unsubscribe(params.subscriptionId, params.connectionId);
      return;
    }
    const configWorkspaceId = parseWorkspaceConfigTopic(params.topic);
    if (configWorkspaceId !== null) {
      ctx.configPublishers
        .get(configWorkspaceId)
        ?.unsubscribe(params.subscriptionId, params.connectionId);
    }
    return;
  }
  const routeKey = subscriptionRouteKey(params.topic, params.subscriptionId, params.connectionId);
  const state = ctx.flushStates.get(routeKey);
  if (!state) return;
  if (state?.timer) clearTimeout(state.timer);
  ctx.flushStates.delete(routeKey);
  // 裸 subscriptionId 在不同 topic/connection 可碰撞；旧网关先按 subId
  // 反查再对三类 publisher 广撒网，会删掉别的连接。topic + connection 必须同时命中。
  ctx.publishers.get(sessionId)?.unsubscribe(params.subscriptionId, params.connectionId);
}
