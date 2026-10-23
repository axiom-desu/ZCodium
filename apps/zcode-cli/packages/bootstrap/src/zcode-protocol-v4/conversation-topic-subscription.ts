import type {
  ConversationDelta,
  ConversationTopicFrame,
  DeliveryProfile,
  DeliveryProfileName,
  SubscribeAck,
} from "@zcode/shared/zcode-protocol-v4";
import {
  PROTOCOL_V4_LIMITS,
  coalesceConversationDeltas,
  utf8JsonByteLength,
} from "@zcode/shared/zcode-protocol-v4";
import type { TopicFrameReservation } from "./topic-frame-reservation.js";

export interface LogEntry {
  seq: number;
  deltas: ConversationDelta[];
}

export interface Subscription {
  subscriptionId: string;
  connectionId: string;
  profile: DeliveryProfile;
  /**
   * 这条订阅认不认得 `workflowRun.*` 键级增量（握手能力位，由可信 host 注入）。
   * false = 旧消费者：增量折成整键 patch、快照裁到旧界（conversation-workflow-run-deltas.ts）。
   */
  workflowRunDeltas: boolean;
  /** flush buffer：push 时已过 profile 过滤与该订阅的编码，flush 时 coalesce 打帧。 */
  buffer: ConversationDelta[];
  bufferBytes: number;
  /** buffer 超限后只保留恢复意图，不继续为慢订阅者积压 delta。 */
  resyncRequired: boolean;
  /** 帧区间记账水位：下一帧 fromSeq（(fromSeq, toSeq] 语义）。 */
  sentSeq: number;
  /** 编码/写入期间保留的稳定 logical frame。 */
  inFlight: TopicFrameReservation<ConversationTopicFrame> | null;
  nextLogicalFrameOrdinal: number;
}

export interface ConversationSubscribeParams {
  connectionId: string;
  base?: { logEpoch: string; seq: number };
  /** 缺省 replayable（ws 默认；MessagePort 宿主显式传 continuous）。 */
  deliveryProfile?: DeliveryProfileName;
  /**
   * 该连接的 clientHello 声明过认得 `workflowRun.*` 增量。与 deliveryProfile 同族：可信 host
   * 注入，面向 UI 的 subscribe 选不了。缺省 false——能力位缺席一律按旧消费者办。
   */
  workflowRunDeltas?: boolean;
}

export interface ConversationSubscribeResult {
  ack: SubscribeAck;
  reservation: TopicFrameReservation<ConversationTopicFrame> | null;
  /** initial encode 失败且 ACK 未 admission 时，原子恢复被替换的旧 subscription。 */
  rollback(): boolean;
  /** snapshot 帧或 resume 的续传帧；resume 且无新增时为 null（客户端水位已对齐）。 */
  readonly frame: ConversationTopicFrame | null;
}

export interface ConversationResyncRequest {
  base: { logEpoch: string; seq: number } | null;
  forceSnapshot?: boolean;
}

export interface ConversationTopicPublisherOptions {
  /** CLI 时钟（frame.sentAt / clockOffset 估计源）。 */
  now?: () => number;
  /** 事件保留窗（条），默认 PROTOCOL_V4_LIMITS.eventRetentionPerSession。 */
  retention?: number;
  /** 每订阅者 coalesce 后 op 上限；主要用于协议配置与边界测试。 */
  subscriberBufferMaxOps?: number;
  /** 每订阅者 logical deltas payload 的 UTF-8 byte 上限。 */
  subscriberBufferMaxBytes?: number;
}

interface ConversationSubscriberBufferLimits {
  maxOps?: number;
  maxBytes?: number;
}

type ConversationSubscriberBufferResult =
  | {
      kind: "buffered";
      deltas: ConversationDelta[];
      encodedBytes: number;
    }
  | { kind: "overflow" };

export function nonNegativeHardBound(
  value: number | undefined,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? maximum;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
  return Math.min(Math.floor(resolved), maximum);
}

/**
 * profile filter 后的 delta 进入此纯函数；先与现有 buffer 合并并 coalesce，
 * 再按 op/UTF-8 bytes 双限额裁决——限额必须真正执行，只存裸 delta[] 不裁决的话，
 * 慢订阅者会持续堆积并最终生成不可控的大帧。
 */
export function appendConversationSubscriberBuffer(
  current: readonly ConversationDelta[],
  incoming: readonly ConversationDelta[],
  limits: ConversationSubscriberBufferLimits = {},
): ConversationSubscriberBufferResult {
  const maxOps = nonNegativeHardBound(
    limits.maxOps,
    PROTOCOL_V4_LIMITS.subscriberBufferMaxOps,
    "maxOps",
  );
  const maxBytes = nonNegativeHardBound(
    limits.maxBytes,
    PROTOCOL_V4_LIMITS.subscriberBufferMaxBytes,
    "maxBytes",
  );
  const deltas = coalesceConversationDeltas([...current, ...incoming]);
  if (deltas.length > maxOps) return { kind: "overflow" };
  const encodedBytes = utf8JsonByteLength({ kind: "deltas", deltas });
  if (encodedBytes > maxBytes) return { kind: "overflow" };
  return { kind: "buffered", deltas, encodedBytes };
}
