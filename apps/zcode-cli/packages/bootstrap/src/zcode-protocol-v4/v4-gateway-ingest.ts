import type { SessionEvent, TargetChangedPayload } from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import { pluginUiToolResultNotificationSchema } from "@zcode/shared/mcp-apps";
import { ProjectionPayloadTooLargeError } from "./conversation-topic-publisher.js";
import type { GatewayState } from "./v4-gateway-state.js";
import {
  DETACHED_CHILD_PUBLISHER_GRACE_MS,
  MAX_TELEMETRY_EVENT_IDS,
  ProjectionEventCommitWaitError,
} from "./v4-gateway-contract.js";

/** 本域实际使用的根状态窄面。 */
type IngestDomainState = Pick<
  GatewayState,
  | "attachmentPruneTimer"
  | "attachmentUploads"
  | "binaryReadCache"
  | "coldResume"
  | "configPublishers"
  | "controlReservations"
  | "createLogEpoch"
  | "cuaPermissionNormalizer"
  | "detachedChildParent"
  | "detachedChildrenByParent"
  | "detachedLiveSessions"
  | "detachedTerminalAt"
  | "disposed"
  | "flushStates"
  | "host"
  | "hydratedSessions"
  | "hydrationBuffers"
  | "hydrationInFlight"
  | "inbox"
  | "indexFanoutThrottle"
  | "indexPublishers"
  | "localTtft"
  | "now"
  | "pausedConnections"
  | "projectionEventCommitWaiters"
  | "projectionFaultedSessions"
  | "publishers"
  | "rawSequenceStates"
  | "readyFlights"
  | "telemetryEventIds"
  | "telemetryNormalizer"
>;
import * as indexconfig from "./v4-gateway-index-config.js";
import * as flush from "./v4-gateway-flush.js";
import * as hydration from "./v4-gateway-hydration.js";
import * as sequence from "./v4-gateway-sequence.js";
import * as lifecycle from "./v4-gateway-lifecycle.js";

/** 权威事件入口：投影推进 + 各订阅者按 profile.flushWindowMs 调度打帧。 */
export function ingest(ctx: IngestDomainState, sessionId: string, event: SessionEvent): void {
  if (ctx.disposed) return;
  const hydrationBuffer = ctx.hydrationBuffers.get(sessionId);
  if (hydrationBuffer) {
    const eventId = String(event.id);
    if (hydrationBuffer.eventIds.has(eventId)) return;
    // 先记 raw fact；它可能因前序尚未到而暂时不进 publisher。
    hydrationBuffer.eventIds.add(eventId);
    hydrationBuffer.rawEvents.push(event);
  }
  emitLiveTelemetryFact(ctx, sessionId, event);
  for (const normalizedEvent of sequence.normalizeRuntimeEventSequence(ctx, sessionId, event)) {
    if (
      normalizedEvent.type === SessionEventType.TurnStarted ||
      normalizedEvent.type === SessionEventType.TurnComplete ||
      normalizedEvent.type === SessionEventType.TurnError
    ) {
      try {
        ctx.host.emitSessionActivity?.({
          sessionId,
          state: normalizedEvent.type === SessionEventType.TurnStarted ? "running" : "idle",
        });
      } catch (error) {
        ctx.host.onError?.("v4.session.activity", error);
      }
    }
    try {
      ctx.localTtft.event(sessionId, normalizedEvent);
    } catch (error) {
      try {
        ctx.host.onError?.("v4.localTtft.observe", error);
      } catch {
        /* 诊断回调也不能阻断实际内容。 */
      }
    }
    ingestNormalizedEvent(ctx, sessionId, normalizedEvent);
  }
}

function emitLiveTelemetryFact(
  ctx: IngestDomainState,
  sessionId: string,
  event: SessionEvent,
): void {
  const eventId = String(event.id);
  // 主 session 与 detached child 各自维护事件序列，eventId 不能假设跨
  // session 全局唯一。旧去重只用 eventId，会把 child 的同号事件误判成主会话重放，
  // 导致前台 Subagent 的真实轮次事实被静默丢弃。
  const telemetryEventKey = `${sessionId}\0${eventId}`;
  if (ctx.telemetryEventIds.has(telemetryEventKey)) return;
  ctx.telemetryEventIds.add(telemetryEventKey);
  if (ctx.telemetryEventIds.size > MAX_TELEMETRY_EVENT_IDS) {
    const oldest = ctx.telemetryEventIds.values().next().value;
    if (typeof oldest === "string") ctx.telemetryEventIds.delete(oldest);
  }
  try {
    const fact = ctx.telemetryNormalizer.normalize(sessionId, event, {
      memoryEnabled: ctx.host.getSessionMemoryEnabled?.(sessionId),
    });
    if (fact) {
      ctx.host.emitConversationTelemetryFact?.(fact);
    }
  } catch (error) {
    // 轮次事实绝不能反向阻断 conversation 投影；严格 schema 失败只记录诊断。
    ctx.host.onError?.("v4.telemetry.normalize", error);
  }
  try {
    const observation = ctx.cuaPermissionNormalizer.normalize(sessionId, event);
    if (observation) ctx.host.emitCuaPermissionObservation?.(observation);
  } catch (error) {
    // 权限观察只是 live UI 提示，schema 或投影异常不能阻断 conversation 主链路。
    ctx.host.onError?.("v4.cuaPermissionObservation.normalize", error);
  }
}

function ingestNormalizedEvent(
  ctx: IngestDomainState,
  sessionId: string,
  event: SessionEvent,
): void {
  const publisher = hydration.ensurePublisher(ctx, sessionId);
  const promotedQueueRemoval =
    event.type === SessionEventType.TurnSteerDiscarded &&
    (event.payload as { reason?: string }).reason === "promoted";
  const removedQueueItems =
    event.type === SessionEventType.TurnSteerDrained ||
    event.type === SessionEventType.TurnSteerDiscarded
      ? ((event.payload as { pendingInputIds?: string[] }).pendingInputIds ?? []).flatMap(
          (queueItemId) => {
            const item = publisher
              .getSnapshot()
              .queue.items.find((candidate) => candidate.queueItemId === queueItemId);
            return item ? [item] : [];
          },
        )
      : [];
  try {
    publisher.ingest(event);
  } catch (error) {
    const commitError =
      error instanceof ProjectionEventCommitWaitError
        ? error
        : new ProjectionEventCommitWaitError(
            "fault.projectionEventCommit.applyFailed",
            `projection failed to apply event ${String(event.id)}`,
            { cause: error },
          );
    sequence.rejectProjectionEventCommit(ctx, sessionId, String(event.id), commitError);
    if (!(error instanceof ProjectionPayloadTooLargeError)) throw error;
    ctx.host.onError?.("v4.projection.payloadTooLarge", error);
    if (!ctx.projectionFaultedSessions.has(sessionId)) {
      ctx.projectionFaultedSessions.add(sessionId);
      void Promise.resolve(
        ctx.host.terminateTurnForProjectionFault?.(sessionId, error.reasonCode),
      ).catch((terminateError) => {
        ctx.host.onError?.("v4.projection.terminate", terminateError);
      });
    }
    return;
  }
  sequence.resolveProjectionEventCommit(ctx, sessionId, String(event.id));
  // 原因：后台会话没有卡片/订阅时无法创建 guest。只在 live 投影提交后投递，
  // 从同一权威工具行取输入和 UI 描述；历史 hydration 直接写 publisher，不走此入口。
  if (event.type === SessionEventType.ToolCallResult && ctx.host.emitPluginUiToolResult) {
    const toolCallId = (event.payload as { toolCallId: string }).toolCallId;
    const row = publisher
      .getSnapshot()
      .rows.window.find((row) => row.kind === "toolCall" && row.toolCallId === toolCallId);
    if (row?.kind === "toolCall" && row.status === "success" && row.display?.kind === "mcp_tool") {
      const result = pluginUiToolResultNotificationSchema.safeParse({
        sessionId,
        toolCallId,
        serverName: row.display.serverName,
        ui: row.display.ui,
        ...(row.input && typeof row.input === "object" && !Array.isArray(row.input)
          ? { input: row.input }
          : {}),
      });
      if (result.success) ctx.host.emitPluginUiToolResult(result.data);
    }
  }
  if (
    event.type === SessionEventType.TargetChanged &&
    (event.payload as TargetChangedPayload).target?.status === "complete"
  ) {
    try {
      ctx.host.onTargetCompleted?.(sessionId, event);
    } catch (error) {
      ctx.host.onError?.("v4.projection.targetCompleted", error);
    }
  }
  if (event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError) {
    ctx.projectionFaultedSessions.delete(sessionId);
  }
  if (event.type === SessionEventType.TurnSteerQueued) {
    const queueItemId = (event.payload as { pendingInputId?: string }).pendingInputId;
    const item = queueItemId
      ? publisher
          .getSnapshot()
          .queue.items.find((candidate) => candidate.queueItemId === queueItemId)
      : undefined;
    if (item) ctx.inbox.pinLiveInput(sessionId, item);
  }
  if (!promotedQueueRemoval) {
    if (removedQueueItems.length > 0) {
      // delete/clear 已先把 durable session_input 写成 cancelled，但本 session
      // 的 persistent command index 可能缓存过旧空结果。必须先失效再解除 live pin，
      // 否则 LRU 淘汰后同 commandId 查询仍可能 unknown 并被重复执行。
      ctx.host.invalidatePersistentCommandFacts?.(sessionId);
    }
    for (const item of removedQueueItems) {
      ctx.inbox.releaseLiveInput({
        sessionId,
        commandId: item.sourceCommandId,
      });
    }
  }
  if (event.type === SessionEventType.SessionInputPromoted) {
    const sourceCommandId = (event.payload as { sourceCommandId?: string }).sourceCommandId;
    if (sourceCommandId) {
      // persistent index 可能早于本条 user message 被 query 过；先失效再解 pin，
      // 后续 LRU 淘汰回源时才能重读刚提交的 transcript，而不是命中旧空 seed。
      ctx.host.invalidatePersistentCommandFacts?.(sessionId);
      ctx.inbox.releaseLiveInput({ sessionId, commandId: sourceCommandId });
    }
  }
  // assistant 守恒：投影拒收了正文流（订阅中途建 publisher、错过
  // TurnStarted 的典型形态）→ 撤销 hydrated 标记，下次订阅强制从持久事实重新
  // hydration 补齐缺段——静默丢会让内容缺失直到用户手动刷新才恢复。
  if (publisher.getDroppedContentStreamEventCount() > 0 && ctx.hydratedSessions.has(sessionId)) {
    ctx.hydratedSessions.delete(sessionId);
    ctx.host.onError?.(
      "v4.assistantConservation",
      new Error(
        `projection dropped content stream events for session ${sessionId}; scheduling re-hydration`,
      ),
    );
  }
  for (const [routeKey, state] of ctx.flushStates) {
    if (state.sessionId !== sessionId) continue;
    flush.scheduleFlush(ctx, routeKey, state, publisher);
  }
  // sessions-index fan-out（防御式：任何异常都不能打断 conversation 主路径）。
  indexconfig.fanOutToIndex(ctx, sessionId, event);
}

/**
 * subagent child 使用父 record 的外部 sink，但保留独立 session topic。显式登记这类
 * detached live session，避免把任意偶然存在的 cold publisher 都误判为运行中 child。
 */
export function ingestDetachedLiveSession(
  ctx: IngestDomainState,
  sessionId: string,
  event: SessionEvent,
  parentSessionId?: string,
): void {
  if (!ctx.detachedLiveSessions.has(sessionId)) {
    ctx.host.onDebug?.(`register detached live child publisher session=${sessionId}`);
  }
  ctx.detachedLiveSessions.add(sessionId);
  if (parentSessionId && parentSessionId !== sessionId) {
    ctx.detachedChildParent.set(sessionId, parentSessionId);
    let children = ctx.detachedChildrenByParent.get(parentSessionId);
    if (!children) {
      children = new Set();
      ctx.detachedChildrenByParent.set(parentSessionId, children);
    }
    children.add(sessionId);
  }
  // child 是一次性 session，没有 record 也没有后继 turn，publisher 曾驻留到进程退出。
  // 记下终态时间，供 pruneDetachedChildPublishers 在 grace 后释放；child 再次开 turn 则撤销。
  if (event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError) {
    ctx.detachedTerminalAt.set(sessionId, Date.now());
  } else if (event.type === SessionEventType.TurnStarted) {
    ctx.detachedTerminalAt.delete(sessionId);
  }
  ingest(ctx, sessionId, event);
}

/**
 * 低频 tick 兜底：释放已终态、无订阅者、且没有自己 record 的 detached child publisher。
 * 释放后再被订阅走既有 cold resume（child 作为 subagent_child 持久化在 session store）。返回释放数。
 */
export function pruneDetachedChildPublishers(
  ctx: IngestDomainState,
  nowMs: number = Date.now(),
  graceMs: number = DETACHED_CHILD_PUBLISHER_GRACE_MS,
): number {
  let released = 0;
  // 与拆分前 gateway 私有实现一致：先取快照再 prune，releaseDetachedChild 会删
  // detachedTerminalAt 条目，快照遍历才能保证本轮只处理开始时已终态的那些 child。
  for (const [childId, terminalAt] of Array.from(ctx.detachedTerminalAt)) {
    if (nowMs - terminalAt < graceMs) continue;
    if (ctx.host.sessionExists(childId)) continue;
    if (ctx.publishers.get(childId)?.hasSubscribers()) continue;
    lifecycle.releaseDetachedChild(ctx, childId);
    released += 1;
  }
  return released;
}
