import type { SessionEvent } from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import { clearSettledOutputPreviews } from "./product-projection-bash-progress.js";
import type { ProjectionState } from "./product-projection-state.js";
import { applyAssistantFeedbackUpdated } from "./product-projection-stream.js";
import type {
  AssistantTextRow,
  ConversationDelta,
  ConversationRow,
} from "@zcode/shared/zcode-protocol-v4";
import {
  applyConversationDeltas,
  applyConversationDeltasMutable,
  createMutableConversationSnapshotAccumulator,
} from "@zcode/shared/zcode-protocol-v4";
import {
  normalizeConversationEvent,
  type CanonicalOpenSegmentIdentity,
} from "./event-normalizer.js";
import { deltaBumpsRevision } from "./projection-state.js";
import {
  openSegmentIdentity,
  stringPayload,
  updateRowIndexAfterImmutableApply,
  updateToolIndexesAfterDeltas,
} from "./product-projection-primitives.js";
import {
  materializeSubagentProjection,
  shouldMaterializeSubagentProjection,
} from "./product-projection-subagents.js";
import { reduce } from "./product-projection-reduce.js";

/** 应用一个权威事件，返回该事件产生的 delta 序列（可能为空）。 */
export function applyEventImpl(state: ProjectionState, event: SessionEvent): ConversationDelta[] {
  return applyEventInternal(state, event, true);
}

/**
 * 冷恢复批量路径只允许在尚未发布的候选 projection 上使用。begin 后 rows.window
 * 原地推进，避免每个事件复制增长数组；publisher 在完整校验通过前不会 adopt 候选。
 */
export function beginHydrationReplayImpl(
  state: Pick<ProjectionState, "hydrationAccumulator" | "rowIndexById" | "snapshot">,
): void {
  if (state.hydrationAccumulator) throw new Error("hydration replay already active");
  state.hydrationAccumulator = createMutableConversationSnapshotAccumulator(state.snapshot);
  state.snapshot = state.hydrationAccumulator.snapshot;
  state.rowIndexById = state.hydrationAccumulator.rowIndexById;
}

export function applyHydrationEventImpl(
  state: ProjectionState,
  event: SessionEvent,
): ConversationDelta[] {
  if (!state.hydrationAccumulator) throw new Error("hydration replay is not active");
  return applyEventInternal(state, event, false);
}

/**
 * 把批量期间延迟的 command actions 收敛到当前快照。actions 是同一 reducer 的派生
 * materialization，不单独递增 revision；触发它变化的结构/guard 事件已经记账。
 */
export function completeHydrationReplayImpl(
  state: Pick<
    ProjectionState,
    | "currentEditableEntityId"
    | "editTargetByEntityId"
    | "entityIdByRowId"
    | "hydrationAccumulator"
    | "messageIdByRowId"
    | "snapshot"
    | "turnHeaderRowIdByTurnId"
  >,
): ConversationDelta[] {
  if (!state.hydrationAccumulator) throw new Error("hydration replay is not active");
  const deltas = materializeCommandRowActions(state, []);
  applyConversationDeltasMutable(state.hydrationAccumulator, deltas);
  state.hydrationAccumulator = null;
  return deltas;
}

function applyEventInternal(
  state: ProjectionState,
  event: SessionEvent,
  materializeActions: boolean,
): ConversationDelta[] {
  if (event.type === SessionEventType.SubagentSpawned) {
    const childSessionId = stringPayload(
      event.payload as Record<string, unknown>,
      "childSessionId",
    );
    // live spawn 已经过 core persist-before-publish 闸门；若它是旧 ghost 的合法 resume，
    // 以新事件恢复资格。hydration 期间 seed 尚未建立排除集合，不会误放历史引用。
    if (childSessionId) state.invalidSubagentChildSessionIds.delete(childSessionId);
  }
  const runtimeTurnId = String(event.turnId ?? state.currentTurnId ?? "turn-unknown");
  const productTurnId =
    event.type === SessionEventType.TurnStarted
      ? undefined
      : (state.productTurnIdByRuntimeTurnId.get(runtimeTurnId) ?? runtimeTurnId);
  const reduced =
    event.type === SessionEventType.AssistantFeedbackUpdated
      ? applyAssistantFeedbackUpdated(state, event)
      : (() => {
          const fact = normalizeConversationEvent(event, {
            productTurnId,
            openAssistantSegments: openAssistantSegments(state),
          });
          state.normalizationDiagnostics.push(...fact.diagnostics);
          return reduce(state, fact);
        })();
  const subagentDeltas = shouldMaterializeSubagentProjection(state, reduced)
    ? materializeSubagentProjection(state, reduced)
    : [];
  const reducedWithSubagents = [...reduced, ...subagentDeltas];
  // row、命令 target 与 actions 必须属于同一个 materialization transaction。
  // 旧实现只维护 side-map/最新行判断，UI action 由别处推断，cold/tool-only/failed
  // 轮会出现“入口可见但 target 不可解析”，新目标出现后旧入口也不会撤销。
  const deltas = materializeActions
    ? [...reducedWithSubagents, ...materializeCommandRowActions(state, reducedWithSubagents)]
    : reducedWithSubagents;
  const finalDeltas = attachRevision(state, clearSettledOutputPreviews(deltas));
  if (state.hydrationAccumulator) {
    applyConversationDeltasMutable(state.hydrationAccumulator, finalDeltas);
    state.snapshot.seq = event.sequenceNumber;
  } else {
    const previousRowsLength = state.snapshot.rows.window.length;
    state.snapshot = {
      ...applyConversationDeltas(state.snapshot, finalDeltas),
      seq: event.sequenceNumber,
    };
    updateRowIndexAfterImmutableApply(state, previousRowsLength, finalDeltas);
  }
  updateToolIndexesAfterDeltas(state, finalDeltas);
  return finalDeltas;
}

/**
 * 基于本事件归约后的 prospective rows 原子生成 edit/retry actions。
 * action=true 必须蕴含命令层同 revision 下能解析出持久 message target；最新目标
 * 改变时同时 upsert 旧、新两行，客户端不需要按数组位置补推断。
 */
function materializeCommandRowActions(
  state: Pick<
    ProjectionState,
    | "currentEditableEntityId"
    | "editTargetByEntityId"
    | "entityIdByRowId"
    | "messageIdByRowId"
    | "snapshot"
    | "turnHeaderRowIdByTurnId"
  >,
  reduced: ConversationDelta[],
): ConversationDelta[] {
  const prospective = applyConversationDeltas(state.snapshot, reduced);
  const rows = prospective.rows.window;
  const rowById = new Map(rows.map((row) => [row.rowId, row]));
  const latestAssistantRowIdByTurn = new Map<string, number>();
  for (const row of rows) {
    if (row.kind !== "assistantText") continue;
    const current = latestAssistantRowIdByTurn.get(row.turnId);
    if (current === undefined || row.rowId > current) {
      latestAssistantRowIdByTurn.set(row.turnId, row.rowId);
    }
  }
  const compactActive = prospective.control.activeWorks.some((work) => work.kind === "compact");
  const completionBlockingActive = prospective.control.activeWorks.length > 0;
  let latestEditable: ConversationRow | undefined;
  let latestAssistant: AssistantTextRow | undefined;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (
      !latestEditable &&
      !compactActive &&
      row.kind === "userInput" &&
      row.origin === "realUser"
    ) {
      latestEditable = row;
    }
    if (!latestAssistant && row.kind === "assistantText") {
      latestAssistant = row;
    }
    if (latestEditable && latestAssistant) break;
  }
  // 旧逻辑只按“最新完整 assistant”挑 retry，background result 的
  // synthetic turn 因此会错误获得入口；若只在 find 条件里过滤 synthetic，又会跳过
  // 最新 background assistant，让更早真实用户轮的 retry 复活。这里必须先锁定全时间线
  // 最新 assistant，再校验同轮 realUser canonical cause，保证普通 retry 不跨轮回退。
  const latestRetryable = (() => {
    if (
      completionBlockingActive ||
      !latestAssistant ||
      latestAssistant.state !== "complete" ||
      !state.messageIdByRowId.has(latestAssistant.rowId)
    ) {
      return undefined;
    }
    const headerId = state.turnHeaderRowIdByTurnId.get(latestAssistant.turnId);
    const header = headerId === undefined ? undefined : rowById.get(headerId);
    if (header?.kind !== "turnHeader" || header.state === "running") return undefined;
    const canonicalUserRow = rows.find(
      (row) =>
        row.turnId === latestAssistant.turnId &&
        row.kind === "userInput" &&
        row.origin === "realUser",
    );
    const canonicalUserEntityId = canonicalUserRow
      ? state.entityIdByRowId.get(canonicalUserRow.rowId)
      : undefined;
    if (!canonicalUserEntityId || !state.editTargetByEntityId.has(canonicalUserEntityId)) {
      return undefined;
    }
    return latestAssistant;
  })();
  const latestEditableEntityId =
    latestEditable === undefined ? null : (state.entityIdByRowId.get(latestEditable.rowId) ?? null);
  // edit action 与命令 resolver 必须共用 canonical target authority。过去 drain 分支只
  // 登记 messageId，UI 因而显示 Edit，但提交必被 resolver 以 actionUnavailable 拒绝。
  const latestEditableRowId =
    latestEditable &&
    latestEditableEntityId &&
    state.messageIdByRowId.has(latestEditable.rowId) &&
    state.editTargetByEntityId.has(latestEditableEntityId)
      ? latestEditable.rowId
      : null;
  // entity target 历史表会保留旧记录；仅撤销 row action 不足以阻止
  // entityId 直查绕过 latest-only 语义。当前可编辑 authority 与 actions 在同一次
  // materialization 中更新，resolver 不再遍历 rows，也不把 rowId 当 canonical key。
  state.currentEditableEntityId = latestEditableRowId === null ? null : latestEditableEntityId;
  const latestRetryableRowId = latestRetryable?.rowId ?? null;
  const deltas: ConversationDelta[] = [];

  for (const row of rows) {
    if (row.kind !== "turnHeader" && row.kind !== "userInput" && row.kind !== "assistantText")
      continue;
    const nextActions = { ...row.actions };
    if (row.kind === "turnHeader") {
      const canRewindFiles =
        !completionBlockingActive &&
        prospective.pendingInteractions.length === 0 &&
        row.state !== "running" &&
        row.fileChanges?.state === "active";
      if (canRewindFiles) nextActions.canRewindFiles = true;
      else delete nextActions.canRewindFiles;
    } else if (row.kind === "userInput") {
      if (row.rowId === latestEditableRowId) {
        nextActions.canEdit = true;
        nextActions.editDisposition = "rewind";
      } else {
        delete nextActions.canEdit;
        delete nextActions.editDisposition;
      }
    } else {
      if (row.rowId === latestRetryableRowId) nextActions.canRetry = true;
      else delete nextActions.canRetry;
      const headerId = state.turnHeaderRowIdByTurnId.get(row.turnId);
      const header = headerId === undefined ? undefined : rowById.get(headerId);
      const canFork =
        !compactActive &&
        row.state === "complete" &&
        header?.kind === "turnHeader" &&
        header.state === "completedSuccess" &&
        latestAssistantRowIdByTurn.get(row.turnId) === row.rowId &&
        state.messageIdByRowId.has(row.rowId);
      if (canFork) nextActions.canFork = true;
      else delete nextActions.canFork;
    }
    const actions = Object.keys(nextActions).length > 0 ? nextActions : undefined;
    if (JSON.stringify(actions) === JSON.stringify(row.actions)) continue;
    const nextRow: ConversationRow = { ...row, actions };
    if (!actions) delete nextRow.actions;
    deltas.push({ op: "row.upserted", row: nextRow });
  }
  return deltas;
}

// revision 递进：本事件含任一结构性 delta → revision +1，
// 且携带规则要求 deltas 中必含 state.updated.revision。
function attachRevision(
  state: Pick<ProjectionState, "snapshot">,
  deltas: ConversationDelta[],
): ConversationDelta[] {
  if (!deltas.some(deltaBumpsRevision)) return deltas;
  const revision = state.snapshot.revision + 1;
  const last = deltas[deltas.length - 1];
  if (last?.op === "state.updated") {
    return [...deltas.slice(0, -1), { op: "state.updated", patch: { ...last.patch, revision } }];
  }
  return [...deltas, { op: "state.updated", patch: { revision } }];
}

function openAssistantSegments(
  state: Pick<
    ProjectionState,
    "entityIdByRowId" | "messageIdByRowId" | "streamingReasoningRowId" | "streamingTextRowId"
  >,
): Partial<Record<"text" | "reasoning", CanonicalOpenSegmentIdentity>> {
  const segments: Partial<Record<"text" | "reasoning", CanonicalOpenSegmentIdentity>> = {};
  const text = openSegmentIdentity(state, state.streamingTextRowId);
  const reasoning = openSegmentIdentity(state, state.streamingReasoningRowId);
  if (text) segments.text = text;
  if (reasoning) segments.reasoning = reasoning;
  return segments;
}
