import {
  CoreErrorType,
  SessionEventType,
  createCoreError,
  createPartId,
  getModelUsageTotalTokens,
  traceContextToLogContext,
  TurnMachineImpl,
} from "../deps.js";
import {
  buildTurnFileChangeSummary,
  createModelContextExceededFinishError,
  finalizeSuspiciousEmptyModelResult,
  isContextExceededFinishReason,
  isSuspiciousEmptyModelResult,
  objectKeys,
  projectExecutionErrorPayload,
  readRawFinishReason,
  throwIfTurnAborted,
} from "../helpers/index.js";
import type { RuntimeModelTextResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { recordModelHistoryRound } from "./turn-loop-state.js";
import { recordMainTurnCacheHitUsage, recordMainTurnModelUsage } from "./turn-model-step-usage.js";
import type { ModelStepOptions, PreparedModelStep } from "./turn-model-step-request.js";
import {
  buildAutomationCreateLimitFallback,
  recoverModelStepAfterContextExceeded,
} from "./turn-model-step-recovery.js";
import { executeToolCallsForModelStep } from "./turn-tools.js";
import {
  finishModelStepWithoutToolCalls,
  persistCompletedAssistantStep,
  persistOutputTokenLimitErrorCarrier,
} from "./turn-stop.js";
import {
  appendOutputTokenContinuation,
  OUTPUT_TOKEN_LIMIT_ERROR_MESSAGE,
  classifyOutputTokenContinuation,
  commitAssistantToTurnRequest,
  completeOutputTokenRecovery,
  hasAssistantReasoningContent,
} from "./turn-output-token-continuation.js";
import type { ModelStepResult } from "./turn-model-step.js";

/**
 * 单次 model result 的应用阶段：usage/诊断 → assistant part 落库 → ModelComplete 事件 →
 * output-limit 续写 → tool 执行。mutable 状态仍写在原 `state` / `this` 上；
 * narrow context 只带本次 step 已确定的值与请求局部槽。
 */
export async function applyModelStepResult(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  options: ModelStepOptions,
  prepared: PreparedModelStep,
  result: RuntimeModelTextResult,
): Promise<ModelStepResult> {
  const {
    assistantCreatedAt,
    assistantMessageId,
    assistantPersistenceAnchor,
    executionContextWindow,
    executionModelSelection,
    modelStartedAt,
    modelStepIndex,
    modelTraceContext,
    networkEventStartIndex,
    querySource,
    streamingToolCoordinator,
  } = prepared;
  const model = state.model;
  state.modelResponse = result.text;
  state.modelStepCount += 1;
  state.tokenCount += getModelUsageTotalTokens(result.usage);

  if (result.usage.cacheReadTokens && result.usage.cacheReadTokens > 0) {
    this.messageHistory.setCacheHit(result.usage.cacheReadTokens);
  }

  let toolCalls = this.extractToolCallsFromResult(result);
  const providerToolCallCount = toolCalls.length;
  const localTerminalResponse = state.automationCreateLimitReached === true;
  if (state.automationCreateLimitReached && toolCalls.length > 0) {
    // 即使 provider 在 tools=[] 后仍幻觉出工具调用，也不能重新进入执行器；
    // 上限命中后的当前用户 turn 已经是纯文本终止边界。
    this.logger?.warn("Ignored tool calls after automation create limit was reached", {
      event: "automation.create_limit.tool_calls_ignored",
      module: "core.runtime",
      status: "completed",
      toolCallCount: toolCalls.length,
    });
    toolCalls = [];
    state.modelResponse = buildAutomationCreateLimitFallback(state.input);
  } else if (state.automationCreateLimitReached && state.modelResponse.trim().length === 0) {
    state.modelResponse = buildAutomationCreateLimitFallback(state.input);
  }
  const usage = result.usage ?? {};
  const responseLength = state.modelResponse.length;
  const rawFinishReason = readRawFinishReason(result.providerMetadata);
  // Automation create-limit 已经接管当前响应的终止语义；若在清空
  // provider tool calls 后仍重新解释 length/context reason，纯文本终态会再续跑 3 次。
  const outputTokenContinuation = localTerminalResponse
    ? "none"
    : classifyOutputTokenContinuation({
        continuationCount: state.turnRequestState.outputTokenContinuationCount,
        finishReason: result.finishReason,
        rawFinishReason,
        toolCallCount: providerToolCallCount,
      });
  this.logger?.info("Model response diagnostics", {
    ...traceContextToLogContext(modelTraceContext),
    event: "model.response.diagnostics",
    finishReason: result.finishReason,
    module: "core.runtime",
    providerMetadataKeys: objectKeys(result.providerMetadata),
    rawFinishReason,
    responseEmpty: responseLength === 0,
    responseLength,
    status: "completed",
    toolCallCount: toolCalls.length,
    usageCacheReadTokens: usage.cacheReadTokens,
    usageCacheWriteTokens: usage.cacheWriteTokens,
    usageInputTokens: usage.inputTokens,
    usageOutputTokens: usage.outputTokens,
    usageReasoningTokens: usage.reasoningTokens,
    usageTotalTokens: usage.totalTokens,
  });
  if (
    !localTerminalResponse &&
    outputTokenContinuation === "none" &&
    toolCalls.length === 0 &&
    isContextExceededFinishReason(result.finishReason, rawFinishReason)
  ) {
    // 超窗 provider 可能返回空内容和 zero usage；必须先识别 overflow，
    // 否则会被 suspicious empty 包成普通 ModelError，后续 reactive compact 无法触发。
    const contextError = createModelContextExceededFinishError({
      finishReason: result.finishReason,
      rawFinishReason,
    });
    if (
      await recoverModelStepAfterContextExceeded.call(
        this,
        state,
        contextError,
        modelStepIndex,
        options.requestEntries,
      )
    ) {
      return "continue";
    }
    throw contextError;
  }
  if (
    !localTerminalResponse &&
    outputTokenContinuation === "none" &&
    isSuspiciousEmptyModelResult(result.finishReason, responseLength, toolCalls.length, usage)
  ) {
    this.logger?.warn("Model returned an empty non-stop result", {
      ...traceContextToLogContext(modelTraceContext),
      event: "model.response.suspicious_empty",
      finishReason: result.finishReason,
      module: "core.runtime",
      rawFinishReason,
      responseLength,
      status: "completed",
      toolCallCount: toolCalls.length,
      usageTotalTokens: usage.totalTokens,
    });
    finalizeSuspiciousEmptyModelResult({
      finishReason: result.finishReason,
      model: executionModelSelection,
      providerMetadata: result.providerMetadata,
      rawFinishReason,
    });
  }
  // AI SDK 可能把非标准 output-limit 归一化为 other；Runtime 已确认恢复语义后，
  // live 事件与持久化必须统一使用 length，同时由上方 diagnostics 保留 provider 原始事实。
  if (outputTokenContinuation !== "none") result.finishReason = "length";
  for (const reasoning of result.reasoning ?? []) {
    if (!hasAssistantReasoningContent(reasoning)) continue;
    await this.persistPart(
      {
        id: createPartId(),
        sessionID: this.sessionId,
        messageID: assistantMessageId,
        type: "reasoning",
        text: reasoning.text,
        metadata: reasoning.providerOptions,
        time: {
          start: modelStartedAt,
          end: Date.now(),
        },
      },
      modelTraceContext,
    );
  }
  if (state.modelResponse.length > 0) {
    await this.persistPart(
      {
        id: createPartId(),
        sessionID: this.sessionId,
        messageID: assistantMessageId,
        type: "text",
        text: state.modelResponse,
        time: {
          start: modelStartedAt,
          end: Date.now(),
        },
      },
      modelTraceContext,
    );
  }

  const cacheHit =
    querySource === "main_turn" ? recordMainTurnCacheHitUsage(this, result.usage) : undefined;
  // subagent 的文件 checkpoint 已经持久化，但旧 gate 只允许 main_turn 把
  // 汇总写入 ModelComplete，导致 child 详情无法从权威事件恢复摘要和撤销入口。
  const supportsTurnFileChanges = querySource === "main_turn" || querySource === "subagent";
  const fileChanges =
    supportsTurnFileChanges && toolCalls.length === 0
      ? buildTurnFileChangeSummary(this.currentTurnFileChanges)
      : undefined;
  const modelCompleteEvent = this.createEvent(
    SessionEventType.ModelComplete,
    {
      content: state.modelResponse,
      // 桌面 continuous 实时事件只携带当前 model_complete payload。
      // 如果主轮次只发 usage 不发 contextWindow，旧 task stream 无法生成 usage_update，
      // 长程任务中输入栏会拿不到 context meter 的 size 而隐藏。
      ...(querySource === "main_turn" && executionContextWindow !== undefined
        ? { contextWindow: executionContextWindow }
        : {}),
      querySource,
      stopReason: result.finishReason,
      usage: result.usage,
      ...(cacheHit ? { cacheHit } : {}),
      ...(fileChanges ? { fileChanges } : {}),
      ...(querySource === "main_turn" && result.contextUsageBreakdown
        ? { contextUsageBreakdown: result.contextUsageBreakdown }
        : {}),
      toolCallCount: toolCalls.length,
    },
    modelTraceContext,
  );
  await this.appendEvent(modelCompleteEvent, modelTraceContext);
  state.events.push(modelCompleteEvent);
  this.lastAssistantCompletedAtMs = Date.now();
  await recordMainTurnModelUsage(this, state, {
    assistantMessageId,
    model,
    modelTraceContext,
    networkEventStartIndex,
    result,
    startedAt: modelStartedAt,
    status: "completed",
    toolCallCount: toolCalls.length,
  });
  state.turnMachine = new TurnMachineImpl(
    state.turnMachine.receiveModelResponse(state.modelResponse),
  );
  throwIfTurnAborted(state.turnAbortSignal);

  this.logger?.info("Model request completed", {
    ...traceContextToLogContext(modelTraceContext),
    durationMs: Date.now() - modelStartedAt,
    event: "model.request.completed",
    module: "core.runtime",
    status: "completed",
    totalTokens: state.tokenCount,
    toolCallCount: toolCalls.length,
  });

  const executableToolCalls = toolCalls.filter((toolCall) => !toolCall.providerExecuted);
  const streamedToolResults = await streamingToolCoordinator.drain(executableToolCalls);
  if (outputTokenContinuation !== "none") {
    // 首次命中 output-limit 时，当前 request 可能带有一次性的 project-memory attachment；
    // query-local 状态必须从实际请求数组推进，不能退回请求前的数组。
    state.turnRequestState.entries = options.requestEntries;
    const assistantCommitted = await persistCompletedAssistantStep(this, state, {
      assistantPersistenceAnchor,
      assistantCreatedAt,
      assistantMessageId,
      includeEmptyAssistant: false,
      modelTraceContext,
      result,
    });
    if (assistantCommitted) recordModelHistoryRound(state);
    if (outputTokenContinuation === "continue") {
      appendOutputTokenContinuation(state.turnRequestState);
      state.reactiveCompactAttemptedInCurrentModelStep = false;
      state.turnMachine = new TurnMachineImpl(state.turnMachine.aggregateResults());
      return "output_continuation";
    }

    const exhaustedError = createCoreError(
      CoreErrorType.ModelError,
      OUTPUT_TOKEN_LIMIT_ERROR_MESSAGE,
      {
        context: {
          providerCode: "model_output_limit_exceeded",
          reason: "model_output_limit_exceeded",
          source: "provider",
        },
        recoverable: true,
      },
    );
    const exhaustedErrorProjection = projectExecutionErrorPayload(
      exhaustedError,
      OUTPUT_TOKEN_LIMIT_ERROR_MESSAGE,
    );
    completeOutputTokenRecovery(state.turnRequestState);
    await persistOutputTokenLimitErrorCarrier(this, state, {
      error: {
        name: exhaustedErrorProjection.code ?? exhaustedError.type,
        data: {
          ...(exhaustedErrorProjection.code ? { code: exhaustedErrorProjection.code } : {}),
          message: exhaustedErrorProjection.message,
          // 既有 cold hydration 用 retryable 恢复 UI recoverable；这里复用该字段，
          // 不为单一错误扩展 transcript/hydration schema。
          retryable: exhaustedError.recoverable,
          ...(exhaustedErrorProjection.attribution
            ? { attribution: exhaustedErrorProjection.attribution }
            : {}),
        },
      },
      finishReason: result.finishReason,
      model,
      modelTraceContext,
    });
    if (state.activeTurn) state.activeTurn.steerable = false;
    // 上游 query loop 会把 max_output_tokens API-error assistant 交给外层；这里复用
    // 既有 ModelError -> TurnError 收口表达同一实时错误，同时只结束当前 Turn command。
    throw exhaustedError;
  }
  completeOutputTokenRecovery(state.turnRequestState);
  if (executableToolCalls.length === 0) {
    return await finishModelStepWithoutToolCalls.call(this, state, {
      assistantPersistenceAnchor,
      assistantCreatedAt,
      assistantMessageId,
      modelTraceContext,
      result,
    });
  }

  state.toolCallCount += executableToolCalls.length;
  // 合并修复：工具调用 assistant 必须同时进入 canonical history 与本轮 request history。
  // 只写 canonical history 会让紧随其后的工具结果失去对应 assistant tool-call。
  if (commitAssistantToTurnRequest(this, state, result, executableToolCalls)) {
    recordModelHistoryRound(state);
  }
  const toolStepResult = await executeToolCallsForModelStep.call(this, state, {
    assistantCreatedAt,
    assistantMessageId,
    modelTraceContext,
    result,
    toolCalls: executableToolCalls,
    streamedToolResults,
  });
  return toolStepResult;
}
