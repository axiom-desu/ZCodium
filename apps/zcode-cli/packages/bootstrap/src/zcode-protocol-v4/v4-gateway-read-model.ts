import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationRowTarget, QueueItem } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationRowTargetAction } from "./product-projection.js";
import type { GatewayState } from "./v4-gateway-state.js";

/** 本域实际使用的根状态窄面。 */
type ReadmodelDomainState = Pick<
  GatewayState,
  | "controlReservations"
  | "flushStates"
  | "host"
  | "inbox"
  | "localTtft"
  | "pausedConnections"
  | "publishers"
>;
import * as flush from "./v4-gateway-flush.js";

/** session entry 状态变更后的轻量 metadata 更新，不重放 conversation event。 */
export function updateSharedContextImport(
  ctx: ReadmodelDomainState,
  sessionId: string,
  source: ConversationSnapshot["sharedContextImport"],
): void {
  const publisher = ctx.publishers.get(sessionId);
  if (!publisher) return;
  publisher.seedSharedContextImport(source);
  for (const [routeKey, state] of ctx.flushStates) {
    if (state.sessionId === sessionId) flush.scheduleFlush(ctx, routeKey, state, publisher);
  }
}

export function getQueueItem(
  ctx: ReadmodelDomainState,
  sessionId: string,
  queueItemId: string,
): QueueItem | null {
  const snapshot = ctx.publishers.get(sessionId)?.getSnapshot();
  const item = snapshot?.queue.items.find((candidate) => candidate.queueItemId === queueItemId);
  return item ?? null;
}

export function hasQueueItemKind(
  ctx: ReadmodelDomainState,
  sessionId: string,
  kind: QueueItem["kind"],
): boolean {
  return Boolean(
    ctx.publishers
      .get(sessionId)
      ?.getSnapshot()
      .queue.items.some((candidate) => candidate.kind === kind),
  );
}

export function hasQueuedDelivery(
  ctx: ReadmodelDomainState,
  sessionId: string,
  delivery: "guide" | "queue",
): boolean {
  return Boolean(
    ctx.publishers
      .get(sessionId)
      ?.getSnapshot()
      .queue.items.some((candidate) => candidate.delivery.admitted === delivery),
  );
}

export function getQueueLength(ctx: ReadmodelDomainState, sessionId: string): number {
  return ctx.publishers.get(sessionId)?.getSnapshot().queue.items.length ?? 0;
}

/** Resident 回收保护：publisher queue 与 CommandInbox pinned facts 任一存在都不可关闭。 */
export function hasResidencyBlockingCommands(
  ctx: ReadmodelDomainState,
  sessionId: string,
): boolean {
  return getQueueLength(ctx, sessionId) > 0 || ctx.inbox.hasPinnedSessionState(sessionId);
}

export function getQueueHead(
  ctx: ReadmodelDomainState,
  sessionId: string,
): {
  autoDrain: boolean;
  dispatchState: QueueItem["dispatch"]["state"];
  kind: QueueItem["kind"];
  queueItemId: string;
  text: string;
} | null {
  const snapshot = ctx.publishers.get(sessionId)?.getSnapshot();
  const item = snapshot?.queue.items[0];
  if (!snapshot || !item) return null;
  return {
    autoDrain: snapshot.queue.autoDrain,
    dispatchState: item.dispatch.state,
    kind: item.kind,
    queueItemId: item.queueItemId,
    text: item.text,
  };
}

/**
 * 当前输入路由模式（v4 原生能力，供命令层 host.getInputRoutingMode 使用）：
 * held choice 裁决（heldQueueInputRequiresChoice）读投影 inputRouting.mode。
 */
export function getInputRoutingMode(
  ctx: ReadmodelDomainState,
  sessionId: string,
): "startNow" | "enqueue" | "guide" | "reject" | "choice" | null {
  return ctx.publishers.get(sessionId)?.getSnapshot().inputRouting.mode ?? null;
}

export function getSessionFollowupMode(
  ctx: ReadmodelDomainState,
  sessionId: string,
): "queue" | "guide" | null {
  return ctx.publishers.get(sessionId)?.getSnapshot().config.followupMode ?? null;
}

/**
 * rowId → 权威 messageId（v4 原生能力，供 forkAssistant/retryTurn 定位 assistant 行）。
 * 会话无 publisher / 行不存在 / 非 assistant 行 → null（命令层据此 reject，不静默兜底）。
 */
export function getMessageIdForRow(
  ctx: ReadmodelDomainState,
  sessionId: string,
  rowId: number,
): string | null {
  return ctx.publishers.get(sessionId)?.getMessageIdForRow(rowId) ?? null;
}

export function resolveRowActionTarget(
  ctx: ReadmodelDomainState,
  sessionId: string,
  target: ConversationRowTarget,
  action: ConversationRowTargetAction,
) {
  return ctx.publishers.get(sessionId)?.resolveRowActionTarget(target, action) ?? null;
}

/** rowId → 所属 product turn 内所有 transcript messageId（文件摘要撤销 / diff 查询）。 */
export function getMessageIdsForTurnRow(
  ctx: ReadmodelDomainState,
  sessionId: string,
  rowId: number,
): string[] {
  return ctx.publishers.get(sessionId)?.getMessageIdsForTurnRow(rowId) ?? [];
}

/** fork 目标必须是所属轮最后一段 assistantText（无投影 → null，按未知处理）。 */
export function isLatestAssistantSegmentRow(
  ctx: ReadmodelDomainState,
  sessionId: string,
  rowId: number,
): boolean | null {
  return ctx.publishers.get(sessionId)?.isLatestAssistantSegmentRow(rowId) ?? null;
}

export function resolveStableForkCandidate(
  ctx: ReadmodelDomainState,
  sessionId: string,
  rowId: number,
) {
  return ctx.publishers.get(sessionId)?.resolveStableForkCandidate(rowId) ?? null;
}

/** latestAssistantRetryOnly：retry 目标必须是全时间线最新且有 realUser cause 的 assistantText。 */
export function isLatestRetryAssistantRow(
  ctx: ReadmodelDomainState,
  sessionId: string,
  rowId: number,
): boolean | null {
  return ctx.publishers.get(sessionId)?.isLatestRetryAssistantRow(rowId) ?? null;
}

/** latestQueryEditOnly：edit 目标必须是当前投影里的最后一条 realUser userInput row。 */
export function isLatestEditableUserRow(
  ctx: ReadmodelDomainState,
  sessionId: string,
  rowId: number,
): boolean | null {
  return ctx.publishers.get(sessionId)?.isLatestEditableUserRow(rowId) ?? null;
}

/** rowId → product turnId（editUserQuery 无 assistant anchor 时回查 user messageId）。 */
export function getTurnIdForRow(
  ctx: ReadmodelDomainState,
  sessionId: string,
  rowId: number,
): string | null {
  return ctx.publishers.get(sessionId)?.getTurnIdForRow(rowId) ?? null;
}

/**
 * rowId → 所属 turn 的 rewind 锚点 messageId（供 editUserQuery：user 行无 messageId，
 * 用同 turn 内 assistant 行的 messageId 作 `/rewind` 目标）。
 */
export function getTurnRewindAnchor(
  ctx: ReadmodelDomainState,
  sessionId: string,
  rowId: number,
): string | null {
  return ctx.publishers.get(sessionId)?.getTurnRewindAnchor(rowId) ?? null;
}
