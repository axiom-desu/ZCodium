import type { TextStreamPart, ToolSet } from "ai";
import type { Logger, ModelStreamEvent } from "@zcode/contracts";
import { sanitizeModelNetworkHeaders } from "./runner-network-headers.js";
import type { AiSdkStreamTextResult } from "./runner-runtime.js";

const STREAM_ATTEMPT_CLEANUP_TIMEOUT_MS = 1_000;

export async function closeStreamIteratorBestEffort(
  streamIterator: AsyncIterator<TextStreamPart<ToolSet>> | undefined,
  options: { attempt: number; logger?: Logger; result?: AiSdkStreamTextResult },
): Promise<void> {
  const cleanupOperations: Array<{ name: string; promise: Promise<unknown> }> = [];
  if (streamIterator?.return) {
    cleanupOperations.push({
      name: "iterator.return",
      promise: Promise.resolve().then(() => streamIterator.return?.()),
    });
  }
  if (options.result?.consumeStream) {
    cleanupOperations.push({
      name: "result.consumeStream",
      // AI SDK fullStream getter 会 tee 并把另一支保存在 baseStream；
      // 只等待外层 iterator.return() 仍可能让底层 reader/连接槽继续被保留。
      promise: Promise.resolve().then(() => options.result?.consumeStream()),
    });
  }
  if (cleanupOperations.length === 0) return;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    Promise.allSettled(cleanupOperations.map((operation) => operation.promise)).then((results) => ({
      results,
      type: "settled" as const,
    })),
    new Promise<{ type: "timed_out" }>((resolve) => {
      timeout = setTimeout(() => resolve({ type: "timed_out" }), STREAM_ATTEMPT_CLEANUP_TIMEOUT_MS);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);

  if (outcome.type === "timed_out") {
    options.logger?.warn("Model stream attempt cleanup timed out", {
      attempt: options.attempt,
      cleanupOperations: cleanupOperations.map((operation) => operation.name),
      event: "model.stream_attempt_cleanup.timeout",
      status: "waiting",
      timeoutMs: STREAM_ATTEMPT_CLEANUP_TIMEOUT_MS,
    });
    return;
  }

  const failures = outcome.results.flatMap((result, index) =>
    result.status === "rejected"
      ? [
          {
            errorMessage:
              result.reason instanceof Error ? result.reason.message : String(result.reason),
            operation: cleanupOperations[index]?.name,
          },
        ]
      : [],
  );
  if (failures.length > 0) {
    // 异步清理失败或超时只能降级告警，不能覆盖原始 provider/retry 错误。
    options.logger?.warn("Model stream attempt cleanup failed", {
      attempt: options.attempt,
      event: "model.stream_attempt_cleanup.failed",
      failures,
      status: "failed",
    });
  }
}

export function observeVisibleStreamEvent(
  event: ModelStreamEvent,
  elapsed: number,
): { contentMs?: number; textMs?: number; outputCommitted: boolean } {
  switch (event.type) {
    case "text_delta":
      return {
        contentMs: elapsed,
        textMs: event.text ? elapsed : undefined,
        outputCommitted: true,
      };
    case "reasoning_delta":
    case "tool_input_delta":
    case "tool_call":
      return { contentMs: elapsed, outputCommitted: true };
    case "text_start":
    case "reasoning_start":
    case "tool_input_start":
      return { contentMs: elapsed, outputCommitted: false };
    case "compact_stream_boundary":
      return {
        contentMs: event.boundary === "provider_content_block_start" ? elapsed : undefined,
        outputCommitted:
          event.boundary === "provider_content_block_stop" ||
          event.boundary === "inferred_content_block_stop",
      };
    default:
      return { outputCommitted: false };
  }
}

export async function resolveStreamResponseHeaders(
  result: AiSdkStreamTextResult,
): Promise<Record<string, string>> {
  try {
    const response = await (result as unknown as { response?: Promise<unknown> }).response;
    return sanitizeModelNetworkHeaders((response as { headers?: unknown } | undefined)?.headers);
  } catch {
    return {};
  }
}
