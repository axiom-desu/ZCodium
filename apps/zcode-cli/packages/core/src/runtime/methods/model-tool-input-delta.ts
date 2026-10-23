import { traceContextToLogContext } from "../deps.js";
import type {
  Logger,
  MessageId,
  ModelStreamingPayload,
  ToolCallId,
  TraceContext,
} from "../deps.js";

const TOOL_INPUT_STREAM_DELTA_FALLBACK_FLUSH_CHARS = 4096;

function hasToolInputLineBreak(value: string): boolean {
  return (
    value.includes("\n") || value.includes("\r") || value.includes("\\n") || value.includes("\\r")
  );
}

/**
 * streaming tool input 的增量缓冲。
 *
 * 只持有本次请求的 `toolCallId -> pending delta`（请求局部状态，原本就在
 * `runModelTextRequest` 的闭包里），刷新策略决定事件何时进入 streaming event queue；
 * queue 的背压/排空仍由调用方执行，事件次序不变。
 */
export function createToolInputDeltaBuffer(input: {
  assistantMessageId: MessageId;
  enqueue: (payload: ModelStreamingPayload) => Promise<void>;
  logger: Logger | undefined;
  traceContext: TraceContext;
}) {
  const buffers = new Map<ToolCallId, string>();

  const flush = async (toolCallId: ToolCallId): Promise<void> => {
    const delta = buffers.get(toolCallId);
    if (!delta) {
      return;
    }
    buffers.delete(toolCallId);
    input.logger?.debug("Model streaming tool input delta flushed", {
      ...traceContextToLogContext(input.traceContext),
      deltaLength: delta.length,
      event: "model.streaming.tool_input_delta.flush",
      module: "core.runtime",
      toolCallId,
    });
    await input.enqueue({
      assistantMessageId: input.assistantMessageId,
      delta,
      done: false,
      kind: "tool_input_delta",
      toolCallId,
    });
  };

  return {
    discard(toolCallId: ToolCallId): void {
      buffers.delete(toolCallId);
    },
    async flush(toolCallId: ToolCallId): Promise<void> {
      await flush(toolCallId);
    },
    async flushAll(): Promise<void> {
      for (const toolCallId of Array.from(buffers.keys())) {
        await flush(toolCallId);
      }
    },
    async append(toolCallId: ToolCallId, delta: string): Promise<void> {
      if (!delta) {
        return;
      }
      const next = `${buffers.get(toolCallId) ?? ""}${delta}`;
      buffers.set(toolCallId, next);
      if (
        hasToolInputLineBreak(next) ||
        next.length >= TOOL_INPUT_STREAM_DELTA_FALLBACK_FLUSH_CHARS
      ) {
        // 实验原因：Write/Edit 的行数体验依赖 content 换行尽快到 UI。
        // 这里遇到真实/JSON 转义换行就 flush，同时保留超长单行兜底，
        // 避免没有换行的参数一直缓冲到 tool_input_end。
        await flush(toolCallId);
      }
    },
  };
}
