import {
  SessionEventType,
  buildCompactPrompt,
  createChildTraceContext,
  traceContextToLogContext,
} from "../deps.js";
import type {
  CompactTrigger,
  MessageId,
  Model,
  ModelToolContract,
  SessionEvent,
  TraceContext,
} from "../deps.js";
import {
  isModelContextExceededError,
  isModelMediaTooLargeError,
  isTurnCancellationError,
  logCompactMediaRetryProjection,
  logMediaBudgetProjection,
  logMediaCapabilityProjection,
  projectCompactMediaForRetry,
  projectMessagesForModelMediaPolicy,
} from "../helpers/index.js";
import type { CompactTimelineContext, RuntimeModelTextResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  buildCompactSummaryRequestMessages,
  createCompactContextExceededFinishError,
  createCompactPromptTooLongError,
} from "./compact-active-helpers.js";
import {
  capCompactSummaryMaxOutputTokens,
  reselectCompactEntriesAfterPromptTooLong,
  truncateCompactSummaryEntriesAfterPromptTooLong,
  type CompactSelectionState,
} from "./compact-active-selection.js";
import { runCompactSummaryModelRequest } from "./compact-summary-model-request.js";
import { resolveModelRequestSessionTypeFromTaskType } from "./model-request-session-type.js";
import { recordModelUsageFact } from "./usage-observability.js";
import { filterOutputTokenContinuationEntries } from "./turn-output-token-continuation.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";

interface CompactSummaryRequestParams {
  abortSignal?: AbortSignal;
  activeEntries: readonly RuntimeMessageEntry[];
  attempt: number;
  compactModel: Model;
  compactTimeline: CompactTimelineContext;
  compactTools: ModelToolContract[];
  customInstructions: string | undefined;
  events: SessionEvent[];
  preCompactTokenCount: number;
  selection: CompactSelectionState;
  trigger: CompactTrigger;
  turnTraceContext: TraceContext;
  useMidConversationSystem: boolean;
}

export interface CompactSummaryAttemptResult {
  lastSummarizedMessageId: MessageId | undefined;
  modelTraceContext: TraceContext;
  result: RuntimeModelTextResult;
}

/**
 * 单次 active compact 的 summary provider 请求循环。selection 仍是同一个状态对象，
 * 只按原逻辑原地推进；ModelRequest 仍先于 provider 调用落库。
 */
export async function runCompactSummaryAttempts(
  this: AgentRuntimeInternal,
  params: CompactSummaryRequestParams,
): Promise<CompactSummaryAttemptResult> {
  const { compactModel, compactTools, compactTimeline, events, selection } = params;
  const lastSummarizedMessageId = this.latestConversationMessageId;
  const modelTraceContext = createChildTraceContext(params.turnTraceContext, {
    attributes: {
      model: `${compactModel.providerId}/${compactModel.modelId}`,
      querySource: "compact",
    },
  });
  const compactPrompt = buildCompactPrompt(params.customInstructions);
  let stripMediaForSummary = false;

  const reselectEntriesAfterPromptTooLong = (cause: unknown): boolean =>
    reselectCompactEntriesAfterPromptTooLong(selection, {
      entries: params.activeEntries,
      promptTooLongCause: cause,
      trigger: params.trigger,
      useMidConversationSystem: params.useMidConversationSystem,
    });
  const truncateEntriesAfterPromptTooLong = (cause: unknown): boolean =>
    truncateCompactSummaryEntriesAfterPromptTooLong(selection, {
      cause,
      logger: this.logger,
      traceContext: modelTraceContext,
      trigger: params.trigger,
      useMidConversationSystem: params.useMidConversationSystem,
    });

  while (true) {
    const requestMessages = buildCompactSummaryRequestMessages(
      selection.entriesForSummary,
      compactPrompt,
      { useMidConversationSystem: params.useMidConversationSystem },
    );
    const recordableEntries = filterOutputTokenContinuationEntries(selection.entriesForSummary);
    const recordableRequestMessages =
      recordableEntries === selection.entriesForSummary
        ? requestMessages
        : buildCompactSummaryRequestMessages(recordableEntries, compactPrompt, {
            useMidConversationSystem: params.useMidConversationSystem,
          });
    // Compact 曾只执行 capability projection，漏掉普通 turn 共用的聚合
    // 媒体预算；统一走模型媒体策略，避免 summary 请求绕过全局请求上限。
    const mediaPolicyProjection = projectMessagesForModelMediaPolicy(
      requestMessages,
      compactModel.properties.inputFormat,
    );
    logMediaCapabilityProjection(
      this.logger,
      modelTraceContext,
      mediaPolicyProjection.capabilityProjection,
      {
        event: "compact.request.media_capability_projection",
        message: "Compact request media capability projection",
        model: `${compactModel.providerId}/${compactModel.modelId}`,
      },
    );
    logMediaBudgetProjection(
      this.logger,
      modelTraceContext,
      mediaPolicyProjection.mediaBudgetProjection,
      {
        event: "compact.request.media_projection",
        message: "Compact request media budget projection",
      },
    );
    let projectedRequestMessages = mediaPolicyProjection.messages;
    let projectedRecordableMessages =
      recordableRequestMessages === requestMessages
        ? projectedRequestMessages
        : projectMessagesForModelMediaPolicy(
            recordableRequestMessages,
            compactModel.properties.inputFormat,
          ).messages;
    if (stripMediaForSummary) {
      // 复用通用 media budget 文案会污染 summary 的 provider-visible 内容。
      const mediaProjection = projectCompactMediaForRetry(projectedRequestMessages);
      projectedRequestMessages = mediaProjection.messages;
      projectedRecordableMessages =
        recordableRequestMessages === requestMessages
          ? projectedRequestMessages
          : projectCompactMediaForRetry(projectedRecordableMessages).messages;
      logCompactMediaRetryProjection(this.logger, modelTraceContext, mediaProjection);
    }

    const modelRequestEvent = this.createEvent(
      SessionEventType.ModelRequest,
      {
        // 事件误用了含 Continue 的实际请求数组，导致 query-local 提示进入持久化轨迹。
        // 与 v0.16.6 一致：事件记录过滤后的投影，下面的 provider 请求仍使用完整上下文。
        messages: projectedRecordableMessages,
        providerId: String(compactModel.providerId),
        modelId: String(compactModel.modelId),
        querySource: "compact",
        toolCount: compactTools.length,
        compactPromptTooLongRetry: selection.compactPromptTooLongAttempts,
      },
      modelTraceContext,
    );
    await this.appendEvent(modelRequestEvent, modelTraceContext);
    events.push(modelRequestEvent);
    const modelStartedAt = Date.now();
    const networkEventStartIndex = events.length;
    const compactSummaryMaxOutputTokens = capCompactSummaryMaxOutputTokens(compactModel);
    const compactModelRequest = {
      abortSignal: params.abortSignal,
      maxOutputTokens: compactSummaryMaxOutputTokens,
      messages: projectedRequestMessages,
      metadata: traceContextToLogContext(modelTraceContext),
      modelRequestSessionType: resolveModelRequestSessionTypeFromTaskType(this.config.taskType),
      modelCall: {
        attributes: {
          compactionOuterAttempt: params.attempt,
          compactionTrigger: params.trigger,
        },
        operation: "context_compaction" as const,
        operationId: compactTimeline.operationId,
      },
      statusSink: this.createModelStatusSink(modelTraceContext, events),
      // compact 的首个真实 provider event 结束 SSE retry 资格；隐藏 partial 在
      // content block 提交前仍可丢弃并 HTTP fallback，block end 后则禁止任何重放。
      preserveProviderStreamBoundaries: true,
      traceContext: modelTraceContext,
      tools: compactTools,
    };

    let result: RuntimeModelTextResult;
    try {
      result = await runCompactSummaryModelRequest({
        logger: this.logger,
        model: compactModel,
        request: compactModelRequest,
      });
    } catch (error) {
      await recordModelUsageFact(this, {
        attemptIndex: selection.compactPromptTooLongAttempts,
        error,
        events,
        model: compactModel,
        networkEventStartIndex,
        querySource: "compact",
        startedAt: modelStartedAt,
        status: isTurnCancellationError(error, params.abortSignal) ? "cancelled" : "error",
        traceContext: modelTraceContext,
      });
      if (isTurnCancellationError(error, params.abortSignal)) {
        throw error;
      }
      if (isModelMediaTooLargeError(error) && !stripMediaForSummary) {
        stripMediaForSummary = true;
        this.logger?.info("Compact summary hit media-size error; retrying with stripped media", {
          ...traceContextToLogContext(modelTraceContext),
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "compact.request.media_too_large.retry",
          module: "core.runtime",
        });
        continue;
      }
      if (isModelContextExceededError(error)) {
        if (reselectEntriesAfterPromptTooLong(error)) continue;
        if (truncateEntriesAfterPromptTooLong(error)) continue;
        throw createCompactPromptTooLongError({
          attempt: selection.compactPromptTooLongAttempts,
          cause: error,
          preCompactTokenCount: params.preCompactTokenCount,
        });
      }
      throw error;
    }

    await recordModelUsageFact(this, {
      attemptIndex: selection.compactPromptTooLongAttempts,
      events,
      model: compactModel,
      networkEventStartIndex,
      querySource: "compact",
      result,
      startedAt: modelStartedAt,
      status: "completed",
      toolCallCount: this.extractToolCallsFromResult(result).length,
      traceContext: modelTraceContext,
    });
    const contextError = createCompactContextExceededFinishError(result);
    if (contextError) {
      // compact summary 也可能以 finishReason 返回超窗而不是 throw；
      // 必须先进入同一套 recent preserve 重选逻辑，避免 finishReason 路径丢上下文。
      if (reselectEntriesAfterPromptTooLong(contextError)) continue;
      if (truncateEntriesAfterPromptTooLong(contextError)) continue;
      throw createCompactPromptTooLongError({
        attempt: selection.compactPromptTooLongAttempts,
        cause: contextError,
        preCompactTokenCount: params.preCompactTokenCount,
      });
    }
    return {
      lastSummarizedMessageId,
      modelTraceContext,
      result,
    };
  }
}
