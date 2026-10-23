import type { SessionEvent } from "@zcode/contracts";
import {
  appendProjectionRowBase,
  findProjectionRow,
  isProjectionRunning,
  projectionMs,
  projectionTurnIdOf,
  type ProjectionState,
} from "./product-projection-state.js";
import { isOpenForegroundToolRow } from "./product-projection-tool-rows.js";
import type {
  ConversationDelta,
  ConversationRow,
  ConversationSnapshot,
  GoalState,
  SessionControl,
  StatePatch,
  SubagentRow,
  TurnHeaderRow,
  TurnWorkSegment,
} from "@zcode/shared/zcode-protocol-v4";
import type { CanonicalOpenSegmentIdentity } from "./event-normalizer.js";
import { computeAvailability, computeInputRouting } from "./projection-state.js";
import type { ConversationEditTarget } from "./product-projection-types.js";

/** messageId → rowId 反查（messageIdByRowId 的逆向线性扫描；行数有界，无需额外索引）。 */
export function rowIdForMessageId(
  state: Pick<ProjectionState, "messageIdByRowId" | "outputContinuationRowIdByMessageId">,
  messageId: string,
): number | null {
  const continuationRowId = state.outputContinuationRowIdByMessageId.get(messageId);
  if (continuationRowId !== undefined) return continuationRowId;
  for (const [rowId, mid] of state.messageIdByRowId) {
    if (mid === messageId) return rowId;
  }
  return null;
}

export function rewindAnchorForRows(
  state: Pick<ProjectionState, "messageIdByRowId">,
  rows: readonly ConversationRow[],
  rowId: number,
): string | null {
  const row = rows.find((candidate) => candidate.rowId === rowId);
  if (!row) return null;
  const turnId = row.turnId;
  for (const [candidateRowId, messageId] of state.messageIdByRowId) {
    const candidate = rows.find((item) => item.rowId === candidateRowId);
    if (candidate && candidate.turnId === turnId) return messageId;
  }
  return null;
}

/**
 * real-user row 的展示身份与命令身份必须原子登记。
 * TurnSteerDrained 曾只写 messageId/entityId，漏写 edit target，
 * 导致 UI action 与 editUserQuery resolver 对同一行得出相反结论。
 */
export function registerCanonicalUserRowTarget(
  state: Pick<ProjectionState, "editTargetByEntityId" | "entityIdByRowId" | "messageIdByRowId">,
  rowId: number,
  entityId: string,
  editTarget?: ConversationEditTarget,
): void {
  state.entityIdByRowId.set(rowId, entityId);
  if (!editTarget) return;
  state.messageIdByRowId.set(rowId, editTarget.transcriptMessageId);
  state.editTargetByEntityId.set(entityId, editTarget);
}

// turn 终态收口所有 foreground 未终态 tool row（迟到终态不复活由 isRunning 闸保证）；
// `only` 让 stream recovery 只收口未定稿的那一部分。

export function updateToolIndexesAfterDeltas(
  state: ProjectionState,
  deltas: readonly ConversationDelta[],
): void {
  for (const delta of deltas) {
    if (delta.op === "row.appended" || delta.op === "row.upserted") {
      if (delta.row.kind !== "toolCall") continue;
      if (isOpenForegroundToolRow(delta.row)) {
        state.openForegroundToolCallIds.add(delta.row.toolCallId);
      } else {
        state.openForegroundToolCallIds.delete(delta.row.toolCallId);
      }
      continue;
    }
    if (delta.op !== "row.removed") continue;
    for (const [toolCallId, rowId] of state.toolRowIdByCallId) {
      if (rowId < delta.fromRowId) continue;
      // Bug 原因：rewind 过去只删 rows/message 索引，旧 toolCallId 仍会阻止新分支
      // 重新打开同 id 的流式工具；open tracker 也会留下已经不存在的 row。
      state.toolRowIdByCallId.delete(toolCallId);
      state.openForegroundToolCallIds.delete(toolCallId);
      state.fileToolInputPreviewByCallId.delete(toolCallId);
    }
    pruneRemovedSubagentIndexes(state);
  }
}

function pruneRemovedSubagentIndexes(state: ProjectionState): void {
  for (const [agentId, rowId] of state.subagentRowIdByAgentId) {
    if (findRow(state, rowId)?.kind === "subagent") continue;
    // Bug 原因：rewind 只重建 rowIndex，旧 agent alias 仍会被后续每次 subagent
    // materialization 枚举。仅在 row.removed 已应用后按权威 snapshot 清理一次，
    // 避免长会话随已删除历史持续增长；普通事件不会扫描该索引。
    state.subagentRowIdByAgentId.delete(agentId);
  }
}

// ── 内部工具 ──

// goal 传 undefined = 不动 goal；传 null/对象 = 随本 patch 一并替换（availability 同源派生）。
// queue 传 undefined = 不动 queue；held 派生（heldQueueInputRequiresChoice）依赖
// queue.items.length + autoDrain，所以任何 control/goal/queue 变化都从同一处重算 A 区。
export function controlPatch(
  state: Pick<ProjectionState, "snapshot">,
  control: Partial<SessionControl>,
  goal?: GoalState | null,
  queue?: ConversationSnapshot["queue"],
): StatePatch {
  const next: SessionControl = { ...state.snapshot.control, ...control };
  const nextGoal = goal === undefined ? state.snapshot.goal : goal;
  const nextQueue = queue ?? state.snapshot.queue;
  const context = {
    phase: next.phase,
    goalStatus: nextGoal?.status ?? null,
    // compacting 不是独立 phase（封闭枚举），从 activeWorks 派生。
    compacting: next.activeWorks.some((work) => work.kind === "compact"),
    goalVerifying: next.activeWorks.some((work) => work.kind === "goalVerifier"),
    queueLength: nextQueue.items.length,
    autoDrain: nextQueue.autoDrain,
  };
  return {
    control: next,
    ...(goal === undefined ? {} : { goal }),
    ...(queue === undefined ? {} : { queue }),
    availability: computeAvailability(context),
    inputRouting: computeInputRouting(context, state.snapshot.config.followupMode),
  };
}

// goal 单独变化时的 patch（availability 与 goal 同源，phase/activeWorks 不变）。
export function goalPatch(
  state: Pick<ProjectionState, "snapshot">,
  goal: GoalState | null,
): StatePatch {
  return {
    goal,
    availability: computeAvailability(deriveContext(state, { goal })),
  };
}

// queue 单独变化时的 patch：queue 长度/autoDrain 影响 held 派生 → 同步重算 A 区。
export function queuePatch(
  state: Pick<ProjectionState, "snapshot">,
  queue: ConversationSnapshot["queue"],
): StatePatch {
  const context = deriveContext(state, { queue });
  return {
    queue,
    availability: computeAvailability(context),
    inputRouting: computeInputRouting(context, state.snapshot.config.followupMode),
  };
}

export function deriveContext(
  state: Pick<ProjectionState, "snapshot">,
  overrides: {
    goal?: GoalState | null;
    queue?: ConversationSnapshot["queue"];
  },
) {
  const goal = overrides.goal === undefined ? state.snapshot.goal : overrides.goal;
  const queue = overrides.queue ?? state.snapshot.queue;
  return {
    phase: state.snapshot.control.phase,
    goalStatus: goal?.status ?? null,
    compacting: state.snapshot.control.activeWorks.some((work) => work.kind === "compact"),
    goalVerifying: state.snapshot.control.activeWorks.some((work) => work.kind === "goalVerifier"),
    queueLength: queue.items.length,
    autoDrain: queue.autoDrain,
  };
}

export function completeWorkSegments(
  segments: readonly TurnWorkSegment[],
  endedAt: number,
): TurnWorkSegment[] {
  return segments.map((segment, index) =>
    index === segments.length - 1 && segment.endedAt === undefined
      ? {
          ...segment,
          endedAt,
          activeMs: Math.max(0, endedAt - segment.startedAt),
        }
      : segment,
  );
}

export function turnHeaderForEvent(
  state: ProjectionState,
  event: SessionEvent,
): TurnHeaderRow | undefined {
  const rowId = state.turnHeaderRowIdByTurnId.get(turnIdOf(state, event));
  if (rowId === undefined) return undefined;
  const row = findRow(state, rowId);
  return row?.kind === "turnHeader" ? row : undefined;
}

export function isRunning(state: ProjectionState): boolean {
  return isProjectionRunning(state);
}

export function isMirroredSubagentToolEvent(event: SessionEvent): boolean {
  const payload = event.payload as unknown as Record<string, unknown>;
  // Bug 原因：child tool lifecycle 会镜像到父 runtime，但它不是父 session 的工具事实。
  // V4 过去把 mirror 当普通 ToolCallRow，导致 main timeline 展示 child 的 Read/Bash，
  // 并让 replayable snapshot 同样带上脏 row。完整工具历史只应由 child topic 物化。
  return payload.source === "subagent";
}

export function openSegmentIdentity(
  state: Pick<ProjectionState, "entityIdByRowId" | "messageIdByRowId">,
  rowId: number | null,
): CanonicalOpenSegmentIdentity | null {
  if (rowId === null) return null;
  const entityId = state.entityIdByRowId.get(rowId);
  if (!entityId) return null;
  return {
    entityId,
    transcriptMessageId: state.messageIdByRowId.get(rowId) ?? null,
  };
}

export function rowBase(
  state: ProjectionState,
  event: SessionEvent,
  turnId: string,
  entityId = String(event.id),
) {
  return appendProjectionRowBase(state, event, turnId, entityId);
}

export function turnIdOf(state: ProjectionState, event: SessionEvent): string {
  return projectionTurnIdOf(state, event);
}

export function ms(event: SessionEvent): number {
  return projectionMs(event);
}

export function findRow(state: ProjectionState, rowId: number): ConversationRow | undefined {
  return findProjectionRow(state, rowId);
}

export function updateRowIndexAfterImmutableApply(
  state: Pick<ProjectionState, "rowIndexById" | "snapshot">,
  previousRowsLength: number,
  deltas: readonly ConversationDelta[],
): void {
  if (deltas.some((delta) => delta.op === "row.removed")) {
    state.rowIndexById = new Map(
      state.snapshot.rows.window.map((row, index) => [row.rowId, index]),
    );
    return;
  }
  let nextIndex = previousRowsLength;
  for (const delta of deltas) {
    if (delta.op !== "row.appended") continue;
    state.rowIndexById.set(delta.row.rowId, nextIndex);
    nextIndex += 1;
  }
}

export function findSubagentRow(state: ProjectionState, agentId: string): SubagentRow | undefined {
  const rowId = state.subagentRowIdByAgentId.get(agentId);
  if (rowId === undefined) return undefined;
  const row = findRow(state, rowId);
  return row?.kind === "subagent" ? row : undefined;
}

export function findSubagentLifecycleRow(
  state: ProjectionState,
  agentId: string,
  payload: Record<string, unknown>,
  event: SessionEvent,
): SubagentRow | undefined {
  const exact = findSubagentRow(state, agentId);
  if (exact) return exact;

  const parentToolCallId = stringPayload(payload, "parentToolCallId");
  if (!parentToolCallId) return undefined;
  const turnId = turnIdOf(state, event);
  // 晚订阅 hydration 无法从后台 Agent 的文本 tool output 恢复真实 agentId，
  // 会先用 toolCallId 合成一条 SubagentRow。后到的 live lifecycle 携带真实 agentId，
  // 旧逻辑因此追加第二行，UI 又会让无 childSessionId 的合成行抢占配对。父 tool call
  // 在同一 turn 内是稳定唯一身份，这里将真实事件归并回合成行并补齐 childSessionId。
  return state.snapshot.rows.window.find(
    (row): row is SubagentRow =>
      row.kind === "subagent" && row.turnId === turnId && row.parentToolCallId === parentToolCallId,
  );
}

export function subagentAgentId(payload: Record<string, unknown>, event: SessionEvent): string {
  return (
    stringPayload(payload, "agentId") ??
    stringPayload(payload, "childSessionId") ??
    stringPayload(payload, "parentToolCallId") ??
    `subagent-${event.sequenceNumber}`
  );
}

export function stringPayload(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function mapSubagentStatus(status: string | undefined): SubagentRow["status"] {
  switch (status) {
    case "completed":
    case "success":
      return "success";
    case "cancelled":
    case "stopped":
      return "cancelled";
    default:
      return "failed";
  }
}

// 旧事件没有 retryable 字段；保持历史 UI 的可重试语义，但新事件必须尊重显式 false。
export const LEGACY_TURN_ERROR_RECOVERABLE_FALLBACK = true;
export const USER_PROMPT_HOOK_BLOCK_ERROR_TYPE = "hooks_prompt_block";
