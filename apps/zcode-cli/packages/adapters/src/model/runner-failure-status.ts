import {
  ModelFailureReason,
  type ModelApiErrorPhase,
  type ModelFailureExceptionKind,
  type ModelUsage,
} from "@zcode/contracts";
import { APICallError } from "ai";
import { AiSdkModelAdapterError } from "./errors.js";
import {
  findProviderBusinessError,
  inspectProviderFailure,
  type ClassifiedModelFailure,
} from "./failure-classifier.js";

const MODEL_API_ERROR_PHASES = new Set<ModelApiErrorPhase>([
  "prepare",
  "configuration",
  "connect",
  "response",
  "stream",
  "parse",
  "validation",
  "unhandled",
]);

export function readModelFailureErrorPhase(error: unknown): ModelApiErrorPhase | undefined {
  if (!error || typeof error !== "object") return undefined;
  const context = (error as { context?: unknown }).context;
  if (!context || typeof context !== "object") return undefined;
  const errorPhase = (context as { errorPhase?: unknown }).errorPhase;
  return typeof errorPhase === "string" &&
    MODEL_API_ERROR_PHASES.has(errorPhase as ModelApiErrorPhase)
    ? (errorPhase as ModelApiErrorPhase)
    : undefined;
}

export function modelFailureAttributionFields(
  error: unknown,
  failure: ClassifiedModelFailure,
  errorPhase: unknown,
): {
  errorPhase?: ModelApiErrorPhase;
  exceptionKind: ModelFailureExceptionKind;
} {
  // model status 虽然记录了原始异常类型和阶段，但终态 ErrorPayload 曾丢失这些事实；
  // 这里只保留可聚合的低基数类别，避免把 provider 自定义异常名带入错误载荷。
  return {
    ...(typeof errorPhase === "string" &&
    MODEL_API_ERROR_PHASES.has(errorPhase as ModelApiErrorPhase)
      ? { errorPhase: errorPhase as ModelApiErrorPhase }
      : {}),
    exceptionKind: classifyModelFailureExceptionKind(error, failure),
  };
}

function classifyModelFailureExceptionKind(
  error: unknown,
  failure: ClassifiedModelFailure,
): ModelFailureExceptionKind {
  const transportFailure =
    failure.reason === ModelFailureReason.NetworkError ||
    failure.reason === ModelFailureReason.ProxyError ||
    failure.reason === ModelFailureReason.StaleConnection ||
    failure.reason === ModelFailureReason.StreamIdleTimeout ||
    failure.reason === ModelFailureReason.Timeout ||
    failure.reason === ModelFailureReason.TlsError;
  if (transportFailure) return "transport";
  if (findProviderBusinessError(error)) return "provider_business";
  if (APICallError.isInstance(error)) return "api_call";

  const name = errorName(error);
  if (name === "AiSdkModelAdapterError" || name === "ModelProtocolError") return "protocol";
  if (name === "TypeError") return "type_error";
  if (name && /validation|zod|parseerror|jsonparse/iu.test(name)) return "validation";
  return "generic";
}

function errorName(error: unknown): string | undefined {
  if (error instanceof Error) return error.name || error.constructor.name;
  if (!error || typeof error !== "object") return undefined;
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

export function modelFailureStatusFields(
  error: unknown,
  failure: ClassifiedModelFailure,
  errorPhase: ModelApiErrorPhase,
): {
  errorCode: ClassifiedModelFailure["code"];
  errorPhase: ModelApiErrorPhase;
  exceptionType?: string;
  providerErrorCode?: string;
  providerErrorMessage?: string;
  providerRequestId?: string;
  retryAfterMs?: number;
} {
  return {
    errorCode: failure.code,
    errorPhase,
    exceptionType: exceptionType(error),
    retryAfterMs: failure.retryAfterMs,
    ...inspectProviderFailure(error),
  };
}

/**
 * 失败事件里 provider 真实报告的用量。
 * 只在 `AiSdkModelAdapterError` 携带 usage 时出现（空输出上下文超窗），
 * 因此重试中的失败不会带 usage，成功 `ModelComplete` 仍是唯一成功入账。
 */
export function failureUsageFields(error: unknown): { usage?: ModelUsage } {
  return error instanceof AiSdkModelAdapterError && error.usage ? { usage: error.usage } : {};
}

export function providerRequestIdFromHeaders(headers: Record<string, string>): string | undefined {
  for (const candidate of [
    "x-request-id",
    "request-id",
    "x-amzn-requestid",
    "x-amz-request-id",
    "cf-ray",
  ]) {
    const value = Object.entries(headers).find(([name]) => name.toLowerCase() === candidate)?.[1];
    if (value?.trim()) return value.trim().slice(0, 256);
  }
  return undefined;
}

function exceptionType(error: unknown): string | undefined {
  if (error instanceof Error) return error.name || error.constructor.name;
  if (error && typeof error === "object") {
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && name.trim()) return name.trim().slice(0, 128);
  }
  return undefined;
}
