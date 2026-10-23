// 工具调用失败收口：把 handler/serialize/post_hook 阶段异常投影成既有 ToolExecutionResult，
// 保持 PostToolUseFailure hook、additionalContext 追加与 ToolCallError 事件顺序不变。

import { traceContextToLogContext, type TurnId, type TraceContext } from "@zcode/contracts";
import type { ExecutableToolCall, ToolExecutionResult } from "../types.js";
import type { ToolExecutorDeps, ToolExecuteOptions } from "./types.js";
import { createErrorResult, isToolHandlerFailureError } from "./errors.js";
import { emitToolCallError } from "./events.js";
import { formatHookAdditionalContexts, runPostToolUseFailureHooks } from "./hook-flow.js";
import { withAutomationCreateLimitTurnStop } from "./turn-control.js";

export async function handleToolCallFailure(input: {
  deps: ToolExecutorDeps;
  canonicalToolCall: ExecutableToolCall;
  executionInput: unknown;
  error: unknown;
  options?: ToolExecuteOptions;
  preToolHookResult: { additionalContexts: string[] };
  startTime: number;
  traceContext: TraceContext;
  turnId: TurnId | undefined;
}): Promise<ToolExecutionResult> {
  const { deps, canonicalToolCall, executionInput, error, options, preToolHookResult } = input;
  const traceContext = input.traceContext;
  const turnId = input.turnId;
  const startTime = input.startTime;
  const durationMs = Date.now() - startTime;

  const failureHookResult = await runPostToolUseFailureHooks(
    deps,
    canonicalToolCall,
    executionInput,
    error,
    traceContext,
    options?.signal,
  );
  let result = createErrorResult(
    canonicalToolCall,
    error instanceof Error ? error : new Error(String(error)),
    durationMs,
  );
  const baseModelContent = result.error
    ? isToolHandlerFailureError(error) && typeof result.modelContent === "string"
      ? result.modelContent
      : result.error.message
    : undefined;
  if (failureHookResult.additionalContexts.length > 0 && baseModelContent) {
    result.modelContent = [
      baseModelContent,
      formatHookAdditionalContexts([
        ...preToolHookResult.additionalContexts,
        ...failureHookResult.additionalContexts,
      ]),
    ].join("\n\n");
  } else if (preToolHookResult.additionalContexts.length > 0 && baseModelContent) {
    result.modelContent = [
      baseModelContent,
      formatHookAdditionalContexts(preToolHookResult.additionalContexts),
    ].join("\n\n");
  }
  result = withAutomationCreateLimitTurnStop(result, {
    error,
    toolName: canonicalToolCall.name,
  });

  // Skill 已解析成功后，serialize/post_hook 仍可能失败；错误事件也要保留
  // resolved metadata，否则失败的 Skill agent_step 无法归因到具体 skill。
  await emitToolCallError(deps, canonicalToolCall.id, traceContext, turnId, result.error);

  deps.logger?.error(
    "Tool call failed",
    error instanceof Error ? error : new Error(String(error)),
    {
      ...traceContextToLogContext(traceContext),
      durationMs,
      event: "tool.call.failed",
      module: "core.tool.executor",
      status: "failed",
      toolCallId: canonicalToolCall.id,
      toolName: canonicalToolCall.name,
    },
  );

  return result;
}
