import type {
  CompactLifecyclePayload,
  ModelCompletePayload,
  SessionEvent,
  ToolExecutionPerformance,
} from "@zcode/contracts";
import { getModelUsageTotalTokens } from "@zcode/contracts";
import type { ConversationTelemetryFact } from "@zcode/shared/zcode-protocol-v4";

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function streamingParentToolCallId(payload: Record<string, unknown>): string | undefined {
  const meta = recordValue(payload._meta);
  const zcode = recordValue(meta.zcode);
  return (
    optionalString(payload.parentToolCallId) ??
    optionalString(payload.parentToolUseId) ??
    optionalString(meta.parentToolCallId) ??
    optionalString(meta.parentToolUseId) ??
    optionalString(zcode.parentToolCallId) ??
    optionalString(zcode.parentToolUseId)
  );
}

export function mirroredSubagentToolFields(
  payload: Record<string, unknown>,
  display: Record<string, unknown> = {},
) {
  const parentToolCallId =
    optionalString(payload.parentToolCallId) ?? optionalString(display.parentToolCallId);
  const childToolCallId =
    optionalString(payload.childToolCallId) ?? optionalString(display.childToolCallId);
  const agentId = optionalString(payload.agentId) ?? optionalString(display.agentId);
  const childSessionId =
    optionalString(payload.childSessionId) ?? optionalString(display.childSessionId);
  return {
    ...(parentToolCallId ? { parentToolCallId } : {}),
    ...(childToolCallId ? { childToolCallId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(childSessionId ? { childSessionId } : {}),
    ...(payload.background === true ? { background: true } : {}),
  };
}

export function eventTimestamp(event: SessionEvent): number {
  const value =
    event.timestamp instanceof Date ? event.timestamp.getTime() : Number(event.timestamp);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function totalTokensOf(usage: Record<string, unknown>): number {
  return getModelUsageTotalTokens({
    totalTokens: nonNegative(usage.totalTokens),
    inputTokens: nonNegative(usage.inputTokens),
    outputTokens: nonNegative(usage.outputTokens),
    cacheReadTokens: nonNegative(usage.cacheReadTokens) ?? nonNegative(usage.cacheTokens),
    cacheWriteTokens: nonNegative(usage.cacheWriteTokens),
    reasoningTokens: nonNegative(usage.reasoningTokens),
  });
}

type ToolPerformanceFact = NonNullable<
  Extract<ConversationTelemetryFact, { kind: "tool.lifecycle" }>["performance"]
>;

export function toToolPerformanceFact(
  perf: ToolExecutionPerformance | undefined,
): ToolPerformanceFact | undefined {
  if (!perf) return undefined;
  const command = perf.detail?.kind === "command" ? perf.detail.command : undefined;
  const filesystem =
    perf.detail?.kind === "filesystem" || perf.detail?.kind === "patch"
      ? perf.detail.filesystem
      : undefined;
  const patch = perf.detail?.kind === "patch" ? perf.detail.patch : undefined;
  const fact: ToolPerformanceFact = {
    ...(perf.totalMs !== undefined ? { totalMs: perf.totalMs } : {}),
    ...(perf.permissionWaitMs !== undefined ? { permissionWaitMs: perf.permissionWaitMs } : {}),
    ...(command?.runMs !== undefined ? { commandRunMs: command.runMs } : {}),
    ...(command?.firstOutputMs !== undefined ? { firstOutputMs: command.firstOutputMs } : {}),
    ...(command?.noOutputMs !== undefined ? { noOutputMs: command.noOutputMs } : {}),
    ...(command?.exitCode !== undefined ? { exitCode: command.exitCode } : {}),
    ...(command?.timedOut !== undefined ? { timedOut: command.timedOut } : {}),
    ...(command?.outputBytes !== undefined ? { outputBytes: command.outputBytes } : {}),
    ...(command?.category !== undefined ? { commandCategory: command.category } : {}),
    ...(command?.count !== undefined ? { commandCount: command.count } : {}),
    ...(command?.status !== undefined ? { commandStatus: command.status } : {}),
    ...(filesystem?.readMs !== undefined ? { fsReadMs: filesystem.readMs } : {}),
    ...(filesystem?.writeMs !== undefined ? { fsWriteMs: filesystem.writeMs } : {}),
    ...(filesystem?.fileCount !== undefined ? { fileCount: filesystem.fileCount } : {}),
    ...(filesystem?.totalBytes !== undefined ? { totalBytes: filesystem.totalBytes } : {}),
    ...(filesystem?.maxFileBytes !== undefined ? { maxFileBytes: filesystem.maxFileBytes } : {}),
    ...(filesystem?.workspaceKind !== undefined ? { workspaceKind: filesystem.workspaceKind } : {}),
    ...(patch?.matchMs !== undefined ? { patchMatchMs: patch.matchMs } : {}),
    ...(patch?.hunkCount !== undefined ? { hunkCount: patch.hunkCount } : {}),
    ...(patch?.matchAttempts !== undefined ? { matchAttempts: patch.matchAttempts } : {}),
  };
  return Object.keys(fact).length > 0 ? fact : undefined;
}

export function terminalStatus(resultType: string): "success" | "interrupted" | "failed" {
  if (resultType === "success") return "success";
  if (resultType === "cancelled") return "interrupted";
  return "failed";
}

function isStepUsageQuerySource(querySource: string | undefined): boolean {
  // `workflow_child`：动态工作流子代理。
  // 该来源必须放行，否则子代理的 token 进不了业务埋点。
  return (
    querySource === undefined ||
    querySource === "main_turn" ||
    querySource === "subagent" ||
    querySource === "workflow_child"
  );
}

export function isStepUsageModelComplete(payload: ModelCompletePayload): boolean {
  return (
    isStepUsageQuerySource(payload.querySource) &&
    (payload.querySource !== undefined || payload.stopReason !== "tool_internal")
  );
}

export function compactTerminalStatus(
  status: CompactLifecyclePayload["status"],
): "completed" | "failed" | "interrupted" | null {
  switch (status) {
    case "completed":
    case "failed":
    case "interrupted":
      return status;
    default:
      return null;
  }
}

/** 自定义工具名可能包含用户或插件信息，只记录固定的工具类别。 */
export function diagnosticToolName(value: unknown): string {
  switch (value) {
    case "Bash":
    case "Read":
    case "Write":
    case "Edit":
    case "Skill":
    case "Task":
    case "AskUserQuestion":
    case "CronCreate":
    case "WebFetch":
    case "WebSearch":
      return value;
    default:
      return "other";
  }
}
