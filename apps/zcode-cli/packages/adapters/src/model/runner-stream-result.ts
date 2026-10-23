import type { ModelStreamEvent } from "@zcode/contracts";
import type { TerminalStreamChunkError } from "./runner-retry.js";

type StreamChunkOutcome = {
  emittedError: boolean;
  emittedEvent: boolean;
  emittedRetryBoundaryEvent: boolean;
  retryScheduled: boolean;
  terminalError?: TerminalStreamChunkError;
  visibleEvents: ModelStreamEvent[];
};

// 单 chunk 处理结果是纯数据投影，chunk 处理与错误处理共享同一形状。
export function streamChunkResult(overrides: Partial<StreamChunkOutcome> = {}): StreamChunkOutcome {
  return {
    emittedError: false,
    emittedEvent: false,
    emittedRetryBoundaryEvent: false,
    retryScheduled: false,
    visibleEvents: [],
    ...overrides,
  };
}
