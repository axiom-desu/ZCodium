// assistant 文本/思考流式行 reducer。
//
// 只接收 `Pick<ProjectionState, ...>` 窄端口并原地写同一实例；不持有第二份事实，
// 不复制 snapshot，事件次序仍由 ProductProjection.applyEventInternal 仲裁。
import type { AssistantFeedbackUpdatedPayload, SessionEvent } from "@zcode/contracts";
import type {
  AssistantTextRow,
  ConversationDelta,
  ReasoningRow,
} from "@zcode/shared/zcode-protocol-v4";
import type { CanonicalAssistantSegmentFact } from "./event-normalizer.js";
import {
  appendProjectionRowBase,
  findProjectionRow,
  projectionTurnIdOf,
  type ProjectionState,
} from "./product-projection-state.js";

type TextRowPort = Pick<
  ProjectionState,
  | "snapshot"
  | "rowIndexById"
  | "nextRowId"
  | "streamingTextRowId"
  | "outputContinuationTextRowId"
  | "entityIdByRowId"
  | "messageIdByRowId"
  | "outputContinuationRowIdByMessageId"
  | "currentTurnId"
  | "productTurnIdByRuntimeTurnId"
>;

type ReasoningRowPort = Pick<
  ProjectionState,
  | "snapshot"
  | "rowIndexById"
  | "nextRowId"
  | "streamingReasoningRowId"
  | "entityIdByRowId"
  | "currentTurnId"
  | "productTurnIdByRuntimeTurnId"
>;

export function closeTextRow(
  projection: Pick<ProjectionState, "snapshot" | "rowIndexById" | "streamingTextRowId">,
  state: "complete" | "interrupted",
): ConversationDelta[] {
  if (projection.streamingTextRowId === null) return [];
  const row = findProjectionRow(projection, projection.streamingTextRowId);
  projection.streamingTextRowId = null;
  if (row?.kind !== "assistantText") return [];
  return [{ op: "row.upserted", row: { ...row, state } }];
}

export function openTextRow(
  projection: TextRowPort,
  event: SessionEvent,
  fact: CanonicalAssistantSegmentFact,
): ConversationDelta[] {
  const close = closeTextRow(projection, "complete");
  const continuationRowId = projection.outputContinuationTextRowId;
  projection.outputContinuationTextRowId = null;
  const continuationRow =
    continuationRowId === null ? undefined : findProjectionRow(projection, continuationRowId);
  const currentTurnId = projectionTurnIdOf(projection, event);
  const lastVisibleRow = projection.snapshot.rows.window.at(-1);
  if (
    continuationRow?.kind === "assistantText" &&
    continuationRow.turnId === currentTurnId &&
    lastVisibleRow?.rowId === continuationRow.rowId
  ) {
    // runtime 的 output-token Continue 会为每次 provider 请求创建新的
    // assistantMessageId；旧投影因此把一句话拆成 history partial + 轮尾正文。length
    // 已经在 ModelComplete 上提供精确资格，这里只重新打开紧邻的同 turn text row，
    // 让外部 continuous/replayable 客户端都只观察到一条持续增长的 assistant。
    const {
      actions: _actions,
      assistantResponseId: _assistantResponseId,
      feedback: _feedback,
      ...continuedBase
    } = continuationRow;
    const row: AssistantTextRow = {
      ...continuedBase,
      entityId: fact.entityId,
      ...(fact.stream.assistantResponseId
        ? { assistantResponseId: fact.stream.assistantResponseId }
        : {}),
      state: "streaming",
    };
    projection.streamingTextRowId = row.rowId;
    projection.entityIdByRowId.set(row.rowId, fact.entityId);
    const previousMessageId = projection.messageIdByRowId.get(row.rowId);
    if (previousMessageId) {
      projection.outputContinuationRowIdByMessageId.set(previousMessageId, row.rowId);
    }
    if (fact.transcriptMessageId) {
      projection.messageIdByRowId.set(row.rowId, fact.transcriptMessageId);
    }
    return [...close, { op: "row.upserted", row }];
  }

  // 不变量：非 output-token Continue 的新段必然新 rowId；已有 streaming 行先收口。
  const row: AssistantTextRow = {
    ...appendProjectionRowBase(
      projection,
      event,
      projectionTurnIdOf(projection, event),
      fact.entityId,
    ),
    kind: "assistantText",
    ...(fact.stream.assistantResponseId
      ? { assistantResponseId: fact.stream.assistantResponseId }
      : {}),
    text: "",
    state: "streaming",
  };
  projection.streamingTextRowId = row.rowId;
  projection.entityIdByRowId.set(row.rowId, fact.entityId);
  // forkAssistant 锚点：assistant 行 → 权威 messageId（provider 流首帧即带）。
  if (fact.transcriptMessageId) {
    projection.messageIdByRowId.set(row.rowId, fact.transcriptMessageId);
  }
  return [...close, { op: "row.appended", row }];
}

export function openReasoningRow(
  projection: ReasoningRowPort,
  event: SessionEvent,
  fact: CanonicalAssistantSegmentFact,
): ConversationDelta[] {
  const close = closeReasoningRow(projection, "complete");
  const row: ReasoningRow = {
    ...appendProjectionRowBase(
      projection,
      event,
      projectionTurnIdOf(projection, event),
      fact.entityId,
    ),
    kind: "reasoning",
    // Bug 原因：canonical stream 已携带 assistant response 身份，但旧投影只在正文与工具行
    // 保存它，UI 因而无法把同 response 的 reasoning 确定性归入 CUA Group。
    ...(fact.stream.assistantResponseId
      ? { assistantResponseId: fact.stream.assistantResponseId }
      : {}),
    text: "",
    state: "streaming",
  };
  projection.streamingReasoningRowId = row.rowId;
  projection.entityIdByRowId.set(row.rowId, fact.entityId);
  return [...close, { op: "row.appended", row }];
}

export function closeReasoningRow(
  projection: Pick<ProjectionState, "snapshot" | "rowIndexById" | "streamingReasoningRowId">,
  state: "complete" | "interrupted" = "complete",
): ConversationDelta[] {
  if (projection.streamingReasoningRowId === null) return [];
  const row = findProjectionRow(projection, projection.streamingReasoningRowId);
  projection.streamingReasoningRowId = null;
  if (row?.kind !== "reasoning") return [];
  return [{ op: "row.upserted", row: { ...row, state } }];
}

export function closeStreamingRows(
  projection: TextRowPort & ReasoningRowPort,
  state: "complete" | "interrupted",
): ConversationDelta[] {
  return [...closeTextRow(projection, state), ...closeReasoningRow(projection, state)];
}

export function applyAssistantFeedbackUpdated(
  projection: Pick<ProjectionState, "snapshot">,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as AssistantFeedbackUpdatedPayload;
  const row = projection.snapshot.rows.window.find(
    (candidate): candidate is AssistantTextRow =>
      candidate.kind === "assistantText" && candidate.entityId === payload.entityId,
  );
  if (!row) return [];
  if (payload.feedback === null) {
    if (row.feedback === undefined) return [];
    const { feedback: _removedFeedback, ...withoutFeedback } = row;
    return [{ op: "row.upserted", row: withoutFeedback }];
  }
  if (row.feedback === payload.feedback) return [];
  return [{ op: "row.upserted", row: { ...row, feedback: payload.feedback } }];
}
