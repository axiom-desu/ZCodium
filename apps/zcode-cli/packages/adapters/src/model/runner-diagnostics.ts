import type { LanguageModelUsage } from "ai";
import type { Logger, ModelUsage } from "@zcode/contracts";
import { ModelErrorCode, ModelFailureReason as ModelFailureReasonValue } from "@zcode/contracts";
import { AiSdkModelAdapterError } from "./errors.js";
import type { ClassifiedModelFailure } from "./failure-classifier.js";
import type { AiSdkGenerateTextResult } from "./runner-runtime.js";
import { normalizeUsage } from "./runner-normalization.js";
import { asRecord, stringProperty } from "./runner-record.js";
import { modelStatusContextToLogContext, type ModelStatusContext } from "./runner-status.js";

type GenerateTextResultWithMetadata = AiSdkGenerateTextResult & {
  request?: { body?: unknown };
  response?: {
    body?: unknown;
    headers?: Record<string, string>;
    id?: string;
    messages?: unknown[];
    modelId?: string;
    timestamp?: Date;
  };
  steps?: unknown[];
};

interface StreamDiagnostics {
  chunkCounts: Record<string, number>;
  errorChunkCount: number;
  finishReason?: string;
  lastChunkType?: string;
  lastErrorChunk?: unknown;
  lastFinishChunk?: unknown;
  rawFinishReason?: unknown;
  reasoningDeltaChars: number;
  /** 推理帧出现（含只带签名/加密载荷的空文本帧）：与 Node `hasReasoningContent` 同义。 */
  hasReasoningContent: boolean;
  textDeltaChars: number;
  toolCallCount: number;
  usage?: ModelUsage;
}

export function createStreamDiagnostics(): StreamDiagnostics {
  return {
    chunkCounts: {},
    errorChunkCount: 0,
    reasoningDeltaChars: 0,
    hasReasoningContent: false,
    textDeltaChars: 0,
    toolCallCount: 0,
  };
}

export function recordStreamChunkDiagnostic(diagnostics: StreamDiagnostics, chunk: unknown): void {
  const record = asRecord(chunk);
  const chunkType = safeChunkType(record.type);
  diagnostics.lastChunkType = chunkType;
  diagnostics.chunkCounts[chunkType] = (diagnostics.chunkCounts[chunkType] ?? 0) + 1;

  if (chunkType === "text-delta") {
    diagnostics.textDeltaChars += stringProperty(record, "text")?.length ?? 0;
    return;
  }

  if (chunkType.startsWith("reasoning-")) {
    // 空文本可能携带有效的 reasoning 签名，不能当作空超窗丢弃。
    diagnostics.hasReasoningContent ||= Object.keys(asRecord(record.providerMetadata)).length > 0;
  }
  if (chunkType === "reasoning-delta") {
    diagnostics.reasoningDeltaChars += stringProperty(record, "text")?.length ?? 0;
    diagnostics.hasReasoningContent ||=
      (stringProperty(record, "delta") ?? stringProperty(record, "text") ?? "").length > 0;
    return;
  }

  if (chunkType === "tool-call") {
    diagnostics.toolCallCount += 1;
    return;
  }

  if (chunkType === "finish") {
    diagnostics.finishReason = stringProperty(record, "finishReason") ?? diagnostics.finishReason;
    diagnostics.rawFinishReason =
      record.rawFinishReason ?? asRecord(record.providerMetadata).rawFinishReason;
    diagnostics.lastFinishChunk = chunk;
    diagnostics.usage = normalizeUsage(
      (record.totalUsage ?? record.usage) as Partial<LanguageModelUsage> | undefined,
    );
    return;
  }

  if (chunkType === "error") {
    diagnostics.errorChunkCount += 1;
    diagnostics.lastErrorChunk = chunk;
  }
}

export function getGenerateTextResultMetadata(
  result?: AiSdkGenerateTextResult,
): GenerateTextResultWithMetadata | undefined {
  return result as GenerateTextResultWithMetadata | undefined;
}

export function logGenerateTextDiagnostics(input: {
  attempt: number;
  completedAt: number;
  logger?: Logger;
  result: AiSdkGenerateTextResult;
  startedAt: number;
  statusContext: ModelStatusContext;
  toolCallCount: number;
  usage: ModelUsage;
}): void {
  const textLength = input.result.text.length;
  const context = {
    ...modelStatusContextToLogContext(input.statusContext, input.attempt),
    durationMs: input.completedAt - input.startedAt,
    event: "model.sdk.generate.completed",
    finishReason: safeFinishReason(input.result.finishReason),
    module: "adapters.model",
    status: "completed" as const,
    textLength,
    toolCallCount: input.toolCallCount,
    ...summarizeModelUsage(input.usage),
  };

  input.logger?.info("AI SDK generateText resolved", context);
  if (
    isSuspiciousModelCompletion({
      finishReason: safeFinishReason(input.result.finishReason),
      textLength,
      toolCallCount: input.toolCallCount,
      usage: input.usage,
    })
  ) {
    input.logger?.warn("AI SDK generateText returned an empty non-stop result", {
      ...context,
      event: "model.sdk.generate.suspicious_empty",
    });
  }
}

export function logStreamDiagnostics(input: {
  attempt: number;
  diagnostics: StreamDiagnostics;
  durationMs: number;
  emittedError: boolean;
  emittedEvent: boolean;
  logger?: Logger;
  outboundHeaders?: Record<string, string>;
  statusContext: ModelStatusContext;
}): void {
  const context = {
    ...modelStatusContextToLogContext(input.statusContext, input.attempt),
    chunkCounts: input.diagnostics.chunkCounts,
    durationMs: input.durationMs,
    emittedError: input.emittedError,
    emittedEvent: input.emittedEvent,
    event: "model.sdk.stream.completed",
    errorChunkCount: input.diagnostics.errorChunkCount,
    finishReason: safeFinishReason(input.diagnostics.finishReason),
    lastChunkType: input.diagnostics.lastChunkType,
    module: "adapters.model",
    reasoningDeltaChars: input.diagnostics.reasoningDeltaChars,
    status: "completed" as const,
    textDeltaChars: input.diagnostics.textDeltaChars,
    toolCallCount: input.diagnostics.toolCallCount,
    ...summarizeModelUsage(input.diagnostics.usage),
  };

  input.logger?.info("AI SDK stream completed", context);
  if (
    isSuspiciousModelCompletion({
      finishReason: safeFinishReason(input.diagnostics.finishReason),
      textLength: input.diagnostics.textDeltaChars,
      toolCallCount: input.diagnostics.toolCallCount,
      usage: input.diagnostics.usage,
    })
  ) {
    input.logger?.warn("AI SDK stream returned an empty non-stop result", {
      ...context,
      event: "model.sdk.stream.suspicious_empty",
    });
  }
}

export function logStreamFailureDiagnostics(input: {
  attempt: number;
  canRetry: boolean;
  diagnostics: StreamDiagnostics;
  durationMs: number;
  emittedError: boolean;
  emittedEvent: boolean;
  emittedRetryBoundaryEvent: boolean;
  error: unknown;
  failure: ClassifiedModelFailure;
  logger?: Logger;
  statusContext: ModelStatusContext;
}): void {
  input.logger?.error("AI SDK stream failed", undefined, {
    ...modelStatusContextToLogContext(input.statusContext, input.attempt),
    chunkCounts: input.diagnostics.chunkCounts,
    durationMs: input.durationMs,
    emittedError: input.emittedError,
    emittedEvent: input.emittedEvent,
    emittedRetryBoundaryEvent: input.emittedRetryBoundaryEvent,
    errorAfterFinish: input.diagnostics.finishReason !== undefined,
    errorChunkCount: input.diagnostics.errorChunkCount,
    event: "model.sdk.stream.failed",
    finishReason: safeFinishReason(input.diagnostics.finishReason),
    lastChunkType: input.diagnostics.lastChunkType,
    module: "adapters.model",
    reason: input.failure.reason,
    reasoningDeltaChars: input.diagnostics.reasoningDeltaChars,
    retryable: input.canRetry,
    status: input.failure.reason === ModelFailureReasonValue.Cancelled ? "cancelled" : "failed",
    statusCode: input.failure.statusCode,
    textDeltaChars: input.diagnostics.textDeltaChars,
    toolCallCount: input.diagnostics.toolCallCount,
    ...summarizeModelUsage(input.diagnostics.usage),
  });
}

export function logIgnoredStreamChunk(input: {
  attempt: number;
  chunk: unknown;
  logger?: Logger;
  statusContext: ModelStatusContext;
}): void {
  input.logger?.debug("AI SDK stream chunk was ignored", {
    ...modelStatusContextToLogContext(input.statusContext, input.attempt),
    ...summarizeStreamChunk(input.chunk),
    event: "model.sdk.stream.chunk_ignored",
    module: "adapters.model",
    status: "completed",
  });
}

function summarizeStreamChunk(chunk: unknown): Record<string, unknown> {
  const record = asRecord(chunk);
  return {
    chunkType: safeChunkType(record.type),
    finishReason: safeFinishReason(record.finishReason),
  };
}

function summarizeModelUsage(usage?: ModelUsage): Record<string, unknown> | undefined {
  if (!usage) return undefined;
  return {
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    serverToolUse: usage.serverToolUse,
    totalTokens: usage.totalTokens,
  };
}

export function isSuspiciousStreamDiagnostics(diagnostics: StreamDiagnostics): boolean {
  return isSuspiciousModelCompletion({
    finishReason: diagnostics.finishReason,
    textLength: diagnostics.textDeltaChars,
    toolCallCount: diagnostics.toolCallCount,
    usage: diagnostics.usage,
  });
}

const CONTEXT_LIMIT_FINISH_REASONS = new Set([
  "context_exceeded",
  "context_length_exceeded",
  "context_window_exceeded",
  "model_context_exceeded",
  "model_context_window_exceeded",
  "prompt_too_long",
]);

const EMPTY_COMPLETION_RETRY_EXCLUSIONS = new Set([
  ...CONTEXT_LIMIT_FINISH_REASONS,
  "refusal",
  "content-filter",
  "content_filter",
]);

/**
 * 空输出 + provider 上下文超窗 → 真实请求失败（ModelContextExceeded）。
 *
 * 只有“无任何有效输出”才转换；partial 输出保留原上游语义（成功响应截断仍归 Continue）。
 * 转换必须发生在成功终态之前，让已报告的 usage 随失败结算一次。
 */
export function createEmptyContextExceededError(input: {
  finishReason?: string;
  rawFinishReason?: unknown;
  hasAssistantContent: boolean;
  toolCallCount: number;
  usage?: ModelUsage;
}): AiSdkModelAdapterError | undefined {
  // 只转换无有效输出的明确超窗；任何 partial 都保留给原调用方，不能迁移 Core 的续写策略。
  if (input.hasAssistantContent || input.toolCallCount > 0) return undefined;
  if (
    ![input.finishReason, input.rawFinishReason].some(
      (reason) =>
        typeof reason === "string" && CONTEXT_LIMIT_FINISH_REASONS.has(reason.trim().toLowerCase()),
    )
  )
    return undefined;
  // 在成功终态前走既有失败链，避免无效 Continue 和遗留的成功请求身份；已报告用量随失败结算。
  return new AiSdkModelAdapterError(
    ModelErrorCode.ModelContextExceeded,
    "Model request exceeded the provider context window.",
    {
      usage: input.usage,
      context: { finishReason: input.finishReason, rawFinishReason: input.rawFinishReason },
    },
  );
}

function excludesEmptyCompletionRetry(value: unknown): boolean {
  return (
    typeof value === "string" && EMPTY_COMPLETION_RETRY_EXCLUSIONS.has(value.trim().toLowerCase())
  );
}

export function isZeroOutputModelCompletion(input: {
  finishReason?: string;
  rawFinishReason?: unknown;
  reasoningLength: number;
  textLength: number;
  toolCallCount: number;
  usage?: ModelUsage;
}): boolean {
  // 上下文超限、拒绝和内容过滤已有明确原因；此前零输出会先被原样重试。
  // 这三类结果直接交给 core；普通输出额度和其他原因保持现有空响应重试边界。
  if (
    excludesEmptyCompletionRetry(input.finishReason) ||
    excludesEmptyCompletionRetry(input.rawFinishReason)
  ) {
    return false;
  }
  return (
    input.finishReason !== undefined &&
    input.reasoningLength === 0 &&
    isSuspiciousModelCompletion({
      finishReason: input.finishReason,
      textLength: input.textLength,
      toolCallCount: input.toolCallCount,
      usage: input.usage,
    })
  );
}

function isSuspiciousModelCompletion(input: {
  finishReason?: string;
  textLength: number;
  toolCallCount: number;
  usage?: ModelUsage;
}): boolean {
  return (
    input.textLength === 0 &&
    input.toolCallCount === 0 &&
    isNonStopFinish(input.finishReason) &&
    isZeroUsage(input.usage)
  );
}

function isNonStopFinish(finishReason?: string): boolean {
  const normalized = finishReason?.trim().toLowerCase();
  return normalized !== "stop" && normalized !== "tool-calls" && normalized !== "tool_calls";
}

function isZeroUsage(usage?: ModelUsage): boolean {
  if (!usage) return true;
  const serverToolUse =
    (usage.serverToolUse?.webSearchRequests ?? 0) + (usage.serverToolUse?.webFetchRequests ?? 0);
  if (serverToolUse > 0) return false;
  const total =
    usage.totalTokens ??
    (usage.inputTokens ?? 0) +
      (usage.outputTokens ?? 0) +
      (usage.cacheReadTokens ?? 0) +
      (usage.cacheWriteTokens ?? 0) +
      (usage.reasoningTokens ?? 0);
  return total === 0;
}

function safeChunkType(value: unknown): string {
  switch (value) {
    case "text-start":
    case "text-delta":
    case "text-end":
    case "reasoning-start":
    case "reasoning-delta":
    case "reasoning-end":
    case "tool-call":
    case "tool-result":
    case "tool-error":
    case "tool-input-start":
    case "tool-input-delta":
    case "tool-input-end":
    case "start":
    case "start-step":
    case "finish":
    case "finish-step":
    case "abort":
    case "error":
    case "raw":
    case "source":
    case "file":
      return value;
    default:
      return "other";
  }
}

function safeFinishReason(value: unknown): string {
  switch (value) {
    case "stop":
    case "length":
    case "content-filter":
    case "tool-calls":
    case "error":
    case "other":
    case "unknown":
      return value;
    default:
      return "unknown";
  }
}
