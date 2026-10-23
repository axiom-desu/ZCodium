// Conversation topic 发布器（传输外壳）。
// CLI 侧权威运行时：内存有界 delta 日志（logEpoch + 保留窗）+ subscribe(base)
// 裁决（resume/snapshot）+ 每订阅者 flush 管线（filter → coalesce → 打帧）。
//
// 职责边界：
// - 本类只做「事件 → 帧」的权威记账，不做网络 IO / 定时器——flush 时机由宿主驱动
//   （host 通道层按 profile.flushWindowMs 调度；测试里手动调用），保持可测的纯推进。
// - 恢复与续流共用一条管线：resume 的初始帧 = 保留窗内 (base.seq, current] 的 delta
//   过该订阅者 profile 过滤再 coalesce，
//   因此「snapshot(W)+续流 ≡ 全量重放」黄金测试可直接覆盖恢复路径。
// - 重订阅 = 替换：同 connectionId 重复 subscribe 即作废旧订阅并清其
//   flush buffer，旧 subscriptionId 不再产帧，客户端按 subId 丢弃旧代际帧。
import type { SessionEvent } from "@zcode/contracts";
import type {
  CommandEnvelope,
  ConversationDelta,
  ConversationRowTarget,
  ConversationSnapshot,
  ConversationTopicFrame,
  DeliveryProfileName,
} from "@zcode/shared/zcode-protocol-v4";
import {
  DELIVERY_PROFILES,
  PROTOCOL_V4_LIMITS,
  utf8JsonByteLength,
} from "@zcode/shared/zcode-protocol-v4";
import { workflowRunDeltaGrowthUpperBound } from "./conversation-workflow-run-deltas.js";
import {
  ProductProjection,
  type ConversationRowTargetAction,
  type ConversationRowTargetResolution,
  type SessionConfigSeed,
  type SessionSubagentsSeed,
  type SessionUsageSeed,
  type StableForkCandidateResolution,
} from "./product-projection.js";
import type { TopicFrameReservation } from "./topic-frame-reservation.js";

export class ProjectionPayloadTooLargeError extends Error {
  readonly reasonCode = "proto.payloadTooLarge";

  constructor(readonly logicalBytes: number) {
    super(
      `conversation projection exceeds ${PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes} bytes`,
    );
    this.name = "ProjectionPayloadTooLargeError";
  }
}

import {
  nonNegativeHardBound,
  type ConversationSubscribeParams,
  type LogEntry,
  type ConversationSubscribeResult,
  type ConversationResyncRequest,
  type ConversationTopicPublisherOptions,
} from "./conversation-topic-subscription.js";
import { ConversationTopicSubscriptions } from "./conversation-topic-subscriptions.js";
import { projectionLimitForEvent, tryBatchHydration } from "./conversation-topic-hydration.js";
import {
  getPlans,
  getRowsRange,
  measureInputAdmissionProjectionBytes,
  measureWireSnapshotBytes,
  wireSnapshotForProfile,
} from "./conversation-topic-query.js";

export class ConversationTopicPublisher {
  readonly topic: string;
  private projection: ProductProjection;
  private readonly now: () => number;
  private readonly retention: number;
  private readonly subscriberBufferMaxOps: number;
  private readonly subscriberBufferMaxBytes: number;
  /** 有界日志：seq 升序；resume 只在 (floorSeq, currentSeq] 内合法。 */
  private readonly log: LogEntry[] = [];
  /** 保留窗下界：base.seq < floorSeq 的恢复请求已无法无损续传 → 只能 snapshot。 */
  private floorSeq = 0;
  private readonly subscriptions: ConversationTopicSubscriptions;
  /** 当前 snapshot logical frame 的保守上界；流式追加只累计增量，逼近上限才精确序列化。 */
  private wireSnapshotBytesUpperBound: number;

  constructor(
    private readonly sessionId: string,
    private readonly logEpoch: string,
    options: ConversationTopicPublisherOptions = {},
  ) {
    this.topic = `conversation/${sessionId}`;
    this.projection = new ProductProjection(sessionId, logEpoch);
    this.now = options.now ?? Date.now;
    this.retention = options.retention ?? PROTOCOL_V4_LIMITS.eventRetentionPerSession;
    this.subscriberBufferMaxOps = nonNegativeHardBound(
      options.subscriberBufferMaxOps,
      PROTOCOL_V4_LIMITS.subscriberBufferMaxOps,
      "subscriberBufferMaxOps",
    );
    this.subscriberBufferMaxBytes = nonNegativeHardBound(
      options.subscriberBufferMaxBytes,
      PROTOCOL_V4_LIMITS.subscriberBufferMaxBytes,
      "subscriberBufferMaxBytes",
    );
    this.subscriptions = new ConversationTopicSubscriptions({
      topic: this.topic,
      logEpoch: this.logEpoch,
      currentSeq: () => this.currentSeq,
      floorSeq: () => this.floorSeq,
      currentSnapshot: () => this.projection.getSnapshot(),
      logDeltasAfter: (seq) => this.log.flatMap((entry) => (entry.seq > seq ? entry.deltas : [])),
      now: () => this.now(),
      subscriberBufferMaxOps: this.subscriberBufferMaxOps,
      subscriberBufferMaxBytes: this.subscriberBufferMaxBytes,
    });
    this.wireSnapshotBytesUpperBound = this.measureWireSnapshotBytes(this.getWireSnapshot());
  }

  getSnapshot(): ConversationSnapshot {
    return this.projection.getSnapshot();
  }

  /** 测试/闸门共用的 logical TopicFrame 字节口径（不是裸 snapshot 大小）。 */
  getWireSnapshotLogicalBytes(): number {
    return this.measureWireSnapshotBytes(this.getWireSnapshot());
  }

  resolveStableForkCandidate(rowId: number): StableForkCandidateResolution {
    return this.projection.resolveStableForkCandidate(rowId);
  }

  /** config 种子注入：直改投影初值，不产 delta / 不进事件日志。语义见 ProductProjection.seedConfig。 */
  seedConfig(seed: SessionConfigSeed): void {
    this.projection.seedConfig(seed);
    this.wireSnapshotBytesUpperBound = this.measureWireSnapshotBytes(this.getWireSnapshot());
  }

  /** 分享导入提示是静态只读元数据，不进入 delta/revision；可在 hydration 后幂等补种。 */
  seedSharedContextImport(
    source: ConversationSnapshot["sharedContextImport"] | null | undefined,
  ): void {
    this.projection.seedSharedContextImport(source);
    this.wireSnapshotBytesUpperBound = this.measureWireSnapshotBytes(this.getWireSnapshot());
  }

  /** usage 种子注入：冷恢复用持久化 token 水位覆盖 transcript 合成的 0 占位。 */
  seedUsage(seed: SessionUsageSeed): void {
    this.projection.seedUsage(seed);
    this.wireSnapshotBytesUpperBound = this.measureWireSnapshotBytes(this.getWireSnapshot());
  }

  /** cold hydration 的 store-verified subagent manifest，不产 delta。 */
  seedSubagents(seed: SessionSubagentsSeed): void {
    this.projection.seedSubagents(seed);
    this.wireSnapshotBytesUpperBound = this.measureWireSnapshotBytes(this.getWireSnapshot());
  }

  /**
   * 下发用快照：rows 只带尾部窗口（snapshotTailWindowRows），
   * totalCount/firstRowId 保留全序口径——客户端以 `window[0].rowId === firstRowId`
   * 判定已到顶，更早历史经 rows/range 游标拉取。投影内部快照保持全量
   * （rows/range 数据源 + findRow/messageId 锚点都依赖它），只在打帧边界截断。
   */
  private getWireSnapshot(snapshot = this.projection.getSnapshot()): ConversationSnapshot {
    return wireSnapshotForProfile(snapshot, DELIVERY_PROFILES.continuous);
  }

  /**
   * 输入 admission 的候选 projection：用完整 QueueItem 表达同一份 intent，覆盖文本与附件引用。
   * QueueItem 元数据不小于立即启动后的 user row，因此通过此闸门的输入不会在后续首次
   * snapshot 才变成不可传输。此方法只读，不写 admission / event log。
   */
  measureInputAdmissionProjectionBytes(
    envelope: CommandEnvelope,
    admission: { admissionSeq: number; admittedAt: number; queueItemId: string },
  ): number | null {
    return measureInputAdmissionProjectionBytes({
      projection: this.projection,
      topic: this.topic,
      logEpoch: this.logEpoch,
      envelope,
      admission,
    });
  }

  private measureWireSnapshotBytes(snapshot: ConversationSnapshot): number {
    return measureWireSnapshotBytes(this.topic, this.logEpoch, snapshot);
  }

  /**
   * rows/range（游标制）：取 rowId < beforeRowId 的最后 limit 行
   * （rowId 升序返回）。数据源 = 投影全量行（事件重放/transcript hydration 已灌入），
   * 与订阅流出自同一归约，天然满足「与全量重放前缀逐字节一致」。
   * 只读、无状态、超时重发安全；atLogEpoch 供客户端陈旧读整体丢弃。
   */
  getRowsRange(
    params: { beforeRowId?: number; limit: number },
    deliveryProfile: DeliveryProfileName = "replayable",
  ): ReturnType<typeof getRowsRange> {
    return getRowsRange(this.projection, this.logEpoch, params, deliveryProfile);
  }

  /**
   * 返回当前有效分支里的完整终态计划目录。
   * wire snapshot 只保留 tail window；renderer 扫描可见 rows 会漏掉早期计划，
   * edit/retry 后还可能保留已经被权威 projection 裁掉的旧目录项。
   */
  getPlans(): ReturnType<typeof getPlans> {
    return getPlans(this.projection, this.logEpoch);
  }

  /** rowId → 权威 messageId（forkAssistant/editUserQuery 桥接翻译）。 */
  getMessageIdForRow(rowId: number): string | null {
    return this.projection.getMessageIdForRow(rowId);
  }

  resolveRowActionTarget(
    target: ConversationRowTarget,
    action: ConversationRowTargetAction,
  ): ConversationRowTargetResolution {
    return this.projection.resolveRowActionTarget(target, action);
  }

  /** rowId → 同一 product turn 内所有 transcript messageId。 */
  getMessageIdsForTurnRow(rowId: number): string[] {
    return this.projection.getMessageIdsForTurnRow(rowId);
  }

  /** fork 目标必须是所属轮最后一段 assistantText。 */
  isLatestAssistantSegmentRow(rowId: number): boolean {
    return this.projection.isLatestAssistantSegmentRow(rowId);
  }

  /** latestAssistantRetryOnly：retry 目标必须是全时间线最新且有 realUser cause 的 assistantText。 */
  isLatestRetryAssistantRow(rowId: number): boolean {
    return this.projection.isLatestRetryAssistantRow(rowId);
  }

  /** latestQueryEditOnly：只有最后一轮 realUser userInput row 可 edit。 */
  isLatestEditableUserRow(rowId: number): boolean {
    return this.projection.isLatestEditableUserRow(rowId);
  }

  /** rowId → product turnId（editUserQuery 无 assistant anchor 时回查 user messageId）。 */
  getTurnIdForRow(rowId: number): string | null {
    return this.projection.getTurnIdForRow(rowId);
  }

  /** assistant 守恒：被拒收的正文流事件数（>0 = 投影可能缺段）。 */
  getDroppedContentStreamEventCount(): number {
    return this.projection.getDroppedContentStreamEventCount();
  }

  /** rowId → 其 turn 的 rewind 锚点 messageId（editUserQuery user 行定位）。 */
  getTurnRewindAnchor(rowId: number): string | null {
    return this.projection.getTurnRewindAnchor(rowId);
  }

  private get currentSeq(): number {
    return this.projection.getSnapshot().seq;
  }

  /** 应用权威事件：投影推进 + 日志记账 + 扇出到各订阅者 flush buffer。 */
  ingest(event: SessionEvent): void {
    const projectionLimit = projectionLimitForEvent(event);
    const streamingAppend = this.projection.establishedStreamingAppend(event);
    const streamingUpperBound =
      streamingAppend === null ? null : utf8JsonByteLength(streamingAppend) + 64;
    let deltas: ConversationDelta[] | null;
    if (
      streamingUpperBound !== null &&
      this.wireSnapshotBytesUpperBound + streamingUpperBound <= projectionLimit
    ) {
      deltas = this.projection.applyEvent(event);
      this.wireSnapshotBytesUpperBound += streamingUpperBound;
    } else {
      let candidateBytes = 0;
      let nextUpperBound = 0;
      deltas = this.projection.applyEventAtomically(event, (snapshot, produced) => {
        // dwf 快路径：这条事件只产键级增量时，它们的字节数就是快照增长的上界（一条 upsert
        // 最多把自己那点内容加进去，removed 只会让快照变小），不必把整份快照再序列化一遍
        // ——那一次 JSON.stringify 是每条引擎事件都要付的 MB 级开销，也是这次改造的另一半。
        // 判据用的是**实际产出**而不是预演，所以 diff 退化出的整键 patch 自然落回精确路径。
        const growth = workflowRunDeltaGrowthUpperBound(produced);
        if (growth !== null && this.wireSnapshotBytesUpperBound + growth <= projectionLimit) {
          nextUpperBound = this.wireSnapshotBytesUpperBound + growth;
          return true;
        }
        candidateBytes = this.measureWireSnapshotBytes(this.getWireSnapshot(snapshot));
        nextUpperBound = candidateBytes;
        return candidateBytes <= projectionLimit;
      });
      if (deltas === null) throw new ProjectionPayloadTooLargeError(candidateBytes);
      this.wireSnapshotBytesUpperBound = nextUpperBound;
    }
    this.log.push({ seq: event.sequenceNumber, deltas });
    while (this.log.length > this.retention) {
      const evicted = this.log.shift();
      if (evicted) this.floorSeq = evicted.seq;
    }
    this.subscriptions.appendDeltas(deltas);
  }

  /**
   * 在现有 publisher 内重物化 projection，保留 connection-owned subscriptions。
   *
   * gateway 过去 delete publisher 后新建实例，projection 虽恢复了，旧实例
   * 的 subscription registry / ownership / in-flight reservation 却一起丢失。重物化属于
   * 同一 topic authority 的状态替换，只应让既有订阅 resync，不应换 publisher 身份。
   */
  rehydrate(
    events: readonly SessionEvent[],
    options: { onPayloadTooLarge?: (error: ProjectionPayloadTooLargeError) => void } = {},
  ): void {
    // 重放不能先清空当前 projection/log/subscription delivery，再逐条 replay：
    // 任一普通 reducer 异常都会把 topic 留在半重放状态。候选 publisher 不承接订阅，
    // 完整 replay（含 logical size 校验）成功后才一次 adopt 权威数据面。
    let candidate = new ConversationTopicPublisher(this.sessionId, this.logEpoch, {
      now: this.now,
      retention: this.retention,
      subscriberBufferMaxOps: this.subscriberBufferMaxOps,
      subscriberBufferMaxBytes: this.subscriberBufferMaxBytes,
    });
    const hydration = tryBatchHydration(
      {
        projection: candidate.projection,
        getWireSnapshot: (snapshot) => candidate.getWireSnapshot(snapshot),
        measureWireSnapshotBytes: (snapshot) => candidate.measureWireSnapshotBytes(snapshot),
        wireSnapshotBytesUpperBound: candidate.wireSnapshotBytesUpperBound,
      },
      events,
    );
    const usedBatchHydration = hydration.ok;
    if (usedBatchHydration) {
      candidate.wireSnapshotBytesUpperBound = hydration.wireSnapshotBytesUpperBound;
    }
    if (!usedBatchHydration) {
      // 保守上界超限不代表权威 projection 一定超限；重新从空候选走原逐事件原子
      // admission，保留 16MiB fail-closed 与“拒绝单个 oversize 后继续终态”的旧语义。
      candidate = new ConversationTopicPublisher(this.sessionId, this.logEpoch, {
        now: this.now,
        retention: this.retention,
        subscriberBufferMaxOps: this.subscriberBufferMaxOps,
        subscriberBufferMaxBytes: this.subscriberBufferMaxBytes,
      });
      for (const event of events) {
        try {
          candidate.ingest(event);
        } catch (error) {
          if (!(error instanceof ProjectionPayloadTooLargeError)) throw error;
          if (!options.onPayloadTooLarge) throw error;
          options.onPayloadTooLarge(error);
        }
      }
    }

    this.projection = candidate.projection;
    if (usedBatchHydration) {
      // 批量重放会把派生 actions 延迟到最终 materialization；若允许客户端
      // 用逐事件旧快照的中间 base 续这份日志，batch 从未持有的旧 canEdit/canRetry 无法被
      // 定点撤销。rehydrate 本来就要求所有现有订阅 resync，因此在当前 seq 建立 snapshot
      // recovery boundary；此后新事件仍从该水位正常 resume，不改变 replayable 恢复语义。
      this.log.splice(0, this.log.length);
      this.floorSeq = candidate.currentSeq;
    } else {
      // strict fallback 没有延迟 materialization，完整保留原有 retained-log 恢复语义。
      this.log.splice(0, this.log.length, ...candidate.log);
      this.floorSeq = candidate.floorSeq;
    }
    this.wireSnapshotBytesUpperBound = candidate.wireSnapshotBytesUpperBound;
    this.subscriptions.resetForRehydrate();
  }

  /**
   * 订阅裁决：base.logEpoch 匹配且 base.seq 在保留窗内 → resume，
   * 否则 snapshot。同 connectionId 重订阅 = 替换旧订阅并清其 flush buffer。
   */
  subscribe(params: ConversationSubscribeParams): ConversationSubscribeResult {
    return this.subscriptions.subscribe(params);
  }

  subscribeReserved(params: ConversationSubscribeParams): ConversationSubscribeResult {
    return this.subscriptions.subscribeReserved(params);
  }

  unsubscribe(subscriptionId: string, connectionId?: string): void {
    this.subscriptions.unsubscribe(subscriptionId, connectionId);
  }

  hasSubscription(subscriptionId: string, connectionId?: string): boolean {
    return this.subscriptions.hasSubscription(subscriptionId, connectionId);
  }

  hasSubscribers(): boolean {
    return this.subscriptions.hasSubscribers();
  }

  connectionIdForSubscription(subscriptionId: string): string | null {
    return this.subscriptions.connectionIdForSubscription(subscriptionId);
  }

  reserveFlush(subscriptionId: string): TopicFrameReservation<ConversationTopicFrame> | null {
    return this.subscriptions.reserveFlush(subscriptionId);
  }

  flush(subscriptionId: string): ConversationTopicFrame | null {
    return this.subscriptions.flush(subscriptionId);
  }

  resyncReserved(
    subscriptionId: string,
    request: ConversationResyncRequest,
  ): ConversationSubscribeResult | null {
    return this.subscriptions.resyncReserved(subscriptionId, request);
  }

  resync(subscriptionId: string): ConversationTopicFrame | null {
    return this.subscriptions.resync(subscriptionId);
  }
}
