import type { ConversationTopicFrame } from "@zcode/shared/zcode-protocol-v4";
import type { TopicFrameReservation } from "./topic-frame-reservation.js";
import {
  appendConversationSubscriberBuffer,
  type Subscription,
} from "./conversation-topic-subscription.js";

/** 恢复 admission 失败时原子退回被替换的 buffer/sentSeq/inFlight。 */
export function resyncSubscriptionRollback(input: {
  subscription: Subscription;
  reservation: TopicFrameReservation<ConversationTopicFrame>;
  previous: Pick<
    Subscription,
    "buffer" | "bufferBytes" | "resyncRequired" | "sentSeq" | "inFlight"
  >;
  maxOps: number;
  maxBytes: number;
  isCurrent(subscription: Subscription): boolean;
}): () => boolean {
  let rolledBack = false;
  return (): boolean => {
    if (rolledBack) return true;
    if (!input.isCurrent(input.subscription) || input.subscription.inFlight !== input.reservation) {
      return false;
    }
    const recoveryBuffer = input.subscription.buffer;
    const recoveryResyncRequired = input.subscription.resyncRequired;
    const merged = appendConversationSubscriberBuffer(input.previous.buffer, recoveryBuffer, {
      maxOps: input.maxOps,
      maxBytes: input.maxBytes,
    });
    if (merged.kind === "overflow" || input.previous.resyncRequired || recoveryResyncRequired) {
      input.subscription.buffer = [];
      input.subscription.bufferBytes = 0;
      input.subscription.resyncRequired = true;
    } else {
      input.subscription.buffer = merged.deltas;
      input.subscription.bufferBytes = merged.encodedBytes;
      input.subscription.resyncRequired = false;
    }
    input.subscription.sentSeq = input.previous.sentSeq;
    input.subscription.inFlight = input.previous.inFlight;
    rolledBack = true;
    return true;
  };
}
