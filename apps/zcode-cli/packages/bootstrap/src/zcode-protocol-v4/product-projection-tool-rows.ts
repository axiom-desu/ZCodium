// tool call 行与流式 tool input 预览 reducer。
//
// 只接收 `Pick<ProjectionState, ...>` 窄端口，原地写 snapshot 与派生索引；
// 不新增第二份状态，事件次序仍由 ProductProjection.applyEventInternal 仲裁。
import type { SessionEvent } from "@zcode/contracts";
import {
  ZCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS,
  isZCodeFileStreamingToolInputPreviewTool,
} from "@zcode/shared";
import type { ConversationDelta, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { stringifyToolInput } from "./product-projection-ask-user.js";
import type { CanonicalModelStream } from "./event-normalizer.js";
import {
  appendProjectionRowBase,
  findProjectionRow,
  projectionMs,
  projectionTurnIdOf,
  type ProjectionState,
} from "./product-projection-state.js";
import { shouldHideInvalidToolCallFromProduct } from "../tool-call-product-visibility.js";

type ToolRowWritePort = Pick<
  ProjectionState,
  | "snapshot"
  | "rowIndexById"
  | "nextRowId"
  | "currentTurnId"
  | "productTurnIdByRuntimeTurnId"
  | "entityIdByRowId"
  | "toolRowIdByCallId"
  | "openForegroundToolCallIds"
  | "fileToolInputPreviewByCallId"
>;

export function isOpenForegroundToolRow(row: ToolCallRow): boolean {
  return (
    row.backgrounded !== true &&
    (row.status === "inputStreaming" ||
      row.status === "pendingApproval" ||
      row.status === "running")
  );
}

export function findToolRow(
  projection: Pick<ProjectionState, "snapshot" | "rowIndexById" | "toolRowIdByCallId">,
  toolCallId: string,
): ToolCallRow | undefined {
  const rowId = projection.toolRowIdByCallId.get(toolCallId);
  if (rowId === undefined) return undefined;
  const row = findProjectionRow(projection, rowId);
  return row?.kind === "toolCall" ? row : undefined;
}

export function openToolRow(
  projection: ToolRowWritePort,
  event: SessionEvent,
  payload: CanonicalModelStream,
  entityId?: string,
): ConversationDelta[] {
  const toolCallId = String(payload.toolCallId ?? "");
  if (
    toolCallId === "" ||
    shouldHideInvalidToolCallFromProduct(payload.toolName) ||
    projection.toolRowIdByCallId.has(toolCallId)
  ) {
    return [];
  }
  const row: ToolCallRow = {
    ...appendProjectionRowBase(
      projection,
      event,
      projectionTurnIdOf(projection, event),
      toolCallId,
    ),
    kind: "toolCall",
    ...(payload.assistantResponseId ? { assistantResponseId: payload.assistantResponseId } : {}),
    toolCallId,
    toolName: payload.toolName ?? "",
    status: "inputStreaming",
    inputText: "",
  };
  projection.toolRowIdByCallId.set(toolCallId, row.rowId);
  if (isZCodeFileStreamingToolInputPreviewTool(row.toolName)) {
    projection.fileToolInputPreviewByCallId.set(toolCallId, {
      lastPublishedAt: null,
      pendingAppend: "",
    });
  }
  if (entityId) projection.entityIdByRowId.set(row.rowId, entityId);
  return [{ op: "row.appended", row }];
}

export function appendStreamingToolInput(
  projection: ToolRowWritePort,
  event: SessionEvent,
  payload: CanonicalModelStream,
): ConversationDelta[] {
  const toolCallId = String(payload.toolCallId ?? "");
  const rowId = projection.toolRowIdByCallId.get(toolCallId);
  if (rowId === undefined) return [];
  const preview = projection.fileToolInputPreviewByCallId.get(toolCallId);
  if (!preview) {
    return [{ op: "row.delta", rowId, path: "inputText", append: payload.delta }];
  }

  preview.pendingAppend += payload.delta;
  const now = projectionMs(event);
  if (
    preview.lastPublishedAt !== null &&
    now - preview.lastPublishedAt < ZCODE_FILE_STREAMING_TOOL_INPUT_PREVIEW_MIN_INTERVAL_MS
  ) {
    return [];
  }

  const append = preview.pendingAppend;
  preview.pendingAppend = "";
  preview.lastPublishedAt = now;
  return append === "" ? [] : [{ op: "row.delta", rowId, path: "inputText", append }];
}

export function flushStreamingToolInput(
  projection: ToolRowWritePort,
  toolCallId: string,
): ConversationDelta[] {
  const append = takePendingStreamingToolInput(projection, toolCallId);
  if (append === "") return [];
  const rowId = projection.toolRowIdByCallId.get(toolCallId);
  return rowId === undefined ? [] : [{ op: "row.delta", rowId, path: "inputText", append }];
}

function takePendingStreamingToolInput(
  projection: Pick<ProjectionState, "fileToolInputPreviewByCallId">,
  toolCallId: string,
): string {
  const preview = projection.fileToolInputPreviewByCallId.get(toolCallId);
  projection.fileToolInputPreviewByCallId.delete(toolCallId);
  return preview?.pendingAppend ?? "";
}

export function finalizeStreamingToolInput(
  projection: ToolRowWritePort,
  event: SessionEvent,
  payload: CanonicalModelStream,
): ConversationDelta[] {
  const toolCallId = String(payload.toolCallId ?? "");
  if (toolCallId === "") return [];
  projection.fileToolInputPreviewByCallId.delete(toolCallId);
  if (shouldHideInvalidToolCallFromProduct(payload.toolName)) return [];
  const inputText = stringifyToolInput(payload.input);
  const existing = findToolRow(projection, toolCallId);
  if (existing) {
    return [
      {
        op: "row.upserted",
        row: {
          ...existing,
          ...(payload.assistantResponseId
            ? { assistantResponseId: payload.assistantResponseId }
            : {}),
          toolName: existing.toolName || payload.toolName || "",
          inputText,
          input: payload.input,
        },
      },
    ];
  }

  const row: ToolCallRow = {
    ...appendProjectionRowBase(
      projection,
      event,
      projectionTurnIdOf(projection, event),
      toolCallId,
    ),
    kind: "toolCall",
    ...(payload.assistantResponseId ? { assistantResponseId: payload.assistantResponseId } : {}),
    toolCallId,
    toolName: payload.toolName ?? "",
    status: "inputStreaming",
    inputText,
    input: payload.input,
  };
  projection.toolRowIdByCallId.set(toolCallId, row.rowId);
  return [{ op: "row.appended", row }];
}

// turn 终态收口所有 foreground 未终态 tool row（迟到终态不复活由 isRunning 闸保证）；
// `only` 让 stream recovery 只收口未定稿的那一部分。
export function closeOpenToolRows(
  projection: ToolRowWritePort,
  event: SessionEvent,
  status: "cancelled" | "error",
  only?: (row: ToolCallRow) => boolean,
): ConversationDelta[] {
  if (projection.openForegroundToolCallIds.size === 0) return [];
  const openRows: ToolCallRow[] = [];
  for (const toolCallId of projection.openForegroundToolCallIds) {
    const row = findToolRow(projection, toolCallId);
    // 派生索引不能成为第二份权威状态；收口前始终以当前 snapshot row 复核。
    if (!row || !isOpenForegroundToolRow(row)) continue;
    if (only && !only(row)) continue;
    openRows.push(row);
  }
  if (openRows.length === 0) return [];
  // Set 可能因迟到 reopen 改变插入顺序；rowId 单调递增，排序后保持旧 timeline delta 顺序。
  if (openRows.length > 1) {
    openRows.sort((left, right) => left.rowId - right.rowId);
  }
  const deltas: ConversationDelta[] = [];
  const closedToolCallIds = new Set<string>();
  for (const row of openRows) {
    const next: ToolCallRow = {
      ...row,
      status,
      inputText: `${row.inputText ?? ""}${takePendingStreamingToolInput(
        projection,
        row.toolCallId,
      )}`,
      endedAt: projectionMs(event),
    };
    delete next.approvalInteractionId;
    if (status === "error") {
      // executor 早退或事件缺失时，旧投影只在 stop 路径收口工具；
      // success/error turn 会留下运行态行，cold snapshot 缺 header 后被 UI 误判为 thinking。
      next.error = {
        code: "fault.runtime.toolLifecycleIncomplete",
        message: "Tool call ended without a terminal event.",
      };
    } else {
      delete next.error;
    }
    closedToolCallIds.add(row.toolCallId);
    deltas.push({ op: "row.upserted", row: next });
  }

  const pendingInteractions = projection.snapshot.pendingInteractions.filter(
    (interaction) =>
      !(
        (interaction.payload.kind === "permission" || interaction.payload.kind === "userInput") &&
        typeof interaction.payload.toolCallId === "string" &&
        closedToolCallIds.has(interaction.payload.toolCallId)
      ),
  );
  if (pendingInteractions.length !== projection.snapshot.pendingInteractions.length) {
    deltas.push({ op: "state.updated", patch: { pendingInteractions } });
  }
  return deltas;
}
