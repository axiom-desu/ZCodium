import type { GatewayState } from "./v4-gateway-state.js";
import { ProjectionEventCommitWaitError } from "./v4-gateway-contract.js";

/** 本域实际使用的根状态窄面。 */
type LifecycleDomainState = Pick<
  GatewayState,
  | "attachmentPruneTimer"
  | "attachmentUploads"
  | "binaryReadCache"
  | "coldResume"
  | "configPublishers"
  | "controlReservations"
  | "createLogEpoch"
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
import * as sequence from "./v4-gateway-sequence.js";

export function releaseDetachedChild(ctx: LifecycleDomainState, childId: string): void {
  ctx.host.onDebug?.(`release detached live child publisher session=${childId}`);
  cleanupSessionRuntime(ctx, childId, { clearCommandInbox: false, notifyIndexRemoved: false });
}

/** 会话关闭：清 publisher 与其全部订阅调度；hydration 标记同清（重开走冷启动重建）；
 *  并从其 workspace index 移除该会话（session.removed 推给列表订阅者）。 */
export function disposeSession(ctx: LifecycleDomainState, sessionId: string): void {
  cleanupSessionRuntime(ctx, sessionId, {
    clearCommandInbox: false,
    notifyIndexRemoved: true,
  });
}

/**
 * Resident 容量去激活：与 disposeSession 相同的内存运行态清理，但**不**从 sessions-index
 * 移除会话（不发 session.removed）——去激活是纯内存优化，侧边栏列表项必须原样
 * 保留，再次订阅经冷恢复透明重建。
 */
export function deactivateSession(ctx: LifecycleDomainState, sessionId: string): void {
  cleanupSessionRuntime(ctx, sessionId, {
    clearCommandInbox: true,
    notifyIndexRemoved: false,
  });
}

/**
 * Resident 回收纯预检：调用方可在拆 runtime event subscription 前拒绝不安全回收。
 * deactivateSession 内仍复用同一校验，防止未来新增调用方绕过执行面 preflight。
 */
export function assertSessionRuntimeDeactivatable(
  ctx: LifecycleDomainState,
  sessionId: string,
): void {
  if (!ctx.inbox.hasPinnedSessionState(sessionId)) return;
  throw new Error(`Session command inbox is still pinned: ${sessionId}`);
}

/** Resident 回收判定：该会话是否还有 conversation 订阅者（桌面 tab / 手机 remote）。 */
export function hasConversationSubscribers(ctx: LifecycleDomainState, sessionId: string): boolean {
  return ctx.publishers.get(sessionId)?.hasSubscribers() ?? false;
}

/**
 * 内存诊断计数器。只读 size，不触碰状态。
 * detachedLive 用于观察子 session publisher 是否随父 session 释放。
 */
export function collectMemoryDiagnostics(ctx: LifecycleDomainState): Record<string, number> {
  return {
    publishers: ctx.publishers.size,
    detachedLive: ctx.detachedLiveSessions.size,
    detachedTerminal: ctx.detachedTerminalAt.size,
    rawSeqStates: ctx.rawSequenceStates.size,
  };
}

function cleanupSessionRuntime(
  ctx: LifecycleDomainState,
  sessionId: string,
  options: { clearCommandInbox: boolean; notifyIndexRemoved: boolean },
): void {
  if (options.clearCommandInbox) {
    // 清掉 in-flight/live 命令会破坏幂等与 FIFO。resident facts 已在回收前
    // 拦截；若这里仍命中，必须在拆 publisher 之前失败，不能留下半清状态。
    assertSessionRuntimeDeactivatable(ctx, sessionId);
  }
  sequence.rejectProjectionEventWaiters(
    ctx,
    sessionId,
    new ProjectionEventCommitWaitError(
      "fault.projectionEventCommit.disposed",
      `conversation session disposed while waiting for projection event commit: ${sessionId}`,
    ),
  );
  ctx.attachmentUploads.clearSession(sessionId);
  ctx.binaryReadCache.clearSession(sessionId);
  if (options.notifyIndexRemoved) {
    // 先取 workspaceId（会话 record 还在时），把 session.removed 推给列表订阅者。
    try {
      const workspaceId = ctx.host.getSessionWorkspaceId?.(sessionId) ?? null;
      if (workspaceId !== null) {
        const indexPublisher = ctx.indexPublishers.get(workspaceId);
        // 无订阅者时也必须先更新 projection，避免已有 publisher 在下次
        // subscribe 的 snapshot 中复活已删除会话；flushIndex 对空订阅自然 no-op。
        if (indexPublisher?.removeSession(sessionId)) {
          indexconfig.flushIndex(ctx, workspaceId);
        }
      }
    } catch (error) {
      ctx.host.onError?.("v4.sessionsIndex.remove", error);
    }
  }
  ctx.indexFanoutThrottle.clearSession(sessionId);
  for (const [routeKey, state] of ctx.flushStates) {
    if (state.sessionId !== sessionId) continue;
    if (state.timer) clearTimeout(state.timer);
    ctx.flushStates.delete(routeKey);
  }
  ctx.publishers.delete(sessionId);
  ctx.hydratedSessions.delete(sessionId);
  const hydrationBuffer = ctx.hydrationBuffers.get(sessionId);
  if (hydrationBuffer) hydrationBuffer.cancelled = true;
  ctx.hydrationBuffers.delete(sessionId);
  ctx.hydrationInFlight.delete(sessionId);
  ctx.telemetryNormalizer.clearSession(sessionId);
  ctx.readyFlights.delete(sessionId);
  ctx.rawSequenceStates.delete(sessionId);
  if (options.clearCommandInbox) ctx.inbox.clearSession(sessionId);
  ctx.detachedLiveSessions.delete(sessionId);
  ctx.projectionFaultedSessions.delete(sessionId);
  // detached child 归属清理：自己作为 child 从父表摘除；作为父则连带释放没有 record 的 child。
  ctx.detachedTerminalAt.delete(sessionId);
  const parentId = ctx.detachedChildParent.get(sessionId);
  if (parentId !== undefined) {
    ctx.detachedChildParent.delete(sessionId);
    const siblings = ctx.detachedChildrenByParent.get(parentId);
    siblings?.delete(sessionId);
    if (siblings && siblings.size === 0) ctx.detachedChildrenByParent.delete(parentId);
  }
  const children = ctx.detachedChildrenByParent.get(sessionId);
  if (children) {
    ctx.detachedChildrenByParent.delete(sessionId);
    for (const childId of children) {
      ctx.detachedChildParent.delete(childId);
      if (ctx.host.sessionExists(childId)) continue;
      releaseDetachedChild(ctx, childId);
    }
  }
}

export function dispose(ctx: LifecycleDomainState): void {
  ctx.disposed = true;
  ctx.localTtft.clear();
  ctx.telemetryEventIds.clear();
  for (const sessionId of ctx.projectionEventCommitWaiters.keys()) {
    sequence.rejectProjectionEventWaiters(
      ctx,
      sessionId,
      new ProjectionEventCommitWaitError(
        "fault.projectionEventCommit.gatewayDisposed",
        "conversation gateway disposed while waiting for projection event commit",
      ),
    );
  }
  clearInterval(ctx.attachmentPruneTimer);
  ctx.indexFanoutThrottle.clear();
  ctx.attachmentUploads.clear();
  ctx.binaryReadCache.clear();
  for (const state of ctx.flushStates.values()) {
    if (state.timer) clearTimeout(state.timer);
  }
  ctx.flushStates.clear();
  ctx.publishers.clear();
  ctx.hydratedSessions.clear();
  for (const buffer of ctx.hydrationBuffers.values()) buffer.cancelled = true;
  ctx.hydrationBuffers.clear();
  ctx.hydrationInFlight.clear();
  ctx.readyFlights.clear();
  ctx.rawSequenceStates.clear();
  ctx.detachedLiveSessions.clear();
  ctx.detachedChildParent.clear();
  ctx.detachedChildrenByParent.clear();
  ctx.detachedTerminalAt.clear();
  ctx.projectionFaultedSessions.clear();
  ctx.coldResume.clear();
  ctx.indexPublishers.dispose();
  ctx.configPublishers.clear();
  ctx.pausedConnections.clear();
}
