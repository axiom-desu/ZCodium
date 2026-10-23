import type { TextStreamPart, ToolSet } from "ai";
import type { Logger, ModelStatusSink } from "@zcode/contracts";
import { ModelFailureReason as ModelFailureReasonValue, ModelRetryReason } from "@zcode/contracts";
import { classifyModelFailure } from "./failure-classifier.js";
import { getResponseHeaders, unwrapRetryError } from "./failure-inspection.js";
import {
  createStreamDiagnostics,
  logStreamDiagnostics,
  logStreamFailureDiagnostics,
} from "./runner-diagnostics.js";
import { sanitizeModelNetworkHeaders } from "./runner-network-headers.js";
import { type AttemptAdmission } from "./request-admission.js";
import type { ResolvedAiSdkModelRetryOptions } from "./retry-policy.js";
import type {
  AiSdkModelRuntime,
  AiSdkModelTextRequest,
  AiSdkStreamTextResult,
  ResolvedAiSdkModel,
} from "./runner-runtime.js";
import type { EnvRecord } from "./model-execution.js";
import {
  calculateRetryDelay,
  logRetryDelayDecision,
  sleep,
  toAdapterError,
} from "./runner-retry.js";
import { createStatusContext, publishModelStatus } from "./runner-status.js";
import {
  failureUsageFields,
  modelFailureStatusFields,
  providerRequestIdFromHeaders,
  readModelFailureErrorPhase,
} from "./runner-failure-status.js";
import { publishRetryScheduledStatus, statusPublishOptions } from "./runner-status-publish.js";
import { resolveStreamFailureDecision } from "./runner-stream-failure.js";
import { closeStreamIteratorBestEffort } from "./runner-stream-cleanup.js";
import { resolveStreamResponseHeaders } from "./runner-stream-cleanup.js";
import type { StreamAttemptState } from "./runner-stream-context.js";

export interface StreamRunInput {
  env: EnvRecord;
  logger?: Logger;
  request: AiSdkModelTextRequest;
  resolveModel: () => ResolvedAiSdkModel;
  resolved: ResolvedAiSdkModel;
  retry: ResolvedAiSdkModelRetryOptions;
  runtime: AiSdkModelRuntime;
  statusSink?: ModelStatusSink;
  streamIdleTimeoutMs: number;
}

// 进程级准入：唯一 owner 是 request-admission；本 helper 只负责
// 失败时发布 connect 阶段状态并抛出，不改变等待/归还顺序。
export async function publishStreamCompleted(args: {
  admission?: AttemptAdmission;
  attempt: number;
  diagnostics: ReturnType<typeof createStreamDiagnostics>;
  emittedError: boolean;
  emittedEvent: boolean;
  input: StreamRunInput;
  requestHeaderCount: number;
  requestHeaders: Record<string, string>;
  resolved: ResolvedAiSdkModel;
  result: AiSdkStreamTextResult;
  startedAt: number;
  statusContext: ReturnType<typeof createStatusContext>;
  streamMaxIdleMs: number;
  streamOutputCommitted: boolean;
  streamStallCount: number;
  timeToFirstContentMs?: number;
  timeToFirstProviderEventMs?: number;
  timeToFirstTextMs?: number;
}): Promise<boolean> {
  const { input, attempt, diagnostics, startedAt, statusContext } = args;
  logStreamDiagnostics({
    attempt,
    diagnostics,
    durationMs: Date.now() - startedAt,
    emittedError: args.emittedError,
    emittedEvent: args.emittedEvent,
    logger: input.logger,
    outboundHeaders: args.resolved.headers,
    statusContext,
  });
  if (args.emittedError) {
    return false;
  }
  const completedAt = Date.now();
  const responseHeaders = await resolveStreamResponseHeaders(args.result);
  await publishModelStatus(
    {
      ...statusContext,
      attempt,
      durationMs: completedAt - startedAt,
      requestHeaderCount: args.requestHeaderCount,
      requestHeaders: args.requestHeaders,
      responseHeaderCount: Object.keys(responseHeaders).length,
      responseHeaders,
      providerRequestId: providerRequestIdFromHeaders(responseHeaders),
      finishReason: diagnostics.finishReason,
      usage: diagnostics.usage,
      timeToFirstProviderEventMs: args.timeToFirstProviderEventMs,
      timeToFirstContentMs: args.timeToFirstContentMs,
      timeToFirstTextMs: args.timeToFirstTextMs,
      streamMaxIdleMs: args.streamMaxIdleMs || undefined,
      streamStallCount: args.streamStallCount,
      streamOutputCommitted: args.streamOutputCommitted,
      timestamp: new Date(completedAt).toISOString(),
      type: "model_request_completed",
    },
    statusPublishOptions(input, args.admission),
  );
  return true;
}

export async function handleStreamAttemptFailure(args: {
  admission: AttemptAdmission;
  attempt: number;
  diagnostics: ReturnType<typeof createStreamDiagnostics>;
  emittedError: boolean;
  emittedEvent: boolean;
  emittedRetryBoundaryEvent: boolean;
  error: unknown;
  input: StreamRunInput;
  repairThinkingSignatureRejection: (error: unknown) => boolean;
  requestHeaders: Record<string, string>;
  retryBudget: AiSdkModelTextRequest["modelRetryBudget"];
  retryBudgetAttempt: number;
  startedAt: number;
  state: StreamAttemptState;
  statusContext: ReturnType<typeof createStatusContext>;
  statusMaxAttempts: (extraAttempts: number) => number;
  streamIteratorCreated: boolean;
  streamOutputCommitted: boolean;
}): Promise<"retry"> {
  const {
    admission,
    attempt,
    diagnostics,
    input,
    requestHeaders,
    retryBudget,
    retryBudgetAttempt,
    startedAt,
    state,
  } = args;
  let statusContext = args.statusContext;
  const completedAt = Date.now();
  const retryWithRepairedHistory =
    !args.emittedRetryBoundaryEvent && args.repairThinkingSignatureRejection(args.error);
  if (retryWithRepairedHistory) {
    statusContext = {
      ...statusContext,
      maxAttempts: args.statusMaxAttempts(1),
    };
  }
  const failure = classifyModelFailure(args.error, input.request.abortSignal);
  const errorPhase =
    readModelFailureErrorPhase(args.error) ?? (args.streamIteratorCreated ? "stream" : "prepare");
  state.awaitIteratorClose = failure.reason !== ModelFailureReasonValue.Cancelled;
  const responseHeaders = sanitizeModelNetworkHeaders(
    getResponseHeaders(unwrapRetryError(args.error)),
  );
  const failureDecision = resolveStreamFailureDecision({
    attempt: retryBudgetAttempt,
    emittedRetryBoundaryEvent: args.emittedRetryBoundaryEvent,
    error: args.error,
    failure,
    maxAttempts: input.retry.maxAttempts,
    preserveProviderStreamBoundaries: input.request.preserveProviderStreamBoundaries,
    responseHeaders,
    retryBudget,
    streamIteratorCreated: args.streamIteratorCreated,
    streamErrorChunkObserved: Boolean(diagnostics.lastErrorChunk || diagnostics.lastFinishChunk),
  });
  if (retryWithRepairedHistory) {
    failureDecision.canRetry = true;
  }

  logStreamFailureDiagnostics({
    attempt,
    canRetry: failureDecision.canRetry,
    diagnostics,
    durationMs: completedAt - startedAt,
    emittedError: args.emittedError,
    emittedEvent: args.emittedEvent,
    emittedRetryBoundaryEvent: args.emittedRetryBoundaryEvent,
    error: args.error,
    failure,
    logger: input.logger,
    statusContext,
  });
  await publishModelStatus(
    {
      ...statusContext,
      attempt,
      durationMs: completedAt - startedAt,
      message: failure.message,
      reason: failure.reason,
      requestHeaderCount: Object.keys(requestHeaders).length,
      requestHeaders,
      responseHeaderCount: Object.keys(responseHeaders).length,
      responseHeaders,
      retryable: failureDecision.canRetry,
      statusCode: failure.statusCode,
      streamOutputCommitted: args.streamOutputCommitted,
      ...modelFailureStatusFields(args.error, failure, errorPhase),
      // 只有终止的失败（空输出上下文超窗）携带 usage；重试不会重复入账。
      ...failureUsageFields(args.error),
      timestamp: new Date(completedAt).toISOString(),
      type: "model_request_failed",
    },
    {
      ...statusPublishOptions(input, admission),
    },
  );
  state.terminalStatusPublished = true;

  if (retryWithRepairedHistory) {
    await publishRetryScheduledStatus(
      input,
      statusContext,
      attempt,
      0,
      { ...failure, retryReason: ModelRetryReason.ReasoningSignatureRepair },
      requestHeaders,
      responseHeaders,
      admission,
    );
    return "retry";
  }

  if (!failureDecision.canRetry) {
    logRetryDelayDecision({
      attempt,
      canRetry: failureDecision.canRetry,
      failure,
      logger: input.logger,
      responseHeaders,
      statusContext,
    });
    throw toAdapterError(args.error, failure, statusContext, attempt, {
      ...failureDecision.context,
      errorPhase,
    });
  }

  const delayMs = calculateRetryDelay(input.retry, retryBudgetAttempt, failure.retryAfterMs);
  logRetryDelayDecision({
    attempt,
    canRetry: failureDecision.canRetry,
    delayMs,
    failure,
    logger: input.logger,
    responseHeaders,
    statusContext,
  });

  await publishRetryScheduledStatus(
    input,
    statusContext,
    attempt,
    delayMs,
    failure,
    requestHeaders,
    responseHeaders,
    admission,
  );
  // 退避期间不持票：槽位让给别人，重试再准入。
  admission.release();
  try {
    await sleep(delayMs, input.request.abortSignal);
  } catch (sleepError) {
    const sleepFailure = classifyModelFailure(sleepError, input.request.abortSignal);
    await publishModelStatus(
      {
        ...statusContext,
        attempt,
        durationMs: Date.now() - startedAt,
        message: sleepFailure.message,
        reason: sleepFailure.reason,
        requestHeaderCount: Object.keys(requestHeaders).length,
        requestHeaders,
        retryable: false,
        statusCode: sleepFailure.statusCode,
        streamOutputCommitted: args.streamOutputCommitted,
        ...modelFailureStatusFields(sleepError, sleepFailure, "connect"),
        timestamp: new Date().toISOString(),
        type: "model_request_failed",
      },
      {
        // 退避期间票据已归还：这次取消不属于任何一次尝试，不转投票据。
        ...statusPublishOptions(input),
      },
    );
    state.terminalStatusPublished = true;
    throw toAdapterError(sleepError, sleepFailure, statusContext, attempt, {
      errorPhase: "connect",
    });
  }
  return "retry";
}

export async function finalizeStreamAttempt(args: {
  admission: AttemptAdmission;
  attempt: number;
  attemptAbortController: { cleanup: () => void; controller: AbortController; signal: AbortSignal };
  attemptFailed: boolean;
  emittedError: boolean;
  input: StreamRunInput;
  requestHeaderCount: number;
  requestHeaders: Record<string, string>;
  result?: AiSdkStreamTextResult;
  startedAt: number;
  state: StreamAttemptState;
  statusContext: ReturnType<typeof createStatusContext>;
  streamIterator?: AsyncIterator<TextStreamPart<ToolSet>>;
  streamOutputCommitted: boolean;
  streamReachedNaturalEnd: boolean;
}): Promise<void> {
  const { admission, attempt, input, state, streamOutputCommitted } = args;
  if (
    !args.streamReachedNaturalEnd &&
    (args.attemptFailed || input.request.preserveProviderStreamBoundaries === true)
  ) {
    // 普通 stream 的 429 retry 失败若不进入本清理分支，
    // AI SDK fullStream tee 会持有旧 provider 请求，连续重试会让后续物理请求卡在发送前。
    // 失败 attempt 必须无条件中止并释放；普通 consumer 主动提前结束仍保持原语义。
    if (!args.attemptAbortController.signal.aborted) {
      args.attemptAbortController.controller.abort(
        new Error("Model stream attempt ended before natural EOF."),
      );
    }
    if (!args.attemptFailed && !state.terminalStatusPublished && !args.emittedError) {
      // consumer 侧的校验异常只会触发 AsyncIteratorClose，不会回到上面的 catch；
      // 将已启动的物理请求收口为 cancelled，避免 fallback 前遗留悬空 started 状态。
      const completedAt = Date.now();
      await publishModelStatus(
        {
          ...args.statusContext,
          attempt,
          durationMs: completedAt - args.startedAt,
          message: "Model stream consumer closed before natural EOF.",
          reason: ModelFailureReasonValue.Cancelled,
          requestHeaderCount: args.requestHeaderCount,
          requestHeaders: args.requestHeaders,
          retryable: false,
          errorCode: "model_request_cancelled",
          errorPhase: "stream",
          exceptionType: "AbortError",
          streamOutputCommitted,
          timestamp: new Date(completedAt).toISOString(),
          type: "model_request_failed",
        },
        statusPublishOptions(input, admission),
      );
    }
    if (args.attemptFailed && state.awaitIteratorClose) {
      await closeStreamIteratorBestEffort(args.streamIterator, {
        attempt,
        logger: input.logger,
        result: args.result,
      });
    } else {
      void closeStreamIteratorBestEffort(args.streamIterator, {
        attempt,
        logger: input.logger,
      });
    }
  } else if (args.attemptAbortController.signal.aborted) {
    // 普通 main 保留既有生命周期：只有 caller/idle 已经 abort 时才 best-effort 关闭 iterator。
    void closeStreamIteratorBestEffort(args.streamIterator, {
      attempt,
      logger: input.logger,
    });
  }
  args.attemptAbortController.cleanup();
  // 兜底归还（成功 / 抛出 / 消费者提前 return 都到这里）；正常失败路径已在 sleep 前归还，幂等。
  admission.release();
}
