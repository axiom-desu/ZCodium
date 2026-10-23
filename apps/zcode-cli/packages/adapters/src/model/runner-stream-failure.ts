import {
  ModelFailureReason as ModelFailureReasonValue,
  type ModelRetryBudget,
} from "@zcode/contracts";
import {
  findProviderBusinessError,
  inspectProviderFailure,
  type ClassifiedModelFailure,
} from "./failure-classifier.js";
import { getErrorCode, getHttpResponseStatus, unwrapRetryError } from "./failure-inspection.js";
import { isModelStreamIdleTimeoutError } from "./stream-idle-timeout.js";
import { retryBudgetAllows } from "./retry-budget.js";
import { retryAllowedByFailurePolicy } from "./workflow-model-failure-policy.js";

type StreamFailurePhase = "request_setup" | "response_body";

function classifyStreamFailurePhase(input: {
  emittedRetryBoundaryEvent: boolean;
  httpResponseStatus?: number;
  responseHeaders: Record<string, string>;
  streamErrorChunkObserved?: boolean;
  streamIteratorCreated?: boolean;
}): StreamFailurePhase | undefined {
  if (input.streamIteratorCreated === false) {
    return "request_setup";
  }
  if (input.emittedRetryBoundaryEvent) {
    return "response_body";
  }

  const responseStatus = input.httpResponseStatus;
  if (responseStatus !== undefined) {
    if (responseStatus >= 200 && responseStatus < 300) {
      return "response_body";
    }
    if (responseStatus >= 300 && responseStatus < 600) {
      return "request_setup";
    }
  }

  if (input.streamErrorChunkObserved) {
    // error chunk 本身证明 stream body 已开始；其中的 ProviderBusinessError.statusCode
    // 可能只是业务分类，不能反推成 HTTP request setup。明确 transport status 仍由上面的分支优先。
    return "response_body";
  }

  const contentType = readHeader(input.responseHeaders, "content-type")?.toLowerCase();
  if (contentType?.includes("text/event-stream")) {
    return "response_body";
  }
  return undefined;
}

export function compactStreamFailureContext(
  preserveProviderStreamBoundaries: boolean | undefined,
  streamFailurePhase: StreamFailurePhase | undefined,
  httpResponseStatus?: number,
): Record<string, unknown> | undefined {
  if (preserveProviderStreamBoundaries !== true || !streamFailurePhase) {
    return undefined;
  }
  return {
    ...(httpResponseStatus !== undefined ? { httpResponseStatus } : {}),
    streamFailurePhase,
  };
}

export function resolveStreamFailureDecision(input: {
  attempt: number;
  emittedRetryBoundaryEvent: boolean;
  error: unknown;
  failure: ClassifiedModelFailure;
  maxAttempts: number;
  preserveProviderStreamBoundaries?: boolean;
  responseHeaders: Record<string, string>;
  retryBudget?: ModelRetryBudget;
  streamErrorChunkObserved?: boolean;
  streamIteratorCreated?: boolean;
}): { canRetry: boolean; context?: Record<string, unknown> } {
  const httpResponseStatus = input.preserveProviderStreamBoundaries
    ? resolveCompactHttpResponseStatus(input.error)
    : undefined;
  const streamFailurePhase = input.preserveProviderStreamBoundaries
    ? classifyStreamFailurePhase({
        emittedRetryBoundaryEvent: input.emittedRetryBoundaryEvent,
        httpResponseStatus,
        responseHeaders: input.responseHeaders,
        streamErrorChunkObserved: input.streamErrorChunkObserved,
        streamIteratorCreated: input.streamIteratorCreated,
      })
    : undefined;

  return {
    canRetry: canRetryStreamFailure({
      attempt: input.attempt,
      emittedRetryBoundaryEvent: input.emittedRetryBoundaryEvent,
      error: input.error,
      failure: input.failure,
      httpResponseStatus,
      maxAttempts: input.maxAttempts,
      preserveProviderStreamBoundaries: input.preserveProviderStreamBoundaries,
      retryBudget: input.retryBudget,
      streamFailurePhase,
    }),
    context: compactStreamFailureContext(
      input.preserveProviderStreamBoundaries,
      streamFailurePhase,
      httpResponseStatus,
    ),
  };
}

function canRetryStreamFailure(input: {
  attempt: number;
  emittedRetryBoundaryEvent: boolean;
  error: unknown;
  failure: ClassifiedModelFailure;
  httpResponseStatus?: number;
  maxAttempts: number;
  preserveProviderStreamBoundaries?: boolean;
  retryBudget?: ModelRetryBudget;
  streamFailurePhase?: StreamFailurePhase;
}): boolean {
  // workflow 流量（无上限预算）不读分类器的 retryable，读策略表：只有确定性的模型侧错误
  // 才不重试；3008/3009/3010 这类并发上限在这里是 retry。
  const providerCode = inspectProviderFailure(input.error).providerErrorCode;
  // 可见输出已发出后绝不重放（交给 core 的 stream recovery）；预算门在 unbounded 下恒开。
  if (
    input.emittedRetryBoundaryEvent ||
    !retryBudgetAllows(input.retryBudget, input.attempt, input.maxAttempts)
  ) {
    return false;
  }

  if (input.failure.reason === ModelFailureReasonValue.Cancelled) {
    return false;
  }

  if (
    input.preserveProviderStreamBoundaries === true &&
    isCompactStaleStreamFailure(input.error, input.httpResponseStatus)
  ) {
    // compact 请求允许重试 EPIPE/ConnectionClosed；它们不在通用
    // model failure retryable 集合中，必须先于通用 gate 判定。
    return true;
  }

  if (!retryAllowedByFailurePolicy(input.failure, input.retryBudget, providerCode)) {
    return false;
  }

  // setup failure 保留既有 adapter/API retry；compact 的 SSE protocol/business body error
  // 不再重放，耗尽后的 non-stream fallback 由 Core 按 commit boundary 处理。
  return (
    input.preserveProviderStreamBoundaries !== true || input.streamFailurePhase !== "response_body"
  );
}

function resolveCompactHttpResponseStatus(error: unknown): number | undefined {
  const unwrapped = unwrapRetryError(error);
  // ProviderBusinessError.responseStatus 是 fetch 层保留的 transport status；外层
  // APICallError/statusCode 可能已被业务码覆盖，因此必须优先使用这一硬证据。
  return findProviderBusinessError(unwrapped)?.responseStatus ?? getHttpResponseStatus(unwrapped);
}

function isCompactStaleStreamFailure(
  error: unknown,
  httpResponseStatus: number | undefined,
): boolean {
  const unwrapped = unwrapRetryError(error);
  if (isModelStreamIdleTimeoutError(unwrapped)) {
    return true;
  }

  if (isCompactStaleCode(getErrorCode(unwrapped))) {
    return true;
  }
  if (httpResponseStatus !== undefined) {
    return false;
  }

  const providerCode = findProviderBusinessError(unwrapped)?.providerCode;
  return isCompactStaleCode(typeof providerCode === "number" ? String(providerCode) : providerCode);
}

function isCompactStaleCode(value: string | undefined): boolean {
  const normalized = value?.trim().toUpperCase();
  return normalized === "ECONNRESET" || normalized === "EPIPE" || normalized === "CONNECTIONCLOSED";
}

function readHeader(headers: Record<string, string>, name: string): string | undefined {
  const normalizedName = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === normalizedName)?.[1];
}
