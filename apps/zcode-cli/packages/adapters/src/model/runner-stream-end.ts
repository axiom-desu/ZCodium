import type { Logger } from "@zcode/contracts";
import { classifyModelFailure } from "./failure-classifier.js";
import { canRetryEmptyCompletion, scheduleEmptyCompletionRetry } from "./empty-completion-retry.js";
import { detectProviderBusinessFinishError } from "./provider-finish-business-error.js";
import { isSuspiciousStreamDiagnostics, logStreamDiagnostics } from "./runner-diagnostics.js";
import { createStatusContext, logModelMilestone } from "./runner-status.js";
import { TerminalStreamChunkError, toAdapterError } from "./runner-retry.js";
import type { AiSdkStreamTextResult, ResolvedAiSdkModel } from "./runner-runtime.js";
import { compactStreamFailureContext } from "./runner-stream-failure.js";
import { resolveStreamResponseHeaders } from "./runner-stream-cleanup.js";
import { isZeroOutputModelCompletion } from "./runner-diagnostics.js";
import type { StreamRunInput } from "./runner-stream-attempt.js";

// 自然 EOF 后的收口判定：唯一 provider 事实来自 diagnostics，不持有第二份流状态。
// 返回 retry 表示 adapter 层空 completion 重试已排期，调用方负责继续外层 attempt 循环。
export async function handleStreamEndedWithoutError(args: {
  attempt: number;
  diagnostics: Parameters<typeof isSuspiciousStreamDiagnostics>[0];
  emittedEvent: boolean;
  emptyCompletionRetryCount: number;
  input: StreamRunInput;
  requestHeaders: Record<string, string>;
  resolved: ResolvedAiSdkModel;
  retryBudgetAttempt: number;
  startedAt: number;
  statusContext: ReturnType<typeof createStatusContext>;
  streamResult: AiSdkStreamTextResult;
}): Promise<"retry" | "done"> {
  const {
    attempt,
    diagnostics,
    emptyCompletionRetryCount,
    input,
    requestHeaders,
    resolved,
    retryBudgetAttempt,
    startedAt,
    statusContext,
  } = args;
  // 自然 EOF 后合成的业务错误会通过 TerminalStreamChunkError 直接离开外层 catch；
  // compact 上下文在普通主链路为空，因此必须在合成现场显式保留 stream 阶段。
  // 先识别 provider business error，再考虑 generic empty；否则额度等
  // HTTP 200 空流会被误判成可重试的暂时性空响应。
  const hiddenProviderBusinessError = detectProviderBusinessFinishError({
    providerId: String(statusContext.providerId),
    providerKind: statusContext.providerKind,
    source:
      diagnostics.lastFinishChunk ??
      ({
        type: "finish",
        finishReason: diagnostics.finishReason,
        rawFinishReason: diagnostics.rawFinishReason,
      } satisfies Record<string, unknown>),
  });
  if (hiddenProviderBusinessError) {
    const failure = classifyModelFailure(hiddenProviderBusinessError, input.request.abortSignal);
    throw new TerminalStreamChunkError(
      toAdapterError(hiddenProviderBusinessError, failure, statusContext, attempt, {
        ...compactStreamFailureContext(
          input.request.preserveProviderStreamBoundaries,
          "response_body",
        ),
        errorPhase: "stream",
      }),
    );
  }

  if (isSuspiciousStreamDiagnostics(diagnostics)) {
    // 403 JSON 等业务错误有时不会让 AI SDK 抛出 error chunk，流会以空 completion 结束；
    // 若不在 adapter 层终止，core 会误报 “Model returned no text...”。
    const streamEndedWithoutOutputError = detectProviderBusinessFinishError({
      providerId: String(statusContext.providerId),
      providerKind: statusContext.providerKind,
      source: diagnostics.lastErrorChunk ?? diagnostics.lastFinishChunk,
    });
    if (streamEndedWithoutOutputError) {
      const failure = classifyModelFailure(
        streamEndedWithoutOutputError,
        input.request.abortSignal,
      );
      throw new TerminalStreamChunkError(
        toAdapterError(streamEndedWithoutOutputError, failure, statusContext, attempt, {
          ...compactStreamFailureContext(
            input.request.preserveProviderStreamBoundaries,
            "response_body",
          ),
          errorPhase: "stream",
        }),
      );
    }

    if (
      input.request.preserveProviderStreamBoundaries !== true &&
      isZeroOutputModelCompletion({
        finishReason: diagnostics.finishReason,
        reasoningLength: diagnostics.reasoningDeltaChars,
        textLength: diagnostics.textDeltaChars,
        toolCallCount: diagnostics.toolCallCount,
        usage: diagnostics.usage,
      }) &&
      canRetryEmptyCompletion({
        abortSignal: input.request.abortSignal,
        attempt,
        maxAttempts: input.retry.maxAttempts,
        retryCount: emptyCompletionRetryCount,
      })
    ) {
      const responseHeaders = await resolveStreamResponseHeaders(args.streamResult);
      const completedAt = Date.now();
      // finish 会把 retry-safe 前奏刷成可见事件；空 completion 需在
      // flush 前进入一次 adapter retry，避免 core 把第一次 attempt 当成已完成。
      logStreamDiagnostics({
        attempt,
        diagnostics,
        durationMs: completedAt - startedAt,
        emittedError: false,
        emittedEvent: args.emittedEvent,
        logger: input.logger,
        outboundHeaders: resolved.headers,
        statusContext,
      });
      await scheduleEmptyCompletionRetry({
        abortSignal: input.request.abortSignal,
        attempt,
        completedAt,
        errorPhase: "stream",
        logger: input.logger,
        requestHeaders,
        requestStatusSink: input.request.statusSink,
        responseHeaders,
        retry: input.retry,
        retryBudgetAttempt,
        startedAt,
        statusContext,
        statusSink: input.statusSink,
        streamOutputCommitted: false,
      });
      return "retry";
    }
  }
  return "done";
}

// 空 completion 的 finish/start 需要先暂存到自然 EOF，确认 generic empty 后再重试。
export function shouldHoldEmptyStreamCompletion(args: {
  attempt: number;
  diagnostics: Parameters<typeof isSuspiciousStreamDiagnostics>[0];
  emptyCompletionRetryCount: number;
  event: { emittedError: boolean; visibleEvents: { type: string }[] };
  input: StreamRunInput;
}): boolean {
  const { attempt, diagnostics, event, input } = args;
  return (
    !event.emittedError &&
    event.visibleEvents.some((visibleEvent) => visibleEvent.type === "finish") &&
    input.request.preserveProviderStreamBoundaries !== true &&
    isZeroOutputModelCompletion({
      finishReason: diagnostics.finishReason,
      reasoningLength: diagnostics.reasoningDeltaChars,
      textLength: diagnostics.textDeltaChars,
      toolCallCount: diagnostics.toolCallCount,
      usage: diagnostics.usage,
    }) &&
    canRetryEmptyCompletion({
      abortSignal: input.request.abortSignal,
      attempt,
      maxAttempts: input.retry.maxAttempts,
      retryCount: args.emptyCompletionRetryCount,
    })
  );
}

export interface MilestoneTimes {
  contentMs?: number;
  textMs?: number;
}

export function publishVisibleMilestone(
  state: MilestoneTimes,
  observation: { contentMs?: number; textMs?: number },
  logger: Logger | undefined,
  attempt: number,
): void {
  if (state.contentMs === undefined && observation.contentMs !== undefined) {
    state.contentMs = observation.contentMs;
    logModelMilestone(logger, "model_first_content", attempt, observation.contentMs);
  }
  if (state.textMs === undefined && observation.textMs !== undefined) {
    state.textMs = observation.textMs;
    logModelMilestone(logger, "model_first_text", attempt, observation.textMs);
  }
}
