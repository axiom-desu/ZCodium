import type {
  SessionEvent,
  ToolCallErrorPayload,
  ToolCallProgressPayload,
  ToolCallResultPayload,
  ToolCallScheduledPayload,
  ToolCallStartedPayload,
} from "@zcode/contracts";
import { CoreErrorType } from "@zcode/contracts";
import { projectToolActivity } from "./product-projection-bash-progress.js";
import { extractPlanStepsFromToolInput, extractPlanStepsFromToolOutput } from "@zcode/shared";
import { stringifyToolInput, toProtocolToolCallDisplay } from "./product-projection-ask-user.js";
import type { ProjectionState } from "./product-projection-state.js";
import { findToolRow } from "./product-projection-tool-rows.js";
import type { ConversationDelta, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { shouldHideInvalidToolCallFromProduct } from "../tool-call-product-visibility.js";
import {
  parseListAppsSnapshot,
  readOfficialCuaAction,
  resolveCuaAppIdentity,
} from "./cua-app-snapshot.js";
import { buildToolOutput } from "./projection-rows.js";
import {
  isMirroredSubagentToolEvent,
  isRunning,
  ms,
  rowBase,
  turnIdOf,
} from "./product-projection-primitives.js";

// ── tool call 状态机 ──

export function onToolCallScheduled(
  state: ProjectionState,
  event: SessionEvent,
): ConversationDelta[] {
  if (isMirroredSubagentToolEvent(event) || !isRunning(state)) return [];
  const payload = event.payload as ToolCallScheduledPayload;
  const toolCallId = String(payload.toolCallId);
  state.fileToolInputPreviewByCallId.delete(toolCallId);
  if (shouldHideInvalidToolCallFromProduct(payload.toolName)) return [];
  const inputText = stringifyToolInput(payload.input);
  const cuaAction = readOfficialCuaAction(payload.toolName);
  const cuaApp =
    cuaAction && cuaAction !== "list_apps"
      ? resolveCuaAppIdentity(payload.input, state.latestListAppsSnapshot)
      : undefined;
  const existing = findToolRow(state, toolCallId);
  const planDeltas = todoPlanDeltas(
    state,
    event,
    extractPlanStepsFromToolInput({
      title: payload.toolName,
      kind: payload.toolName,
      input: payload.input,
    }),
  );
  if (existing) {
    // replayable 会过滤 row.delta(inputText)，定稿 upsert 必须携带完整 inputText。
    // 否则断线恢复只能看到结构化 input，丢失 v4 row 的输入文本终态。
    return [
      {
        op: "row.upserted",
        row: {
          ...existing,
          ...(payload.assistantMessageId
            ? { assistantResponseId: String(payload.assistantMessageId) }
            : {}),
          inputText,
          input: payload.input,
          ...(cuaApp ? { cuaApp } : {}),
          ...(payload.display?.kind === "mcp_tool" ? { display: payload.display } : {}),
        },
      },
      ...planDeltas,
    ];
  }
  const row: ToolCallRow = {
    ...rowBase(state, event, turnIdOf(state, event), toolCallId),
    kind: "toolCall",
    ...(payload.assistantMessageId
      ? { assistantResponseId: String(payload.assistantMessageId) }
      : {}),
    toolCallId,
    toolName: payload.toolName,
    status: "inputStreaming",
    inputText,
    input: payload.input,
    ...(cuaApp ? { cuaApp } : {}),
    ...(payload.display?.kind === "mcp_tool" ? { display: payload.display } : {}),
  };
  state.toolRowIdByCallId.set(toolCallId, row.rowId);
  return [{ op: "row.appended", row }, ...planDeltas];
}

export function onToolCallActivity(
  state: ProjectionState,
  event: SessionEvent,
): ConversationDelta[] {
  if (isMirroredSubagentToolEvent(event) || !isRunning(state)) return [];
  const payload = event.payload as ToolCallStartedPayload;
  const row = findToolRow(state, String(payload.toolCallId));
  if (!row) return [];
  return projectToolActivity(event, row);
}

/**
 * MCP `notifications/progress`（A8）→ 行上的 progress。只在 running 时写：
 * 终态之后迟到的进度通知不能把 success/error 行重新点亮；bash 的 stdout 字节进度不在这里消费。
 */
export function onToolCallProgress(
  state: ProjectionState,
  event: SessionEvent,
): ConversationDelta[] {
  if (isMirroredSubagentToolEvent(event) || !isRunning(state)) return [];
  const payload = event.payload as ToolCallProgressPayload;
  const row = findToolRow(state, String(payload.toolCallId));
  if (!row || row.status !== "running") return [];
  // 两个分支共用 ToolCallProgress：Bash 尾窗与 MCP 百分比必须分别投影，避免合并后互相覆盖。
  if (row.toolName === "Bash") return projectToolActivity(event, row);
  const total =
    typeof payload.total === "number" && Number.isFinite(payload.total) && payload.total > 0
      ? payload.total
      : undefined;
  const fraction =
    total !== undefined && typeof payload.progress === "number" && Number.isFinite(payload.progress)
      ? Math.min(1, Math.max(0, payload.progress / total))
      : undefined;
  const message =
    typeof payload.message === "string" && payload.message.trim().length > 0
      ? payload.message.trim().slice(0, 200)
      : undefined;
  if (fraction === undefined && message === undefined && total === undefined) return [];
  return [
    {
      op: "row.upserted",
      row: {
        ...row,
        progress: {
          ...(fraction !== undefined ? { fraction } : {}),
          ...(total !== undefined ? { total } : {}),
          ...(message !== undefined ? { message } : {}),
          updatedAt: ms(event),
        },
      },
    },
  ];
}

export function onToolCallResult(state: ProjectionState, event: SessionEvent): ConversationDelta[] {
  if (isMirroredSubagentToolEvent(event) || !isRunning(state)) return [];
  const payload = event.payload as ToolCallResultPayload;
  const toolCallId = String(payload.toolCallId);
  const row = findToolRow(state, toolCallId);
  if (!row) return [];
  const success = payload.result.success;
  if (success && readOfficialCuaAction(row.toolName) === "list_apps") {
    // 摘要身份必须来自 Agent 已观察到的成功事实；失败结果不能清空旧快照。
    const snapshot = parseListAppsSnapshot(payload.result.content, payload.result.display);
    if (snapshot) state.latestListAppsSnapshot = snapshot;
  }
  const display = toProtocolToolCallDisplay(payload.result.display);
  const next: ToolCallRow = {
    ...row,
    status: success ? "success" : "error",
    // 终态清除运行中进度（R7）。
    progress: undefined,
    output: buildToolOutput(payload.result, toolCallId),
    ...(display ? { display } : {}),
    endedAt: ms(event),
  };
  if (!success) {
    next.error = {
      code: payload.result.error?.type ?? "fault.runtime.toolFailed",
      message: payload.result.error?.message ?? "Tool execution failed.",
    };
  }
  const planDeltas = success
    ? todoPlanDeltas(
        state,
        event,
        extractPlanStepsFromToolOutput({
          title: row.toolName,
          kind: row.toolName,
          output: payload.result.content,
        }),
      )
    : [];
  return [{ op: "row.upserted", row: next }, ...planDeltas];
}

/**
 * TodoWrite 同时投影 live plan 与当前 goal iteration。
 * V4 之前只保留 tool row，右上角摘要无法在 live/cold 恢复后重建每轮 action/status。
 * 轮次只由 verifier boundary 推进；TodoWrite 只更新当前打开轮次，不能自行加一轮。
 */
function todoPlanDeltas(
  state: Pick<ProjectionState, "snapshot">,
  event: SessionEvent,
  steps: ReturnType<typeof extractPlanStepsFromToolInput>,
): ConversationDelta[] {
  if (!steps) return [];
  const items = steps.map((step, index) => ({
    id: step.id || `todo-${index + 1}`,
    content: step.title,
    status:
      step.status === "in_progress"
        ? ("inProgress" as const)
        : step.status === "completed"
          ? ("completed" as const)
          : ("pending" as const),
  }));
  const updatedAt = ms(event);
  const goal = state.snapshot.goal;
  if (!goal) {
    return [{ op: "state.updated", patch: { plan: { items, updatedAt } } }];
  }

  const iteration =
    goal.status === "verifying" || goal.status === "verified" || goal.status === "failed"
      ? Math.max(1, goal.iteration)
      : Math.max(1, goal.iteration + 1);
  const iterations = [
    ...goal.iterations.filter((entry) => entry.iteration !== iteration),
    { iteration, items, updatedAt },
  ].sort((left, right) => left.iteration - right.iteration);
  return [
    {
      op: "state.updated",
      patch: {
        goal: { ...goal, iterations },
        plan: { items, updatedAt },
      },
    },
  ];
}

export function onToolCallError(state: ProjectionState, event: SessionEvent): ConversationDelta[] {
  if (isMirroredSubagentToolEvent(event) || !isRunning(state)) return [];
  const payload = event.payload as ToolCallErrorPayload;
  const row = findToolRow(state, String(payload.toolCallId));
  if (!row) return [];
  const cancelled =
    payload.error.type === CoreErrorType.ToolCancelled || payload.error.code === "TOOL_CANCELLED";
  return [
    {
      op: "row.upserted",
      row: {
        ...row,
        // Stop 会先产生 tool_cancelled，再产生 cancelled turn；若先把工具
        // 终态写成 error，后续只收口 running row 的 turn reducer 无法纠正为 stopped。
        status: cancelled ? "cancelled" : "error",
        progress: undefined,
        ...(cancelled
          ? { error: undefined }
          : { error: { code: payload.error.type, message: payload.error.message } }),
        endedAt: ms(event),
      },
    },
  ];
}
