import type { SessionEvent } from "@zcode/contracts";
import {
  ConversationTopicPublisher,
  ProjectionPayloadTooLargeError,
} from "./conversation-topic-publisher.js";
import type { GatewayState } from "./v4-gateway-state.js";
import {
  ProjectionEventCommitWaitError,
  type HydrationBuffer,
  type RawSequenceState,
} from "./v4-gateway-contract.js";
import * as sequence from "./v4-gateway-sequence.js";

/** 重放所需的根状态窄面（sequence state + 错误上报）。 */
type ReplayDomainState = Pick<
  GatewayState,
  "host" | "projectionEventCommitWaiters" | "rawSequenceStates"
>;

/**
 * 把 hydration 期间缓存的 raw event 与上一轮 sequence state 的 raw tail 合并后重放。
 *
 * 持久读取的 sourceEventSeq 是 load 开始时的水位；hydration buffer 只能记录 load 开始
 * 后的事件。若 seq=N 已在 buffer 创建前进入 live publisher，而 load 只读到 N-1 时，
 * rehydrate 后不能仅重放 N+1：raw reorder 会永久等待已经被丢掉的 N，连带让 running
 * Agent 控制行消失。因此保留与 publisher 相同大小的 raw tail，与 await 窗口 buffer
 * 合并后从持久边界连续重放。
 */
export function replayHydratedRawEvents(
  ctx: ReplayDomainState,
  sessionId: string,
  publisher: ConversationTopicPublisher,
  sourceEventSeq: number,
  previousSequenceState: RawSequenceState | undefined,
  buffer: HydrationBuffer,
): void {
  const replayByEventId = new Map<string, SessionEvent>();
  for (const rawEvent of previousSequenceState?.recentRawEventsById.values() ?? []) {
    if (rawEvent.sequenceNumber <= 0 || rawEvent.sequenceNumber > sourceEventSeq) {
      replayByEventId.set(String(rawEvent.id), rawEvent);
    }
  }
  for (const rawEvent of buffer.rawEvents) {
    if (rawEvent.sequenceNumber <= 0 || rawEvent.sequenceNumber > sourceEventSeq) {
      replayByEventId.set(String(rawEvent.id), rawEvent);
    }
  }
  const replayEvents = [...replayByEventId.values()].sort((left, right) => {
    if (left.sequenceNumber > 0 && right.sequenceNumber > 0) {
      return left.sequenceNumber - right.sequenceNumber;
    }
    if (left.sequenceNumber > 0) return -1;
    if (right.sequenceNumber > 0) return 1;
    return 0;
  });
  for (const rawEvent of replayEvents) {
    for (const normalized of sequence.normalizeRuntimeEventSequence(ctx, sessionId, rawEvent)) {
      try {
        publisher.ingest(normalized);
        sequence.resolveProjectionEventCommit(ctx, sessionId, String(normalized.id));
      } catch (error) {
        sequence.rejectProjectionEventCommit(
          ctx,
          sessionId,
          String(normalized.id),
          new ProjectionEventCommitWaitError(
            "fault.projectionEventCommit.applyFailed",
            `projection failed to apply hydrated event ${String(normalized.id)}`,
            { cause: error },
          ),
        );
        if (!(error instanceof ProjectionPayloadTooLargeError)) throw error;
        ctx.host.onError?.("v4.hydrate.payloadTooLarge", error, {
          phase: "replayBufferedEvents",
          sessionId,
        });
      }
    }
  }
}
