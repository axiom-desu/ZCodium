import type { Logger, ModelStatusSink, ModelTextResult } from "@zcode/contracts";
import type { AiSdkModelRuntime, AiSdkModelTextRequest } from "./runner-runtime.js";
import {
  normalizeReasoning,
  normalizeSources,
  normalizeToolCalls,
  normalizeToolResults,
  normalizeUsage,
} from "./runner-normalization.js";
import { logGenerateTextDiagnostics } from "./runner-diagnostics.js";
import { createStatusContext, publishModelStatus } from "./runner-status.js";
import type { AttemptAdmission } from "./request-admission.js";
import { statusPublishOptions } from "./runner-status-publish.js";
import { providerRequestIdFromHeaders } from "./runner-failure-status.js";

type GenerateTextResult = Awaited<ReturnType<AiSdkModelRuntime["generateText"]>>;

interface GenerateTextOutput {
  reasoning: ModelTextResult["reasoning"];
  sources: ModelTextResult["sources"];
  text: string;
  toolCalls: ModelTextResult["toolCalls"];
  toolResults: ModelTextResult["toolResults"];
  usage: ModelTextResult["usage"];
}

// 响应归一化是无副作用纯转换：保持原字段来源与顺序，只从 runGenerateText 抽出。
export function normalizeGenerateTextOutput(
  result: GenerateTextResult,
  request: AiSdkModelTextRequest,
  logger?: Logger,
): GenerateTextOutput {
  const usage = normalizeUsage(result.totalUsage ?? result.usage);
  const toolCalls = normalizeToolCalls(result, logger);
  const toolResults = normalizeToolResults(result, toolCalls);
  const sources = normalizeSources(result);
  const text = request.responseJsonSchema ? serializeStructuredOutput(result) : result.text;
  const reasoning = normalizeReasoning(result.reasoning);
  return { usage, toolCalls, toolResults, sources, text, reasoning };
}

function serializeStructuredOutput(result: unknown): string {
  const output = (result as { output?: unknown }).output;
  if (output === undefined) {
    throw new Error("Structured output is unavailable");
  }
  const serialized = JSON.stringify(output);
  if (serialized === undefined) {
    throw new Error("Structured output is unavailable");
  }
  return serialized;
}

export function waitForGenerateTextOrAbort<T>(
  pending: Promise<T>,
  abortSignal: AbortSignal | undefined,
): Promise<T> {
  if (!abortSignal) {
    return pending;
  }

  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => {
      abortSignal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(
        abortSignal.reason instanceof Error
          ? abortSignal.reason
          : new Error("Model request was cancelled."),
      );
    };

    if (abortSignal.aborted) {
      onAbort();
      return;
    }

    abortSignal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export async function publishGenerateTextCompleted(input: {
  admission?: AttemptAdmission;
  attempt: number;
  completedAt: number;
  logger?: Logger;
  request: AiSdkModelTextRequest;
  requestHeaderCount: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  result: GenerateTextResult;
  startedAt: number;
  statusContext: ReturnType<typeof createStatusContext>;
  statusSink?: ModelStatusSink;
  toolCallCount: number;
  usage: GenerateTextOutput["usage"];
}): Promise<void> {
  logGenerateTextDiagnostics({
    attempt: input.attempt,
    completedAt: input.completedAt,
    logger: input.logger,
    result: input.result,
    statusContext: input.statusContext,
    startedAt: input.startedAt,
    toolCallCount: input.toolCallCount,
    usage: input.usage,
  });
  await publishModelStatus(
    {
      ...input.statusContext,
      attempt: input.attempt,
      durationMs: input.completedAt - input.startedAt,
      finishReason: input.result.finishReason,
      requestHeaderCount: input.requestHeaderCount,
      requestHeaders: input.requestHeaders,
      responseHeaderCount: Object.keys(input.responseHeaders).length,
      responseHeaders: input.responseHeaders,
      providerRequestId: providerRequestIdFromHeaders(input.responseHeaders),
      timestamp: new Date(input.completedAt).toISOString(),
      type: "model_request_completed",
      usage: input.usage,
    },
    statusPublishOptions(input, input.admission),
  );
}
