import type { HookRunLifecyclePayload, SessionEvent } from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import type { HookInvocationRowContent, ProjectionState } from "./product-projection-state.js";
import {
  hookExecutionDisplayName,
  hookExecutionOutcome,
  hookExecutionState,
  hookInvocationLane,
  hookInvocationState,
} from "./product-projection-hooks.js";
import type {
  ConversationDelta,
  HookExecutionProjection,
  HookInvocationRow,
} from "@zcode/shared/zcode-protocol-v4";
import {
  USER_PROMPT_HOOK_BLOCK_ERROR_TYPE,
  controlPatch,
  findRow,
  ms,
  rowBase,
  turnIdOf,
} from "./product-projection-primitives.js";

export function onHookRunLifecycle(
  state: ProjectionState,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as HookRunLifecyclePayload;
  const hookInvocationId = payload.hookInvocationId;
  const hookCount = payload.hookCount;
  if (
    !hookInvocationId ||
    !payload.hookRunId ||
    !Number.isInteger(hookCount) ||
    (hookCount ?? 0) <= 0 ||
    !Number.isInteger(payload.hookIndex) ||
    payload.hookIndex < 0
  ) {
    return [];
  }
  if (state.rewoundHookInvocationIds.has(hookInvocationId)) return [];

  const rowId = state.hookRowIdByInvocationId.get(hookInvocationId);
  const existing = rowId === undefined ? undefined : findRow(state, rowId);
  const existingRow = existing?.kind === "hookInvocation" ? existing : undefined;
  const pending = state.pendingSessionHookInvocations.get(hookInvocationId);
  const previousExecutions = existingRow?.executions ?? pending?.content.executions ?? [];
  const previousExecution = previousExecutions.find(
    (execution) => execution.hookRunId === payload.hookRunId,
  );
  const descriptor = payload.descriptor;
  if (
    !previousExecution &&
    (descriptor?.clientVisible !== true || descriptor.sourceKind === "internal")
  ) {
    return [];
  }
  const hookState = hookExecutionState(event.type);
  const startedAt =
    typeof payload.startedAt === "number" && Number.isFinite(payload.startedAt)
      ? payload.startedAt
      : (previousExecution?.startedAt ?? ms(event));
  const endedAt = hookState === "running" ? undefined : ms(event);
  const durationMs =
    typeof payload.durationMs === "number" && Number.isFinite(payload.durationMs)
      ? Math.max(0, payload.durationMs)
      : endedAt === undefined
        ? undefined
        : Math.max(0, endedAt - startedAt);
  const outcome = hookExecutionOutcome(event.type, payload.outcome);
  const didExecute =
    previousExecution?.didExecute === true || event.type === SessionEventType.HookRunStarted;
  const sourceKind = previousExecution?.sourceKind ?? descriptor?.sourceKind;
  if (sourceKind === undefined || sourceKind === "internal") return [];
  const blockReason = payload.blockReason ?? previousExecution?.blockReason;
  const execution: HookExecutionProjection = {
    hookRunId: String(payload.hookRunId),
    hookIndex: payload.hookIndex,
    didExecute,
    state: hookState,
    ...(outcome ? { outcome } : {}),
    ...(blockReason ? { blockReason } : {}),
    startedAt,
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    displayName:
      previousExecution?.displayName ??
      (descriptor
        ? hookExecutionDisplayName(descriptor, payload.hookIndex)
        : `Hook #${payload.hookIndex + 1}`),
    sourceKind,
    ...(previousExecution?.pluginName || descriptor?.pluginName
      ? { pluginName: previousExecution?.pluginName ?? descriptor?.pluginName }
      : {}),
    ...(payload.toolName || previousExecution?.toolName
      ? { toolName: payload.toolName ?? previousExecution?.toolName }
      : {}),
  };
  const byRunId = new Map(previousExecutions.map((candidate) => [candidate.hookRunId, candidate]));
  byRunId.set(execution.hookRunId, execution);
  const executions = [...byRunId.values()].toSorted(
    (left, right) => left.hookIndex - right.hookIndex,
  );
  const rowState = hookInvocationState(executions, hookCount as number);
  const invocationStartedAt = Math.min(...executions.map((candidate) => candidate.startedAt));
  const invocationEndedAt =
    rowState === "running"
      ? undefined
      : Math.max(...executions.map((candidate) => candidate.endedAt ?? candidate.startedAt));

  const content: HookInvocationRowContent = {
    kind: "hookInvocation",
    hookInvocationId,
    hookEventName: payload.hookEventName,
    hookCount: hookCount as number,
    state: rowState,
    startedAt: invocationStartedAt,
    ...(invocationEndedAt !== undefined
      ? {
          endedAt: invocationEndedAt,
          durationMs: Math.max(0, invocationEndedAt - invocationStartedAt),
        }
      : {}),
    lane: hookInvocationLane(payload.hookEventName),
    ...(payload.toolCallId ? { anchorToolCallId: String(payload.toolCallId) } : {}),
    executions,
  };

  if (existingRow) {
    const blockErrorDelta = hookBlockErrorDelta(state, event, payload, didExecute, blockReason);
    return [
      {
        op: "row.upserted",
        row: {
          ...existingRow,
          ...content,
        },
      },
      ...(blockErrorDelta ? [blockErrorDelta] : []),
    ];
  }

  if (
    pending ||
    !event.turnId ||
    // 维护 turn 排除只属于 SessionStart——首条输入即 /compact 时
    // SessionStart Hook 携带 compact turnId 到达，不能直挂，先入 pending 等
    // 真实 turn。model-only ≠ 维护 turn：background_task / subagent_message /
    // goal continuation 轮同样是 model-only，但它们是会真实跑工具的 agent 轮，
    // 其 PreToolUse/PostToolUse/Stop 必须按 event.turnId 直挂原轮（与 cold
    // merge 归属对齐），否则会被 pending 吞掉、错误堆到下一个用户轮。
    (payload.hookEventName === "SessionStart" &&
      (state.currentTurnId === null || state.currentTurnStartedModelOnly))
  ) {
    // startup SessionStart 虽可能已经携带 runtime turnId，但此时 TurnStarted 尚未建立
    // runtimeTurnId -> productTurnId 映射；提前 append 会把它拆成独立 footer。
    state.pendingSessionHookInvocations.set(hookInvocationId, {
      firstEvent: pending?.firstEvent ?? event,
      content,
    });
    return [];
  }

  const turnId = turnIdOf(state, event);
  const hookRowBase = rowBase(state, event, turnId, hookInvocationId);
  const row: HookInvocationRow = {
    ...hookRowBase,
    ...content,
  };
  state.hookRowIdByInvocationId.set(hookInvocationId, row.rowId);
  const blockErrorDelta = hookBlockErrorDelta(state, event, payload, didExecute, blockReason);
  return [{ op: "row.appended", row }, ...(blockErrorDelta ? [blockErrorDelta] : [])];
}

/**
 * UserPromptSubmit 的 executed block 是当前输入的可见错误，但不是 task 失败。
 * 将它投影到 transient lastError，让 ChatErrorBanner 直接展示原因；下一轮 TurnStarted
 * 会按既有生命周期清理它。admission-only block 和工具边界 block 仍只保留在 Hook 摘要。
 */
function hookBlockErrorDelta(
  state: Pick<ProjectionState, "snapshot">,
  event: SessionEvent,
  payload: HookRunLifecyclePayload,
  didExecute: boolean,
  blockReason: string | undefined,
): ConversationDelta | null {
  if (
    event.type !== SessionEventType.HookRunBlocked ||
    payload.hookEventName !== "UserPromptSubmit" ||
    !didExecute ||
    !blockReason
  ) {
    return null;
  }
  const diagnosticMessage = [payload.stderrPreview, payload.errorMessage, payload.stdoutPreview]
    .map((value) => value?.trim())
    .find((value) => value && value !== blockReason);
  const displayReason = diagnosticMessage ?? blockReason;
  const message =
    displayReason === USER_PROMPT_HOOK_BLOCK_ERROR_TYPE
      ? USER_PROMPT_HOOK_BLOCK_ERROR_TYPE
      : `${USER_PROMPT_HOOK_BLOCK_ERROR_TYPE}: ${displayReason}`;
  const detail = [
    `Hook block reason: ${blockReason}`,
    ...(diagnosticMessage ? [`Hook error: ${diagnosticMessage}`] : []),
  ].join("\n");
  return {
    op: "state.updated",
    patch: controlPatch(state, {
      lastError: {
        code: "fault.runtime.hookBlocked",
        message,
        recoverable: false,
        at: ms(event),
        source: "runtime",
        traceId: String(event.traceId),
        ...(detail ? { detail } : {}),
        attribution: {
          source: "runtime",
          reason: "hook_blocked",
        },
      },
    }),
  };
}

export function flushPendingSessionHookInvocations(
  state: ProjectionState,
  turnId: string,
): ConversationDelta[] {
  if (state.pendingSessionHookInvocations.size === 0) return [];
  const deltas: ConversationDelta[] = [];
  for (const [hookInvocationId, pending] of state.pendingSessionHookInvocations) {
    const row: HookInvocationRow = {
      ...rowBase(state, pending.firstEvent, turnId, hookInvocationId),
      ...pending.content,
    };
    state.hookRowIdByInvocationId.set(hookInvocationId, row.rowId);
    deltas.push({ op: "row.appended", row });
  }
  state.pendingSessionHookInvocations.clear();
  return deltas;
}
