import type { TextStreamPart, ToolSet } from "ai";
import type { ModelStreamEvent } from "@zcode/contracts";
import {
  createLinkedAbortController,
  readNextWithStreamIdleTimeout,
  resolveModelStreamIdleTimeoutMs,
} from "./stream-idle-timeout.js";
import { createStreamDiagnostics } from "./runner-diagnostics.js";
import { createStreamTextOptions } from "./runner-options.js";
import { sanitizeModelNetworkHeaders } from "./runner-network-headers.js";
import { retryAttemptLoopContinues } from "./retry-budget.js";
import { TerminalStreamChunkError } from "./runner-retry.js";
import {
  createAttemptStatusContext,
  publishModelStatus,
  logModelMilestone,
} from "./runner-status.js";
import { StreamingToolCallAssembler } from "./streaming-tool-call-assembler.js";
import type { AiSdkStreamTextResult } from "./runner-runtime.js";
import {
  finalizeStreamAttempt,
  handleStreamAttemptFailure,
  publishStreamCompleted,
  type StreamRunInput,
} from "./runner-stream-attempt.js";
import {
  acquireStreamAdmission,
  createStreamRunContext,
  publishStreamStalled,
  repairStreamThinkingSignature,
  type StreamAttemptState,
} from "./runner-stream-context.js";
import { observeVisibleStreamEvent } from "./runner-stream-cleanup.js";
import {
  applyStreamEventsToRetryBoundary,
  compactDirectToolCallCommitEvent,
  handleStreamChunk,
} from "./runner-stream-chunks.js";
import {
  handleStreamEndedWithoutError,
  publishVisibleMilestone,
  shouldHoldEmptyStreamCompletion,
  type MilestoneTimes,
} from "./runner-stream-end.js";
import { statusPublishOptions } from "./runner-status-publish.js";

export async function* runStreamText(input: StreamRunInput): AsyncGenerator<ModelStreamEvent> {
  const { baseStatusContext, retryBudget, statusMaxAttempts } = createStreamRunContext(input);
  let requestMessages = input.request.messages;
  let signatureRepairAttempted = false;
  let emptyCompletionRetryCount = 0;

  for (
    let attempt = 1;
    retryAttemptLoopContinues(
      retryBudget,
      attempt,
      input.retry.maxAttempts + Number(signatureRepairAttempted),
    );
    attempt += 1
  ) {
    const retryBudgetAttempt = attempt - Number(signatureRepairAttempted);
    const startedAt = Date.now();
    // SSE idle timeout 后的重试如果仍固定首请求窗口，容易被同一段 provider 静默窗口反复打断；
    // core recovery 和 adapter 内部 retry 都统一按重试次数每次增加 30s。
    const streamIdleTimeoutMs = resolveModelStreamIdleTimeoutMs({
      baseTimeoutMs: input.streamIdleTimeoutMs,
      retryNumber: (input.request.streamIdleTimeoutRetryNumber ?? 0) + retryBudgetAttempt - 1,
    });
    let emittedEvent = false;
    let emittedRetryBoundaryEvent = false;
    let emittedError = false;
    let retryScheduledFromStreamChunk = false;
    const pendingRetrySafeEvents: ModelStreamEvent[] = [];
    const diagnostics = createStreamDiagnostics();
    const attemptAbortController = createLinkedAbortController(input.request.abortSignal);
    const attemptRequest = {
      ...input.request,
      abortSignal: attemptAbortController.signal,
      messages: requestMessages,
    };
    let statusContext = createAttemptStatusContext(
      {
        ...baseStatusContext,
        maxAttempts: statusMaxAttempts(Number(signatureRepairAttempted)),
      },
      attempt,
    );
    const toolCallAssembler = new StreamingToolCallAssembler({ logger: input.logger });
    let streamIterator: AsyncIterator<TextStreamPart<ToolSet>> | undefined;
    let streamReachedNaturalEnd = false;
    let attemptFailed = false;
    const attemptState: StreamAttemptState = {
      awaitIteratorClose: false,
      terminalStatusPublished: false,
    };
    // 流式错误恢复仍需当前请求的 options/result，不创建诊断正文副本。
    let options: ReturnType<typeof createStreamTextOptions> | undefined;
    let result: AiSdkStreamTextResult | undefined;
    let requestHeaders: Record<string, string> = {};
    let requestHeaderCount = 0;
    let resolved = input.resolved;
    let timeToFirstProviderEventMs: number | undefined;
    const milestoneTimes: MilestoneTimes = {};
    let streamMaxIdleMs = 0;
    let streamStallCount = 0;
    let streamOutputCommitted = false;
    const repairThinkingSignatureRejection = (error: unknown): boolean => {
      const repairedMessages = repairStreamThinkingSignature({
        attempt,
        error,
        logger: input.logger,
        maxAttempts: input.retry.maxAttempts,
        messages: requestMessages,
        providerKind: resolved.providerKind,
        requestId: statusContext.requestId,
        signatureRepairAttempted,
      });
      if (!repairedMessages) return false;
      signatureRepairAttempted = true;
      requestMessages = repairedMessages;
      return true;
    };

    const admission = await acquireStreamAdmission({
      input,
      statusContext,
      attempt,
      startedAt,
      streamOutputCommitted,
      onAdmissionFailure: () => attemptAbortController.cleanup(),
    });

    try {
      attemptRequest.abortSignal?.throwIfAborted();
      resolved = input.resolveModel();
      options = createStreamTextOptions({
        env: input.env,
        request: attemptRequest,
        resolved,
      });
      requestHeaders = sanitizeModelNetworkHeaders(options.headers);
      requestHeaderCount = Object.keys(requestHeaders).length;
      await publishModelStatus(
        {
          ...statusContext,
          attempt,
          requestHeaderCount,
          requestHeaders,
          timestamp: new Date(startedAt).toISOString(),
          type: "model_request_started",
        },
        statusPublishOptions(input, admission),
      );
      const streamResult = input.runtime.streamText(options);
      result = streamResult;
      streamIterator = streamResult.fullStream[Symbol.asyncIterator]();

      while (true) {
        const next = await readNextWithStreamIdleTimeout(streamIterator, {
          abortController: attemptAbortController.controller,
          onTimeout: async (error) => {
            streamStallCount += 1;
            streamMaxIdleMs = Math.max(streamMaxIdleMs, error.idleMs);
            await publishStreamStalled({
              admission,
              attempt,
              error,
              input,
              requestHeaderCount,
              requestHeaders,
              statusContext,
            });
          },
          timeoutMs: streamIdleTimeoutMs,
        });
        if (next.done) {
          streamReachedNaturalEnd = true;
          break;
        }
        if (timeToFirstProviderEventMs === undefined) {
          timeToFirstProviderEventMs = Date.now() - startedAt;
          logModelMilestone(
            input.logger,
            "model_first_provider_event",
            attempt,
            timeToFirstProviderEventMs,
          );
        }

        let event: Awaited<ReturnType<typeof handleStreamChunk>>;
        try {
          event = await handleStreamChunk({
            admission,
            attempt,
            chunk: next.value,
            diagnostics,
            emittedRetryBoundaryEvent,
            input,
            pendingRetrySafeEvents,
            requestHeaderCount,
            requestHeaders,
            repairThinkingSignatureRejection,
            retryBudgetAttempt,
            startedAt,
            statusContext,
            toolCallAssembler,
          });
        } catch (error) {
          const directToolCommit = compactDirectToolCallCommitEvent(input.request, next.value);
          if (directToolCommit) {
            // 完整 direct tool-call 已是 provider 事件；name/input 校验即使抛错，
            // 也不能让 adapter 当作首事件前失败再次 SSE 重放。
            emittedRetryBoundaryEvent = true;
            for (const pendingEvent of pendingRetrySafeEvents.splice(0)) {
              emittedEvent = true;
              yield pendingEvent;
            }
            // 无 raw message-block provenance 的 provider 可能直接给完整 tool-call。
            // 先把 inferred block stop 交给隐藏 collector，再传播校验错误，避免 HTTP 重放。
            emittedEvent = true;
            yield directToolCommit;
          }
          throw error;
        }
        const shouldHoldEmptyCompletionEvents = shouldHoldEmptyStreamCompletion({
          attempt,
          diagnostics,
          emptyCompletionRetryCount,
          event,
          input,
        });
        if (shouldHoldEmptyCompletionEvents) {
          // finish 会把已缓存的 start 一并刷给 core；先暂存到自然 EOF，确认这是
          // generic empty 后再重试，避免第一次 attempt 的 finish/start 泄漏到 UI。
          event.visibleEvents.length = 0;
        }
        emittedError = emittedError || event.emittedError;
        emittedEvent = emittedEvent || event.emittedEvent;
        emittedRetryBoundaryEvent = emittedRetryBoundaryEvent || event.emittedRetryBoundaryEvent;

        if (event.retryScheduled) {
          // SSE error chunk 的 retry 是正常控制流，不会进入 catch；
          // 若不显式标记失败，finally 会跳过旧 attempt 的 iterator/tee 清理。
          // 下一次物理请求必须等待本轮 abort 与有界清理后才能启动。
          attemptFailed = true;
          attemptState.awaitIteratorClose = true;
          retryScheduledFromStreamChunk = true;
          break;
        }
        if (event.terminalError) {
          throw event.terminalError;
        }
        if (event.visibleEvents.length > 0) {
          for (const visibleEvent of event.visibleEvents) {
            const observation = observeVisibleStreamEvent(visibleEvent, Date.now() - startedAt);
            publishVisibleMilestone(milestoneTimes, observation, input.logger, attempt);
            streamOutputCommitted = streamOutputCommitted || observation.outputCommitted;
            yield visibleEvent;
          }
        }
      }

      if (retryScheduledFromStreamChunk) {
        continue;
      }

      const flushedEvents = applyStreamEventsToRetryBoundary({
        emittedRetryBoundaryEvent,
        events: toolCallAssembler.flush(),
        pendingRetrySafeEvents,
        preserveProviderStreamBoundaries: input.request.preserveProviderStreamBoundaries,
      });
      emittedEvent = emittedEvent || flushedEvents.emittedEvent;
      emittedRetryBoundaryEvent =
        emittedRetryBoundaryEvent || flushedEvents.emittedRetryBoundaryEvent;
      if (flushedEvents.visibleEvents.length > 0) {
        for (const visibleEvent of flushedEvents.visibleEvents) {
          const observation = observeVisibleStreamEvent(visibleEvent, Date.now() - startedAt);
          publishVisibleMilestone(milestoneTimes, observation, input.logger, attempt);
          streamOutputCommitted = streamOutputCommitted || observation.outputCommitted;
          yield visibleEvent;
        }
      }

      for (const pendingEvent of pendingRetrySafeEvents.splice(0)) {
        emittedEvent = true;
        const observation = observeVisibleStreamEvent(pendingEvent, Date.now() - startedAt);
        publishVisibleMilestone(milestoneTimes, observation, input.logger, attempt);
        streamOutputCommitted = streamOutputCommitted || observation.outputCommitted;
        yield pendingEvent;
      }

      if (!emittedError) {
        const streamEndOutcome = await handleStreamEndedWithoutError({
          attempt,
          diagnostics,
          emittedEvent,
          emptyCompletionRetryCount,
          input,
          requestHeaders,
          resolved,
          retryBudgetAttempt,
          startedAt,
          statusContext,
          streamResult,
        });
        if (streamEndOutcome === "retry") {
          emptyCompletionRetryCount += 1;
          continue;
        }
      }

      attemptState.terminalStatusPublished = await publishStreamCompleted({
        admission,
        attempt,
        diagnostics,
        emittedError,
        emittedEvent,
        input,
        requestHeaderCount,
        requestHeaders,
        resolved,
        result: streamResult,
        startedAt,
        statusContext,
        streamMaxIdleMs,
        streamOutputCommitted,
        streamStallCount,
        timeToFirstContentMs: milestoneTimes.contentMs,
        timeToFirstProviderEventMs,
        timeToFirstTextMs: milestoneTimes.textMs,
      });
      return;
    } catch (error) {
      attemptFailed = true;
      if (error instanceof TerminalStreamChunkError) {
        attemptState.awaitIteratorClose = true;
        throw error.adapterError;
      }
      await handleStreamAttemptFailure({
        admission,
        attempt,
        diagnostics,
        emittedError,
        emittedEvent,
        emittedRetryBoundaryEvent,
        error,
        input,
        repairThinkingSignatureRejection,
        requestHeaders,
        retryBudget,
        retryBudgetAttempt,
        startedAt,
        state: attemptState,
        statusContext,
        statusMaxAttempts,
        streamIteratorCreated: streamIterator !== undefined,
        streamOutputCommitted,
      });
      continue;
    } finally {
      await finalizeStreamAttempt({
        admission,
        attempt,
        attemptAbortController,
        attemptFailed,
        emittedError,
        input,
        requestHeaderCount,
        requestHeaders,
        result,
        startedAt,
        state: attemptState,
        statusContext,
        streamIterator,
        streamOutputCommitted,
        streamReachedNaturalEnd,
      });
    }
  }
}
