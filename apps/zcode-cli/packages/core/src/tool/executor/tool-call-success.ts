// 工具调用成功收口：序列化、PostToolUse、display、性能投影、官方 CUA 帧 attestation
// 与结果发布。事件顺序（ToolCallResult → 后台任务跟踪 → completed 日志）逐字保持。

import {
  CoreErrorType,
  createCoreError,
  traceContextToLogContext,
  type TurnId,
  type TraceContext,
} from "@zcode/contracts";
import {
  OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
  attestOfficialCuaFrameContent,
} from "@zcode/zcode-cua/frame-contract";
import type { BackgroundTaskTracker } from "./background-tasks.js";
import type { ExecutableToolCall, ToolEntry, ToolExecutionResult } from "../types.js";
import { emitToolCallResult } from "./events.js";
import { runPostToolUseHooks } from "./hook-flow.js";
import { createToolResultDisplay } from "./result-display.js";
import { appendHookAdditionalContexts, serializeOutput } from "./result-serialization.js";
import {
  mergeToolExecutionPerformance,
  readToolExecutionPerformance,
} from "../handlers/tool-perf.js";
import { withTerminalToolTurnStop } from "./turn-control.js";
import type { ToolExecutorDeps } from "./types.js";

export async function finishToolCallSuccess(input: {
  backgroundTasks: BackgroundTaskTracker;
  canonicalToolCall: ExecutableToolCall;
  deps: ToolExecutorDeps;
  entry: ToolEntry;
  executionAbortController: AbortController;
  executionInput: unknown;
  output: unknown;
  permissionWaitMs: number | undefined;
  preToolHookResult: { additionalContexts: string[] };
  modelOutputEntry: ToolEntry;
  durationMs: number;
  readFileStateMetadata: ToolExecutionResult["readFileStateMetadata"];
  startTime: number;
  totalStartedAt: number;
  traceContext: TraceContext;
  turnId: TurnId | undefined;
  signal?: AbortSignal;
}): Promise<ToolExecutionResult> {
  const {
    backgroundTasks,
    canonicalToolCall,
    deps,
    entry,
    executionAbortController,
    executionInput,
    output,
    permissionWaitMs,
    preToolHookResult,
    modelOutputEntry,
    durationMs,
    readFileStateMetadata,
    startTime,
    totalStartedAt,
    traceContext,
    turnId,
  } = input;

  let serialization = await serializeOutput(
    deps,
    output,
    modelOutputEntry,
    traceContext,
    canonicalToolCall.id,
    executionAbortController.signal,
  );
  const postToolHookResult = await runPostToolUseHooks(
    deps,
    canonicalToolCall,
    executionInput,
    output,
    serialization.artifactPath,
    traceContext,
    input.signal,
  );
  serialization = appendHookAdditionalContexts(
    serialization,
    [...preToolHookResult.additionalContexts, ...postToolHookResult.additionalContexts],
    modelOutputEntry,
  );
  const display = createToolResultDisplay(canonicalToolCall.name, output, {
    mcp: entry.metadata.mcpPresentation,
    officialCua: entry.modelContentProtection === OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
  });
  const perf = mergeToolExecutionPerformance(readToolExecutionPerformance(output), {
    permissionWaitMs,
    // totalMs 是用户感知的工具生命周期：registry lookup、校验、Hook、权限等待、
    // handler、序列化与 PostToolUse。durationMs 继续只表示 handler 主执行段。
    totalMs: Date.now() - totalStartedAt,
  });

  const finalModelContent = serialization.modelContent ?? serialization.content;
  const modelContentProtection = modelOutputEntry.modelContentProtection
    ? attestOfficialCuaFrameContent(finalModelContent, modelOutputEntry.modelContentProtection)
    : undefined;
  if (
    modelOutputEntry.modelContentProtection &&
    Array.isArray(finalModelContent) &&
    finalModelContent.some((block) => block.type === "image") &&
    !modelContentProtection
  ) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      "Official CUA frame failed final model-content attestation",
      { recoverable: true },
    );
  }

  const result: ToolExecutionResult = withTerminalToolTurnStop(
    {
      toolCallId: canonicalToolCall.id,
      toolName: canonicalToolCall.name,
      success: true,
      output,
      display,
      modelContent: finalModelContent,
      ...(readFileStateMetadata ? { readFileStateMetadata } : {}),
      performance: perf,
      serialization,
      durationMs,
      startedAt: new Date(startTime),
      completedAt: new Date(),
    },
    { entry },
  );

  await emitToolCallResult(
    deps,
    canonicalToolCall,
    traceContext,
    turnId,
    serialization,
    durationMs,
    display,
    perf,
  );

  await backgroundTasks.trackBackgroundTask(canonicalToolCall, output, traceContext, turnId);

  deps.logger?.info("Tool call completed", {
    ...traceContextToLogContext(traceContext),
    durationMs,
    event: "tool.call.completed",
    module: "core.tool.executor",
    status: "completed",
    toolCallId: canonicalToolCall.id,
    toolName: canonicalToolCall.name,
  });

  return result;
}
