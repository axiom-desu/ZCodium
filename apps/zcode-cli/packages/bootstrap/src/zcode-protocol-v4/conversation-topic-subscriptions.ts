import type {
  ConversationDelta,
  ConversationSnapshot,
  ConversationTopicFrame,
  SubscribeAck,
  TopicFrameDeliveryKind,
} from "@zcode/shared/zcode-protocol-v4";
import { DELIVERY_PROFILES, coalesceConversationDeltas } from "@zcode/shared/zcode-protocol-v4";
import type { TopicFrameReservation } from "./topic-frame-reservation.js";
import {
  appendConversationSubscriberBuffer,
  type ConversationSubscribeParams,
  type ConversationSubscribeResult,
  type ConversationResyncRequest,
  type Subscription,
} from "./conversation-topic-subscription.js";
import {
  encodeDeltasForSubscription,
  wireSnapshotForSubscription,
} from "./conversation-topic-query.js";
import { resyncSubscriptionRollback } from "./conversation-topic-resync.js";

/** 订阅输出投影的窄上下文；权威 projection/log 仍由 publisher 持有。 */
interface ConversationTopicSubscriptionContext {
  topic: string;
  logEpoch: string;
  currentSeq(): number;
  floorSeq(): number;
  currentSnapshot(): ConversationSnapshot;
  logDeltasAfter(seq: number): readonly ConversationDelta[];
  now(): number;
  subscriberBufferMaxOps: number;
  subscriberBufferMaxBytes: number;
}

/** 订阅 registry / buffer / reservation 的唯一 owner。 */
export class ConversationTopicSubscriptions {
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly subscriptionIdByConnection = new Map<string, string>();
  private nextSubscriptionSerial = 1;
  private nextLogicalFrameSerial = 1;

  constructor(private readonly context: ConversationTopicSubscriptionContext) {}

  private wireSnapshotForSubscription(subscription: Subscription): ConversationSnapshot {
    return wireSnapshotForSubscription(
      this.context.currentSnapshot(),
      subscription.profile,
      subscription.workflowRunDeltas,
    );
  }

  private encodeDeltasForSubscription(
    deltas: readonly ConversationDelta[],
    subscription: Subscription,
  ): readonly ConversationDelta[] {
    return encodeDeltasForSubscription(
      deltas,
      subscription.profile,
      subscription.workflowRunDeltas,
      this.context.currentSnapshot().workflowRuns,
    );
  }

  appendDeltas(deltas: readonly ConversationDelta[]): void {
    if (deltas.length === 0) return;
    for (const subscription of this.subscriptions.values()) {
      if (subscription.resyncRequired) continue;
      const filtered = this.encodeDeltasForSubscription(deltas, subscription);
      const next = appendConversationSubscriberBuffer(subscription.buffer, filtered, {
        maxOps: this.context.subscriberBufferMaxOps,
        maxBytes: this.context.subscriberBufferMaxBytes,
      });
      if (next.kind === "overflow") {
        subscription.buffer = [];
        subscription.bufferBytes = 0;
        subscription.resyncRequired = true;
        continue;
      }
      subscription.buffer = next.deltas;
      subscription.bufferBytes = next.encodedBytes;
    }
  }

  resetForRehydrate(): void {
    for (const subscription of this.subscriptions.values()) {
      subscription.buffer = [];
      subscription.bufferBytes = 0;
      subscription.resyncRequired = true;
      subscription.sentSeq = 0;
      subscription.inFlight = null;
    }
  }

  subscribe(params: ConversationSubscribeParams): ConversationSubscribeResult {
    const result = this.subscribeReserved(params);
    result.reservation?.commit();
    return result;
  }

  /** 生产 gateway 入口：初始帧也必须等 physical batch 全接受才 commit。 */
  subscribeReserved(params: ConversationSubscribeParams): ConversationSubscribeResult {
    const previousId = this.subscriptionIdByConnection.get(params.connectionId);
    const previousSubscription =
      previousId === undefined ? undefined : this.subscriptions.get(previousId);
    if (previousId !== undefined) this.subscriptions.delete(previousId);

    const profile = DELIVERY_PROFILES[params.deliveryProfile ?? "replayable"];
    const subscription: Subscription = {
      subscriptionId: `sub-${this.context.logEpoch}-${this.nextSubscriptionSerial++}`,
      connectionId: params.connectionId,
      profile,
      workflowRunDeltas: params.workflowRunDeltas === true,
      buffer: [],
      bufferBytes: 0,
      resyncRequired: false,
      sentSeq: 0,
      inFlight: null,
      nextLogicalFrameOrdinal: 1,
    };
    this.subscriptions.set(subscription.subscriptionId, subscription);
    this.subscriptionIdByConnection.set(params.connectionId, subscription.subscriptionId);
    const rollback = (): boolean => {
      // initial reservation commit 后 replacement 已 admission，禁止迟到 rollback。
      if (
        subscription.inFlight === null ||
        this.subscriptions.get(subscription.subscriptionId) !== subscription ||
        this.subscriptionIdByConnection.get(params.connectionId) !== subscription.subscriptionId
      ) {
        return false;
      }
      this.subscriptions.delete(subscription.subscriptionId);
      if (previousId !== undefined && previousSubscription) {
        this.subscriptions.set(previousId, previousSubscription);
        this.subscriptionIdByConnection.set(params.connectionId, previousId);
      } else {
        this.subscriptionIdByConnection.delete(params.connectionId);
      }
      return true;
    };

    const base = params.base;
    const resumable =
      base !== undefined &&
      base.logEpoch === this.context.logEpoch &&
      base.seq >= this.context.floorSeq() &&
      base.seq <= this.context.currentSeq();

    if (!resumable) {
      const reservation = this.reserveFrame(
        subscription,
        {
          ...this.frameShell(subscription),
          fromSeq: 0,
          toSeq: this.context.currentSeq(),
          payload: {
            kind: "snapshot",
            snapshot: this.wireSnapshotForSubscription(subscription),
          },
        },
        false,
        "initial",
      );
      return this.subscribeResult(this.ackFor(subscription, "snapshot"), reservation, rollback);
    }

    // resume：保留窗内 (base.seq, current] 重放，与在线续流同一条 filter→编码→coalesce 管线。
    const replay = coalesceConversationDeltas(
      this.encodeDeltasForSubscription(this.context.logDeltasAfter(base.seq), subscription),
    );
    if (base.seq === this.context.currentSeq()) {
      subscription.sentSeq = base.seq;
      return this.subscribeResult(this.ackFor(subscription, "resume"), null, () => false);
    }
    subscription.sentSeq = base.seq;
    const reservation = this.reserveFrame(
      subscription,
      {
        ...this.frameShell(subscription),
        fromSeq: base.seq,
        toSeq: this.context.currentSeq(),
        payload: { kind: "deltas", deltas: replay },
      },
      false,
      "initial",
    );
    return this.subscribeResult(this.ackFor(subscription, "resume"), reservation, rollback);
  }

  unsubscribe(subscriptionId: string, connectionId?: string): void {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return;
    if (connectionId !== undefined && subscription.connectionId !== connectionId) {
      return;
    }
    this.subscriptions.delete(subscriptionId);
    if (this.subscriptionIdByConnection.get(subscription.connectionId) === subscriptionId) {
      this.subscriptionIdByConnection.delete(subscription.connectionId);
    }
  }

  hasSubscription(subscriptionId: string, connectionId?: string): boolean {
    const subscription = this.subscriptions.get(subscriptionId);
    return Boolean(
      subscription && (connectionId === undefined || subscription.connectionId === connectionId),
    );
  }

  /** Resident 回收判定：仍有任一订阅者时该会话不可被去激活。 */
  hasSubscribers(): boolean {
    return this.subscriptions.size > 0;
  }

  connectionIdForSubscription(subscriptionId: string): string | null {
    return this.subscriptions.get(subscriptionId)?.connectionId ?? null;
  }

  /**
   * 排空一个订阅者的 flush buffer 打成一帧（宿主按 flushWindowMs 驱动）。
   * 无新内容返回 null；帧区间 (sentSeq, currentSeq] 覆盖中途被过滤掉的 seq，
   * 保证客户端 `frame.fromSeq === store.seq` 的连续性判定不受 profile 过滤影响。
   */
  reserveFlush(subscriptionId: string): TopicFrameReservation<ConversationTopicFrame> | null {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return null;
    if (subscription.inFlight) return subscription.inFlight;
    if (subscription.resyncRequired) {
      subscription.buffer = [];
      subscription.bufferBytes = 0;
      return this.reserveFrame(
        subscription,
        {
          ...this.frameShell(subscription),
          fromSeq: 0,
          toSeq: this.context.currentSeq(),
          payload: {
            kind: "snapshot",
            snapshot: this.wireSnapshotForSubscription(subscription),
          },
        },
        true,
        "online",
      );
    }
    if (subscription.buffer.length === 0 && subscription.sentSeq === this.context.currentSeq()) {
      return null;
    }
    const deltas = subscription.buffer;
    const frame: ConversationTopicFrame = {
      ...this.frameShell(subscription),
      fromSeq: subscription.sentSeq,
      toSeq: this.context.currentSeq(),
      payload: { kind: "deltas", deltas },
    };
    subscription.buffer = [];
    subscription.bufferBytes = 0;
    return this.reserveFrame(subscription, frame, false, "online");
  }

  /** 旧单测便利面；生产 gateway 必须 reserve 后在 emit-all 成功才 commit。 */
  flush(subscriptionId: string): ConversationTopicFrame | null {
    const reservation = this.reserveFlush(subscriptionId);
    if (!reservation || !reservation.commit()) return null;
    return reservation.frame;
  }

  /**
   * 活跃订阅 same-sub 恢复：客户端 base 是唯一恢复起点，不能拿 sentSeq
   * 猜客户端已应用到哪里。新 recovery admission 会作废旧 reservation；迟到 commit
   * 因 inFlight 身份不再匹配而返回 false。
   */
  resyncReserved(
    subscriptionId: string,
    request: ConversationResyncRequest,
  ): ConversationSubscribeResult | null {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return null;

    const previous = {
      buffer: subscription.buffer,
      bufferBytes: subscription.bufferBytes,
      resyncRequired: subscription.resyncRequired,
      sentSeq: subscription.sentSeq,
      inFlight: subscription.inFlight,
    };

    // 旧 resync 会先 commit 当前 reservation，再基于服务端 sentSeq 发 snapshot，
    // 这会把客户端未收到的帧误记为已送达。same-sub recovery 必须直接 supersede。
    subscription.inFlight = null;
    subscription.buffer = [];
    subscription.bufferBytes = 0;
    subscription.resyncRequired = false;

    const base = request.base;
    const resumable =
      !request.forceSnapshot &&
      base !== null &&
      base.logEpoch === this.context.logEpoch &&
      base.seq >= this.context.floorSeq() &&
      base.seq <= this.context.currentSeq();

    if (!resumable) {
      subscription.sentSeq = 0;
      const reservation = this.reserveFrame(
        subscription,
        {
          ...this.frameShell(subscription),
          fromSeq: 0,
          toSeq: this.context.currentSeq(),
          payload: {
            kind: "snapshot",
            snapshot: this.wireSnapshotForSubscription(subscription),
          },
        },
        false,
        "recovery",
      );
      return this.subscribeResult(
        this.ackFor(subscription, "snapshot"),
        reservation,
        this.resyncRollback(subscription, reservation, previous),
      );
    }

    subscription.sentSeq = base.seq;
    const replay = coalesceConversationDeltas(
      this.encodeDeltasForSubscription(this.context.logDeltasAfter(base.seq), subscription),
    );
    const reservation = this.reserveFrame(
      subscription,
      {
        ...this.frameShell(subscription),
        fromSeq: base.seq,
        toSeq: this.context.currentSeq(),
        payload: { kind: "deltas", deltas: replay },
      },
      false,
      "recovery",
    );
    return this.subscribeResult(
      this.ackFor(subscription, "resume"),
      reservation,
      this.resyncRollback(subscription, reservation, previous),
    );
  }

  private resyncRollback(
    subscription: Subscription,
    reservation: TopicFrameReservation<ConversationTopicFrame>,
    previous: Pick<
      Subscription,
      "buffer" | "bufferBytes" | "resyncRequired" | "sentSeq" | "inFlight"
    >,
  ): () => boolean {
    return resyncSubscriptionRollback({
      subscription,
      reservation,
      previous,
      maxOps: this.context.subscriberBufferMaxOps,
      maxBytes: this.context.subscriberBufferMaxBytes,
      isCurrent: (candidate) => this.subscriptions.get(candidate.subscriptionId) === candidate,
    });
  }

  resync(subscriptionId: string): ConversationTopicFrame | null {
    const reservation = this.resyncReserved(subscriptionId, {
      base: null,
      forceSnapshot: true,
    })?.reservation;
    if (!reservation || !reservation.commit()) return null;
    return reservation.frame;
  }

  private reserveFrame(
    subscription: Subscription,
    frame: ConversationTopicFrame,
    snapshotRecovery: boolean,
    deliveryKind: TopicFrameDeliveryKind,
  ): TopicFrameReservation<ConversationTopicFrame> {
    let committed = false;
    const reservation: TopicFrameReservation<ConversationTopicFrame> = {
      deliveryKind,
      logicalFrameId: `${subscription.subscriptionId}-lf-${this.nextLogicalFrameSerial++}`,
      logicalFrameOrdinal: subscription.nextLogicalFrameOrdinal++,
      frame,
      commit: () => {
        if (committed) return true;
        if (
          this.subscriptions.get(subscription.subscriptionId) !== subscription ||
          subscription.inFlight !== reservation
        ) {
          return false;
        }
        subscription.sentSeq = frame.toSeq;
        subscription.inFlight = null;
        if (snapshotRecovery) {
          // snapshot 在途时 resyncRequired 会停止收 delta。
          // 若权威水位又推进，下一 reservation 必须再发最新 snapshot。
          subscription.resyncRequired = this.context.currentSeq() > frame.toSeq;
        }
        committed = true;
        return true;
      },
    };
    subscription.inFlight = reservation;
    return reservation;
  }

  private subscribeResult(
    ack: SubscribeAck,
    reservation: TopicFrameReservation<ConversationTopicFrame> | null,
    rollback: () => boolean,
  ): ConversationSubscribeResult {
    return {
      ack,
      reservation,
      rollback,
      // 兼容旧 publisher 单测：读 frame 即表示本地 transport 已接受。
      // 生产 gateway 只读 reservation，不会触发该 getter。
      get frame() {
        reservation?.commit();
        return reservation?.frame ?? null;
      },
    };
  }

  private ackFor(subscription: Subscription, mode: SubscribeAck["mode"]): SubscribeAck {
    return {
      subscriptionId: subscription.subscriptionId,
      mode,
      logEpoch: this.context.logEpoch,
    };
  }

  private frameShell(
    subscription: Subscription,
  ): Pick<ConversationTopicFrame, "topic" | "subscriptionId" | "sentAt"> {
    return {
      topic: this.context.topic,
      subscriptionId: subscription.subscriptionId,
      sentAt: this.context.now(),
    };
  }
}
