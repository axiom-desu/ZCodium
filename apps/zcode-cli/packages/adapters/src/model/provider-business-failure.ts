import {
  ModelErrorCode,
  ModelFailureReason as ModelFailureReasonValue,
  ModelRetryReason as ModelRetryReasonValue,
} from "@zcode/contracts";
import { getApiCallResponseBody, isContextExceededFailure } from "./failure-inspection.js";
import {
  isProviderBusinessError,
  readProviderBusinessFailureFromBody,
  ProviderBusinessError,
} from "./model-execution.js";
import {
  getProviderBusinessCodeMapping,
  isRetryableProviderBusinessNetworkFailure,
  isRetryableProviderBusinessTimeoutFailure,
} from "./failure-provider-business-codes.js";
import type { ClassifiedModelFailure } from "./failure-classifier.js";

const PROVIDER_BUSINESS_ERROR_WRAPPER_CODE = "PROVIDER_BUSINESS_ERROR";

export function classifyProviderBusinessFailureFromApiCallBody(
  error: unknown,
  statusCode?: number,
  retryAfterMs?: number,
): ClassifiedModelFailure | undefined {
  const body = getApiCallResponseBody(error);
  const detected = readProviderBusinessFailureFromBody(body);
  if (!detected) {
    return undefined;
  }

  return classifyProviderBusinessFailure(
    new ProviderBusinessError({
      providerCode: detected.providerCode,
      providerId: "unknown",
      providerKind: "openai-compatible",
      providerMessage: detected.providerMessage,
      providerRequestId: detected.providerRequestId,
      responseBodySummary: detected.responseBodySummary,
      responseStatus: statusCode ?? detected.statusCode,
      statusCode: statusCode ?? detected.statusCode,
    }),
    statusCode ?? detected.statusCode,
    retryAfterMs,
  );
}

export function classifyProviderBusinessFailure(
  error: unknown,
  statusCode?: number,
  retryAfterMs?: number,
): ClassifiedModelFailure | undefined {
  if (!isProviderBusinessError(error)) {
    return undefined;
  }

  const message = providerBusinessMessage(error);
  const providerCode = resolveProviderBusinessCode(error);
  const effectiveStatusCode = resolveProviderBusinessStatusCode(error, statusCode);
  const mappedFailure = providerCode ? getProviderBusinessCodeMapping(providerCode) : undefined;
  if (mappedFailure) {
    return {
      code: mappedFailure.code,
      message: mappedFailure.message ?? message,
      reason: mappedFailure.reason,
      retryReason: mappedFailure.retryReason,
      retryable: mappedFailure.retryable,
      retryAfterMs,
      statusCode: effectiveStatusCode,
    };
  }

  if (isContextExceededFailure(error)) {
    return {
      code: ModelErrorCode.ModelContextExceeded,
      message: "Model request exceeded the provider context window.",
      reason: ModelFailureReasonValue.ContextExceeded,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
      retryAfterMs,
      statusCode: effectiveStatusCode,
    };
  }
  if (isRetryableProviderBusinessTimeoutFailure(error, providerCode, effectiveStatusCode)) {
    return {
      code: ModelErrorCode.ModelRequestTimeout,
      message,
      reason: ModelFailureReasonValue.Timeout,
      retryReason: ModelRetryReasonValue.Timeout,
      retryable: true,
      retryAfterMs,
      statusCode: effectiveStatusCode,
    };
  }
  const retryReason =
    effectiveStatusCode !== undefined && effectiveStatusCode >= 500
      ? ModelRetryReasonValue.ServerError
      : ModelRetryReasonValue.NetworkError;

  if (effectiveStatusCode === 401 || effectiveStatusCode === 403) {
    return {
      code: ModelErrorCode.ProviderNotConfigured,
      message,
      reason: ModelFailureReasonValue.AuthFailed,
      retryReason: ModelRetryReasonValue.AuthRefresh,
      retryable: false,
      retryAfterMs,
      statusCode: effectiveStatusCode,
    };
  }

  if (effectiveStatusCode === 404) {
    return {
      code: ModelErrorCode.ModelNotFound,
      message,
      reason: ModelFailureReasonValue.InvalidRequest,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
      retryAfterMs,
      statusCode: effectiveStatusCode,
    };
  }

  if (effectiveStatusCode === 400 || effectiveStatusCode === 422) {
    return {
      code: ModelErrorCode.InvalidModelRequest,
      message,
      reason: ModelFailureReasonValue.InvalidRequest,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
      retryAfterMs,
      statusCode: effectiveStatusCode,
    };
  }

  if (effectiveStatusCode === 429) {
    return {
      code: ModelErrorCode.ModelRateLimited,
      message,
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: true,
      retryAfterMs,
      statusCode: effectiveStatusCode,
    };
  }

  if (isRetryableProviderBusinessNetworkFailure(error, providerCode)) {
    return {
      code: ModelErrorCode.ModelRequestFailed,
      message,
      reason: ModelFailureReasonValue.NetworkError,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: true,
      retryAfterMs,
      statusCode: effectiveStatusCode,
    };
  }

  if (effectiveStatusCode !== undefined && effectiveStatusCode >= 500) {
    return {
      code: ModelErrorCode.ModelRequestFailed,
      message,
      reason: ModelFailureReasonValue.ServerError,
      retryReason,
      retryable: true,
      retryAfterMs,
      statusCode: effectiveStatusCode,
    };
  }

  return {
    code: ModelErrorCode.ModelRequestFailed,
    message,
    reason: ModelFailureReasonValue.Unknown,
    retryReason,
    retryable: false,
    retryAfterMs,
    statusCode: effectiveStatusCode,
  };
}
function normalizeProviderCode(value: ProviderBusinessError["providerCode"]): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  if (normalized.length === 0) return undefined;
  return normalized.toUpperCase() === PROVIDER_BUSINESS_ERROR_WRAPPER_CODE ? undefined : normalized;
}

export function providerBusinessMessage(error: ProviderBusinessError): string {
  return error.providerMessage ?? error.message ?? "Provider returned a business error.";
}

export function resolveProviderBusinessCode(error: ProviderBusinessError): string | undefined {
  const direct = normalizeProviderCode(error.providerCode);
  if (direct) {
    return direct;
  }

  // ProviderBusinessError 可能被 AI SDK/adapter 二次包装，外层 code 是包装类型，
  // 真实 BigModel 码（如 1234/1261）只保留在 responseBodySummary 的深层结构里。
  return readNestedProviderCode(error.responseBodySummary);
}

function resolveProviderBusinessStatusCode(
  error: ProviderBusinessError,
  statusCode: number | undefined,
): number | undefined {
  return (
    normalizeHttpFailureStatus(statusCode) ??
    normalizeHttpFailureStatus(error.statusCode) ??
    normalizeHttpFailureStatus(error.responseStatus) ??
    readNestedStatusCode(error.responseBodySummary)
  );
}

function readNestedProviderCode(value: unknown): string | undefined {
  const records = collectNestedRecords(value);
  const providerCode = firstNormalizedRecordValue(records, "providerCode");
  if (providerCode) return providerCode;

  const errorCode = firstNormalizedRecordValue(records, "error_code");
  if (errorCode) return errorCode;

  const code = firstNormalizedRecordValue(records, "code");
  if (code) return code;

  return firstBracketedProviderCode(records);
}

function readNestedStatusCode(value: unknown): number | undefined {
  const records = collectNestedRecords(value);
  for (const key of ["statusCode", "status", "responseStatus"] as const) {
    for (const record of records) {
      const statusCode = numberProperty(record, key);
      if (normalizeHttpFailureStatus(statusCode) !== undefined) {
        return statusCode;
      }
    }
  }
  return undefined;
}

function firstNormalizedRecordValue(
  records: readonly Record<string, unknown>[],
  key: string,
): string | undefined {
  for (const record of records) {
    const code = normalizeProviderCode(record[key] as ProviderBusinessError["providerCode"]);
    if (code) {
      return code;
    }
  }
  return undefined;
}

function firstBracketedProviderCode(
  records: readonly Record<string, unknown>[],
): string | undefined {
  for (const record of records) {
    const code =
      readBigModelBracketedProviderCode(record.message) ??
      readBigModelBracketedProviderCode(record.providerMessage);
    if (code) {
      return code;
    }
  }
  return undefined;
}

function collectNestedRecords(value: unknown): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  const seen = new WeakSet<object>();
  const queue: unknown[] = [value];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object") {
      continue;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }

    const record = current as Record<string, unknown>;
    result.push(record);
    for (const nested of Object.values(record)) {
      if (nested && typeof nested === "object") {
        queue.push(nested);
      }
    }
  }

  return result;
}

function numberProperty(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeHttpFailureStatus(value: number | undefined): number | undefined {
  return value !== undefined && value >= 400 && value <= 599 ? value : undefined;
}

function readBigModelBracketedProviderCode(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = value.trim().match(/^\[(\d{4})\](?=\[)/);
  return match?.[1];
}
