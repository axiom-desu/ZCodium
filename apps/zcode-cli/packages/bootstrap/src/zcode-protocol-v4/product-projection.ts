import type { SessionEvent } from "@zcode/contracts";
import {
  cloneProjectionState,
  createProjectionState,
  type ProjectionState,
} from "./product-projection-state.js";
import type {
  ConversationDelta,
  ConversationRowTarget,
  ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import type { ConversationNormalizationDiagnostic } from "./event-normalizer.js";
import { createInitialConversationSnapshot } from "./projection-state.js";
import type {
  ConversationEditTarget,
  ConversationRowTargetAction,
  ConversationRowTargetResolution,
  SessionConfigSeed,
  SessionSubagentsSeed,
  SessionUsageSeed,
  StableForkCandidateResolution,
} from "./product-projection-types.js";
import {
  getEntityIdForRowImpl,
  getMessageIdForRowImpl,
  getMessageIdsForTurnRowImpl,
  getTurnIdForRowImpl,
  isLatestAssistantSegmentRowImpl,
  isLatestEditableUserRowImpl,
  isLatestRetryAssistantRowImpl,
  resolveEditTargetByEntityIdImpl,
  resolveEditTargetImpl,
  resolveRowActionTargetImpl,
  resolveStableForkCandidateImpl,
} from "./product-projection-queries.js";
import {
  establishedStreamingAppendImpl,
  seedConfigImpl,
  seedSharedContextImportImpl,
  seedSubagentsImpl,
  seedUsageImpl,
} from "./product-projection-seeds.js";
import { getTurnRewindAnchorImpl } from "./product-projection-sessions.js";
import {
  applyEventImpl,
  applyHydrationEventImpl,
  beginHydrationReplayImpl,
  completeHydrationReplayImpl,
} from "./product-projection-events.js";

// ProductProjection —— CLI 权威投影第二 reducer。
// 输入：CLI 事件日志（SessionEvent，权威事实源）；输出：ConversationDelta[]。
// 快照推进复用协议规范 apply（applyConversationDeltas）——投影演进与 delta 流
// 逐字节一致是构造保证，黄金测试再用独立重放交叉验证。
//
// 覆盖：session/turn 生命周期、流式文本/思考、tool call 状态机、
// 权限交互、turn-steer 队列、usage、错误态、迟到终态拒收、
// compact marker、goal 状态机、fork marker。传输外壳（TopicFrame/subscribe）在后续片。

export type {
  ConversationEditTarget,
  ConversationRowTargetAction,
  ConversationRowTargetResolution,
  SessionConfigSeed,
  SessionSubagentsSeed,
  SessionUsageSeed,
  StableForkCandidate,
  StableForkCandidateResolution,
} from "./product-projection-types.js";

export class ProductProjection {
  // 唯一可变状态容器：snapshot/索引/stream/hydration 均为同一实例的字段，
  // 派生 reducer 只拿 Pick<ProjectionState, ...> 窄端口原地写它（见 product-projection-state.ts）。
  private state: ProjectionState;

  constructor(sessionId: string, logEpoch: string) {
    this.state = createProjectionState(createInitialConversationSnapshot(sessionId, logEpoch));
  }

  getSnapshot(): ConversationSnapshot {
    return this.state.snapshot;
  }

  /** assistant 守恒：被拒收的正文流事件数（>0 = 投影可能缺段，需重 hydration）。 */
  getDroppedContentStreamEventCount(): number {
    return this.state.droppedContentStreamEventCount;
  }

  getNormalizationDiagnostics(): readonly ConversationNormalizationDiagnostic[] {
    return this.state.normalizationDiagnostics;
  }

  /** 仅供 publisher 的有界增量估算；返回 null 表示必须走候选快照精确校验。 */
  establishedStreamingAppend(event: SessionEvent): string | null {
    return establishedStreamingAppendImpl(this.state, event);
  }

  /**
   * config 种子注入。
   *
   * 初始快照 config 曾写死空 provider/model +
   * mode="build"，而 ModelSelected 只在 switchModelConfig 后补发、SessionCreated 刻意
   * 不产 delta——runtime 真值（启动默认模型/项目持久化 mode/历史会话上次选型）从头到尾
   * 进不了投影。后果：① 新会话模型选择器显示空；② 项目持久化 mode=yolo 时 UI 显示
   * build，点 yolo 命中 handler 同值 no-op（判的是 runtime 真值），UI 永远无法收敛——
   * 打破了「revision 不变 ⇔ 无状态变化」的 CAS 不变量。
   *
   * 为什么这么修：种子直改 snapshot.config，不产 delta、不递增 revision/seq——
   * draft「无可见 delta」裁决不被破坏；事件触碰过的区块跳过（重放序
   * 在种子之后时日志值优先）。幂等：可在 ensurePublisher / hydration 后重复调用。
   */
  seedConfig(seed: SessionConfigSeed): void {
    seedConfigImpl(this.state, seed);
  }

  /**
   * 导入分享上下文的来源只读种子。
   *
   * shared_context 是 provider-only message，不应物化为用户气泡；来源标记通过
   * snapshot additive 字段下发，供 Desktop 在打开新会话后显示持久提示。该字段
   * 不属于 conversation rows，也不递增 revision/seq，避免伪造一轮对话。
   */
  seedSharedContextImport(
    source: ConversationSnapshot["sharedContextImport"] | null | undefined,
  ): void {
    seedSharedContextImportImpl(this.state, source);
  }

  seedUsage(seed: SessionUsageSeed): void {
    seedUsageImpl(this.state, seed);
  }

  /**
   * 冷恢复的 subagent store 校验种子。transcript 可以恢复可见 row，但只有 session
   * store 能证明 child 已持久化为 subagent_child；因此在 candidate publisher 发布前
   * 用该种子整体替换 manifest，旧版本遗留的幽灵 child 不得进入 UI 权威态。
   */
  seedSubagents(seed: SessionSubagentsSeed): void {
    seedSubagentsImpl(this.state, seed);
  }

  /**
   * rowId → 权威 messageId。桥接层执行 forkAssistant/editUserQuery 时把命令载荷的
   * 内部 rowId 翻译成 core 需要的 messageId。未知 rowId（非 assistant/user 行、
   * 或迟到）返回 null，桥接层据此回 rejected。
   */
  getMessageIdForRow(rowId: number): string | null {
    return getMessageIdForRowImpl(this.state, rowId);
  }

  getEntityIdForRow(rowId: number): string | null {
    return getEntityIdForRowImpl(this.state, rowId);
  }

  resolveEditTarget(rowId: number): ConversationEditTarget | null {
    return resolveEditTargetImpl(this.state, rowId);
  }

  resolveEditTargetByEntityId(entityId: string): ConversationEditTarget | null {
    return resolveEditTargetByEntityIdImpl(this.state, entityId);
  }

  /**
   * V3 行动作的唯一解析器。展示 rowId 与稳定 entityId 必须同时命中当前 projection；
   * action 可用性直接读取同一次 materialization 生成的 row.actions，handler/preview
   * 不得再各自按位置、phase 或文本重算。
   */
  resolveRowActionTarget(
    target: ConversationRowTarget,
    action: ConversationRowTargetAction,
  ): ConversationRowTargetResolution {
    return resolveRowActionTargetImpl(this.state, target, action);
  }

  /**
   * 文件摘要撤销以 turn rowId 为入口，服务端解析同一 product turn 内所有
   * messageId，覆盖多段 assistant / 多个 checkpoint；UI 不暴露内部 messageId。
   */
  getMessageIdsForTurnRow(rowId: number): string[] {
    return getMessageIdsForTurnRowImpl(this.state, rowId);
  }

  /**
   * core 侧强校验：
   * rowId 是否为其所属 productTurn 的最后一段 assistantText。UI（平铺后）已只在
   * 最后段暴露 fork 入口，这里是防御闸——直接命令面/旧客户端不得 fork 中间段。
   */
  isLatestAssistantSegmentRow(rowId: number): boolean {
    return isLatestAssistantSegmentRowImpl(this.state, rowId);
  }

  /**
   * running fork 的同步投影闸门：这里只解析 row/product-turn 与 message 边界；完整
   * orderedMessageIds 由 host 再用 session store 权威顺序补齐并持久化 anchor。
   */
  resolveStableForkCandidate(rowId: number): StableForkCandidateResolution {
    return resolveStableForkCandidateImpl(this.state, rowId);
  }

  /** latestAssistantRetryOnly：retry 只能指向全时间线最新且有 realUser cause 的 assistantText。 */
  isLatestRetryAssistantRow(rowId: number): boolean {
    return isLatestRetryAssistantRowImpl(this.state, rowId);
  }

  /** latestQueryEditOnly：只有当前投影里的最后一条 realUser userInput row 可 edit。 */
  isLatestEditableUserRow(rowId: number): boolean {
    return isLatestEditableUserRowImpl(this.state, rowId);
  }

  /** rowId → product turnId（命令层 running edit 在无 assistant anchor 时回查 store 用）。 */
  getTurnIdForRow(rowId: number): string | null {
    return getTurnIdForRowImpl(this.state, rowId);
  }

  /** 应用一个权威事件，返回该事件产生的 delta 序列（可能为空）。 */
  applyEvent(event: SessionEvent): ConversationDelta[] {
    return applyEventImpl(this.state, event);
  }

  /**
   * 冷恢复批量路径只允许在尚未发布的候选 projection 上使用。begin 后 rows.window
   * 原地推进，避免每个事件复制增长数组；publisher 在完整校验通过前不会 adopt 候选。
   */
  beginHydrationReplay(): void {
    beginHydrationReplayImpl(this.state);
  }

  applyHydrationEvent(event: SessionEvent): ConversationDelta[] {
    return applyHydrationEventImpl(this.state, event);
  }

  /**
   * 把批量期间延迟的 command actions 收敛到当前快照。actions 是同一 reducer 的派生
   * materialization，不单独递增 revision；触发它变化的结构/guard 事件已经记账。
   */
  completeHydrationReplay(): ConversationDelta[] {
    return completeHydrationReplayImpl(this.state);
  }

  /**
   * 在独立候选投影上归约事件，校验通过后才原子提交。
   *
   * projection 超过 logical frame assembly 上限时，如果先修改当前实例再等
   * wire encoder 报错，权威内存态会永久停在“无法发 snapshot”的状态。候选实例同时
   * 隔离 snapshot 与 reducer 的各类 side-map；拒绝时当前实例完全不变，客户端仍可从
   * 最后一个可传输 snapshot 恢复。
   *
   * `accept` 同时拿到这条事件**实际产出**的 delta：有些事件类别可以只按 delta 的字节数给出
   * 一个可靠上界，不必把整份候选快照再序列化一遍（publisher 的 ingest 快路径）。传的是实际
   * 产出而不是预演，正是因为预演算不准——投影在 reducer 之上还叠了 subagent 镜像与命令
   * actions 的 materialization，少算一条就把 16MiB 闸门算松了。
   */
  applyEventAtomically(
    event: SessionEvent,
    accept: (snapshot: ConversationSnapshot, deltas: readonly ConversationDelta[]) => boolean,
  ): ConversationDelta[] | null {
    const candidate = this.cloneProjection();
    const deltas = candidate.applyEvent(event);
    if (!accept(candidate.state.snapshot, deltas)) return null;
    this.adoptProjection(candidate);
    return deltas;
  }

  /**
   * 候选投影的唯一拷贝点：状态深拷贝集中在 cloneProjectionState（侧表遗漏即测试失败）。
   */
  private cloneProjection(): ProductProjection {
    const clone = Object.create(ProductProjection.prototype) as ProductProjection;
    clone.state = cloneProjectionState(this.state);
    return clone;
  }

  /**
   * 原子提交：状态引用整体替换，不存在“部分侧表已更新”的中间态；
   * 拒绝提交时当前实例的 state 完全未改动（candidate 是独立副本）。
   */
  private adoptProjection(candidate: ProductProjection): void {
    this.state = candidate.state;
  }

  /**
   * 任意 rowId → 其所属 turn 的 rewind 锚点 messageId。新 live/cold user row 都应
   * 直接携持久 user messageId；同 turn assistant 只保留为旧事件兼容 fallback。
   * `canEdit` 不允许依赖该 fallback，必须由 user row 自身的 exact target 驱动。
   */
  getTurnRewindAnchor(rowId: number): string | null {
    return getTurnRewindAnchorImpl(this.state, rowId);
  }
}
