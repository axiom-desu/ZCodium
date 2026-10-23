import type { SessionEvent, TurnCompletePayload } from "@zcode/contracts";
import type { ProjectionState } from "./product-projection-state.js";
import { closeStreamingRows } from "./product-projection-stream.js";
import { closeOpenToolRows } from "./product-projection-tool-rows.js";
import type {
  AssistantTextRow,
  ConversationDelta,
  GoalState,
  SessionControl,
  TurnWorkSegment,
} from "@zcode/shared/zcode-protocol-v4";
import { buildTurnHeaderRow, mapTurnResultToHeaderState } from "./projection-rows.js";
import {
  completeWorkSegments,
  controlPatch,
  findRow,
  ms,
  rowBase,
  turnHeaderForEvent,
  turnIdOf,
} from "./product-projection-primitives.js";
import {
  activeMsForCompletion,
  leaveDraftAfterControlOnlyTurn,
} from "./product-projection-turn-facts.js";

export function onTurnComplete(state: ProjectionState, event: SessionEvent): ConversationDelta[] {
  const payload = event.payload as TurnCompletePayload;
  state.outputContinuationTextRowId = null;
  const headerState = mapTurnResultToHeaderState(payload.resultType);
  const header = turnHeaderForEvent(state, event);
  if (header?.executionKind === "controlOnly") {
    // controlOnly 没有 Agent 工时；尤其不能把 duration=0 下发给旧 UI，后者会为了
    // 可读性把 0 秒格式化成“已工作 1 秒”。这里只收口可见轮次，不碰 session control——
    // 除了 draft 的离场（见 leaveDraftAfterControlOnlyTurn）。
    const deltas = [
      ...upsertTurnHeader(state, event, headerState, undefined, payload.historyRoundCount),
      ...leaveDraftAfterControlOnlyTurn(
        state,
        payload.resultType === "success" ? "completedSuccess" : "completedInterrupted",
      ),
    ];
    state.currentTurnId = null;
    // turn 收口后 model-only 标记随之失效，避免影响下一次归属判断。
    state.currentTurnStartedModelOnly = false;
    return deltas;
  }
  const phase: SessionControl["phase"] =
    payload.resultType === "success"
      ? "completedSuccess"
      : payload.resultType === "cancelled"
        ? "completedInterrupted"
        : "error";
  const streamClose = payload.resultType === "success" ? "complete" : "interrupted";

  // stopPausesActiveGoalTarget：stop 作用于任何 foreground work 时，
  // active/verifying 的 goal 强制进入 paused，等待显式 resumeGoal。
  const goal = state.snapshot.goal;
  const pausedGoal: GoalState | undefined =
    payload.resultType === "cancelled" &&
    (goal?.status === "active" || goal?.status === "verifying")
      ? { ...goal, status: "paused" }
      : undefined;

  // stopKeepsQueueAndDisablesAutoDrain（stop 效果）：中断后 queue 原样保留
  // 且不自动消费 → 形成暂停队列；pauseReason 只用于 UI 解释原因，不参与路由裁决。
  const heldQueue =
    payload.resultType === "cancelled" &&
    payload.preserveQueueAutoDrainOnCancel !== true &&
    state.snapshot.queue.items.length > 0 &&
    (state.snapshot.queue.autoDrain || state.snapshot.queue.pauseReason !== "stopped")
      ? {
          ...state.snapshot.queue,
          autoDrain: false,
          pauseReason: "stopped" as const,
        }
      : undefined;

  const deltas: ConversationDelta[] = [
    ...closeStreamingRows(state, streamClose),
    // turn 终态一并收口在飞的 foreground tool row（收口不变量：被 profile
    // 过滤的 inputText 流必须被不可过滤的 row.upserted 蕴含，见 profiles.ts）。
    ...closeOpenToolRows(state, event, payload.resultType === "cancelled" ? "cancelled" : "error"),
    ...upsertTurnHeader(
      state,
      event,
      headerState,
      activeMsForCompletion(state, event, payload.duration),
      payload.historyRoundCount,
    ),
    ...(payload.resultType === "success" ? markStableForkAssistant(state, event) : []),
    {
      op: "state.updated",
      patch: controlPatch(
        state,
        {
          phase,
          sessionEnded: phase !== "error",
          canStop: false,
          stopState: "idle",
          stopTargetKind: "unknown",
          activeWorks: [],
          // 旧 V4 reducer 没有消费 ModelNetworkStatus，补投影后若 turn
          // 直接进入终态仍不清理，会让“重新连接中”残留到下一轮。
          apiRetry: null,
        },
        pausedGoal,
        heldQueue,
      ),
    },
  ];
  state.currentTurnId = null;
  // turn 收口后 model-only 标记随之失效，避免影响下一次归属判断。
  state.currentTurnStartedModelOnly = false;
  return deltas;
}

/**
 * queue drain 边界 = product turn 边界（同一 runtimeTurn 内）。
 * 收口上一段 productTurn 的 header（工时按边界拆分，加和 = 总工时），
 * 映射 runtimeTurnId → 新 productTurnId，开新 turnHeader。
 */
export function splitProductTurn(
  state: ProjectionState,
  event: SessionEvent,
  runtimeTurnId: string,
  promotedUserMessageId?: string,
): ConversationDelta[] {
  const deltas: ConversationDelta[] = [];
  const previousProductTurnId =
    state.productTurnIdByRuntimeTurnId.get(runtimeTurnId) ?? runtimeTurnId;
  const headerRowId = state.turnHeaderRowIdByTurnId.get(previousProductTurnId);
  const headerRow = headerRowId !== undefined ? findRow(state, headerRowId) : undefined;
  if (headerRow?.kind === "turnHeader") {
    const endedAt = ms(event);
    deltas.push({
      op: "row.upserted",
      row: {
        ...headerRow,
        state: "completedSuccess",
        endedAt,
        activeMs: Math.max(
          0,
          endedAt - (state.currentProductTurnStartedAtMs ?? headerRow.startedAt),
        ),
        ...(headerRow.workSegments
          ? {
              workSegments: completeWorkSegments(headerRow.workSegments, endedAt),
            }
          : {}),
      },
    });
  }
  const ordinal = (state.productTurnSplitOrdinalByRuntimeTurnId.get(runtimeTurnId) ?? 0) + 1;
  state.productTurnSplitOrdinalByRuntimeTurnId.set(runtimeTurnId, ordinal);
  // 旧实现用 runtimeTurnId + 本次进程内 ordinal 造 productTurnId；
  // cold hydration 会改用 hydrate-turn-N，同一条 queue 输入恢复前后无法保持身份。
  // promotion 已产生持久 user messageId，新 product turn 必须直接使用该权威身份；
  // 只有 legacy drain 缺 messageId 时才保留 ordinal fallback。
  const productTurnId = promotedUserMessageId ?? `${runtimeTurnId}~q${ordinal}`;
  state.productTurnIdByRuntimeTurnId.set(runtimeTurnId, productTurnId);
  state.runtimeTurnIdByProductTurnId.set(productTurnId, runtimeTurnId);
  state.currentProductTurnStartedAtMs = ms(event);
  const header = buildTurnHeaderRow(rowBase(state, event, productTurnId, productTurnId), {
    turnNumber: 0,
    input: "",
  });
  state.turnHeaderRowIdByTurnId.set(productTurnId, header.rowId);
  deltas.push({ op: "row.appended", row: header });
  return deltas;
}

export function upsertTurnHeader(
  state: ProjectionState,
  event: SessionEvent,
  resultState: "completedSuccess" | "completedInterrupted" | "failed",
  activeMs?: number,
  historyRoundCount?: number,
): ConversationDelta[] {
  const row = turnHeaderForEvent(state, event);
  if (!row) return [];
  const endedAt = ms(event);
  return [
    {
      op: "row.upserted",
      row: {
        ...row,
        state: resultState,
        endedAt,
        ...(activeMs !== undefined ? { activeMs } : {}),
        ...(historyRoundCount !== undefined ? { historyRoundCount } : {}),
        ...(row.workSegments
          ? {
              workSegments: completeWorkSegments(row.workSegments, endedAt),
            }
          : {}),
      },
    },
  ];
}

export function openGuidedWorkSegment(
  state: ProjectionState,
  event: SessionEvent,
  triggerEntityId: string,
): ConversationDelta[] {
  const row = turnHeaderForEvent(state, event);
  if (!row || row.executionKind === "controlOnly") return [];
  const startedAt = ms(event);
  const existingSegments: TurnWorkSegment[] = row.workSegments ?? [
    {
      segmentId: `${row.turnId}:initial`,
      startedAt: row.startedAt,
    },
  ];
  // 旧 UI 为整个 product turn 只维护一个折叠状态，accepted guide 只能
  // 作为普通行插入，无法恢复独立工作区。分段边界必须由 CLI 记录，React 不能按邻接行猜。
  const workSegments = [
    ...completeWorkSegments(existingSegments, startedAt),
    {
      segmentId: triggerEntityId,
      triggerEntityId,
      startedAt,
    },
  ];
  return [{ op: "row.upserted", row: { ...row, workSegments } }];
}

function markStableForkAssistant(state: ProjectionState, event: SessionEvent): ConversationDelta[] {
  const turnId = turnIdOf(state, event);
  const rows = state.snapshot.rows.window;
  const headerRowId = state.turnHeaderRowIdByTurnId.get(turnId);
  const headerIndex = headerRowId === undefined ? undefined : state.rowIndexById.get(headerRowId);
  const startIndex = headerIndex === undefined ? 0 : headerIndex + 1;
  let row: AssistantTextRow | undefined;
  // 性能问题根因：旧实现每个成功 turn 都复制并反转完整历史 rows，冷恢复会累积为
  // 近似 O(turns * rows) 的分配与扫描。当前 turn 的行只会出现在自身 header 之后。
  for (let index = rows.length - 1; index >= startIndex; index -= 1) {
    const candidate = rows[index];
    if (candidate?.kind !== "assistantText" || candidate.turnId !== turnId) continue;
    row = candidate;
    break;
  }
  if (!row || !state.messageIdByRowId.has(row.rowId)) return [];
  return [
    {
      op: "row.upserted",
      row: {
        ...row,
        state: "complete",
        actions: { ...row.actions, canFork: true },
      },
    },
  ];
}
