import type { SessionEvent, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { createModelStreamingEventQueue } from "./model-streaming-event-queue.js";

/**
 * 单次 model stream 的事件出口：把 streaming event queue 的三段式用法（enqueue /
 * 背压 / 排空）收成一个请求局部句柄。queue 的 owner 仍是本次请求，事件次序与背压语义不变。
 */
export function createStreamEnqueuers(input: {
  events: SessionEvent[];
  runtime: AgentRuntimeInternal;
  traceContext: TraceContext;
}) {
  const queue = createModelStreamingEventQueue(input);
  return {
    drain(): Promise<void> {
      return queue.drain();
    },
    async enqueue(payload: Parameters<typeof queue.enqueue>[0]): Promise<void> {
      queue.enqueue(payload);
      await queue.maybeApplyBackpressure();
    },
    async enqueueAndDrain(payload: Parameters<typeof queue.enqueue>[0]): Promise<void> {
      queue.enqueue(payload);
      await queue.drain();
    },
  };
}
