import type {
  BackgroundBashOutputResult,
  CommandAck,
  CommandsQueryResult,
  ConversationSnapshot,
  ConversationRowTarget,
  ConversationTopicFrame,
  QueueItem,
  RoutedTopicFrame,
  SessionsIndexReconcileResult,
  SessionsIndexTopicFrame,
  V4AttachmentBeginResult,
  V4AttachmentChunkResult,
  V4AttachmentCommitResult,
  V4AttachmentPreviewSourceResult,
  V4AttachmentReadResult,
  V4ConversationAttachmentReadResult,
  V4ConversationAttachmentStatResult,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewResult,
  V4ConversationPlansResult,
  V4ConversationRowsRangeResult,
  V4ConversationWorkflowRunArtifactDataResult,
  V4ConversationWorkflowRunArtifactReadResult,
  V4ConversationWorkflowRunArtifactsResult,
  V4ConversationWorkflowRunEventsResult,
  V4ConversationWorkflowRunNodeResultResult,
  V4ConversationWorkflowRunWorkspaceResult,
  V4ConversationWorkflowRunsResult,
  WorkspaceConfigState,
  WorkspaceConfigTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import {
  sessionsIndexReconcileParamsSchema,
  sessionsIndexReconcileResultSchema,
} from "@zcode/shared/zcode-protocol-v4";
import type { ConversationRowTargetAction } from "./product-projection.js";
import type { SessionEvent } from "@zcode/contracts";
import {
  DETACHED_CHILD_PUBLISHER_GRACE_MS,
  type V4SubscribeDispatchResult,
} from "./v4-gateway-contract.js";
import { createGatewayState, type GatewayState } from "./v4-gateway-state.js";
import * as readmodel from "./v4-gateway-read-model.js";
import * as attachments from "./v4-gateway-attachments.js";
import * as indexconfig from "./v4-gateway-index-config.js";
import * as flush from "./v4-gateway-flush.js";
import * as subscriptions from "./v4-gateway-subscriptions.js";
import * as ingest from "./v4-gateway-ingest.js";
import * as hydration from "./v4-gateway-hydration.js";
import * as lifecycle from "./v4-gateway-lifecycle.js";
import * as commands from "./v4-gateway-commands.js";

export type { V4GatewayHost } from "./v4-gateway-contract.js";
export { V4CommandNotImplementedError, V4CommandNoopError } from "./v4-gateway-commands.js";

export class ConversationV4Gateway {
  private readonly state: GatewayState;

  constructor(
    host: Parameters<typeof createGatewayState>[0],
    options: Parameters<typeof createGatewayState>[1] = {},
  ) {
    this.state = createGatewayState(host, options);
  }

  /** session entry 状态变更后的轻量 metadata 更新，不重放 conversation event。 */
  updateSharedContextImport(
    sessionId: string,
    source: ConversationSnapshot["sharedContextImport"],
  ): void {
    return readmodel.updateSharedContextImport(this.state, sessionId, source);
  }

  setConnectionFlowState(rawParams: unknown): void {
    return subscriptions.setConnectionFlowState(this.state, rawParams);
  }

  /** 权威事件入口：投影推进 + 各订阅者按 profile.flushWindowMs 调度打帧。 */
  ingest(sessionId: string, event: SessionEvent): void {
    return ingest.ingest(this.state, sessionId, event);
  }

  /** 等待指定 raw event 真正完成 reorder drain + publisher projection apply。 */
  waitForProjectionEventCommit(
    sessionId: string,
    eventId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    return hydration.waitForProjectionEventCommit(this.state, sessionId, eventId, options);
  }

  /** 授权已经提交到任务事务，失败重试必须重放权威日志，不能再次提权或丢弃提交事实。 */
  async waitForPermissionGrantCommit(sessionId: string, eventId: string): Promise<void> {
    return hydration.waitForPermissionGrantCommit(this.state, sessionId, eventId);
  }

  /**
   * subagent child 使用父 record 的外部 sink，但保留独立 session topic。显式登记这类
   * detached live session，避免把任意偶然存在的 cold publisher 都误判为运行中 child。
   */
  ingestDetachedLiveSession(
    sessionId: string,
    event: SessionEvent,
    parentSessionId?: string,
  ): void {
    return ingest.ingestDetachedLiveSession(this.state, sessionId, event, parentSessionId);
  }

  /**
   * 低频 tick 兜底：释放已终态、无订阅者、且没有自己 record 的 detached child publisher。
   * 释放后再被订阅走既有 cold resume（child 作为 subagent_child 持久化在 session store）。返回释放数。
   */
  pruneDetachedChildPublishers(
    nowMs: number = Date.now(),
    graceMs: number = DETACHED_CHILD_PUBLISHER_GRACE_MS,
  ): number {
    return ingest.pruneDetachedChildPublishers(this.state, nowMs, graceMs);
  }

  /**
   * sessions-index 订阅：订阅某 workspace 的会话列表（与 conversation subscribe 并列，
   * 同一 RPC 方法按 topic 前缀分派）。冷启动：store 摘要种子 + 已加载会话 live 投影覆盖。
   */
  async subscribeSessionsIndex(
    rawParams: unknown,
  ): Promise<V4SubscribeDispatchResult<SessionsIndexTopicFrame>> {
    return indexconfig.subscribeSessionsIndex(this.state, rawParams);
  }

  async subscribeSessionsIndexReserved(
    rawParams: unknown,
  ): Promise<V4SubscribeDispatchResult<SessionsIndexTopicFrame>> {
    return indexconfig.subscribeSessionsIndexReserved(this.state, rawParams);
  }

  /** 只读 CLI 持久会话事实；旧宿主未实现时显式拒绝，调用方不得据此推断删除。 */
  async reconcileSessions(rawParams: unknown): Promise<SessionsIndexReconcileResult> {
    const params = sessionsIndexReconcileParamsSchema.parse(rawParams);
    if (!this.state.host.reconcileSessions)
      throw new Error("sessionsIndex/reconcile is unavailable");
    return sessionsIndexReconcileResultSchema.parse(
      await this.state.host.reconcileSessions(params),
    );
  }

  /**
   * workspace-config 订阅：订阅某 workspace 的配置目录（与 conversation subscribe 并列，
   * 同一 RPC 方法按 topic 前缀分派）。订阅时经宿主钩子拉取当前配置作种子。
   */
  async subscribeWorkspaceConfig(
    rawParams: unknown,
  ): Promise<V4SubscribeDispatchResult<WorkspaceConfigTopicFrame>> {
    return indexconfig.subscribeWorkspaceConfig(this.state, rawParams);
  }

  async subscribeWorkspaceConfigReserved(
    rawParams: unknown,
  ): Promise<V4SubscribeDispatchResult<WorkspaceConfigTopicFrame>> {
    return indexconfig.subscribeWorkspaceConfigReserved(this.state, rawParams);
  }

  /**
   * 配置目录发布入口（宿主在 provider registry 应用 / workspace 默认项变更后调用，
   * 直接携带已构建好的目录，不回头重拉宿主，避免重复 buildWorkspaceState 的临时 app 成本）。
   * conflation 在 publisher 内完成（未变化不产帧）；无 publisher 时同步建一个空种子的
   * publisher 存住最新态，后续订阅者据此拿到完整 snapshot。
   */
  publishWorkspaceConfig(workspaceId: string, state: WorkspaceConfigState): void {
    return indexconfig.publishWorkspaceConfig(this.state, workspaceId, state);
  }

  /** v4/conversation/subscribe：裁决 + server 内部 initial frame，公共响应由 server 只取 ACK。 */
  async subscribe(rawParams: unknown): Promise<V4SubscribeDispatchResult<ConversationTopicFrame>> {
    return subscriptions.subscribe(this.state, rawParams);
  }

  async subscribeReserved(
    rawParams: unknown,
  ): Promise<V4SubscribeDispatchResult<ConversationTopicFrame>> {
    return subscriptions.subscribeReserved(this.state, rawParams);
  }

  /**
   * v4/conversation/resync：按 owned topic/connection 精确命中现有 subscription，
   * 保持 subId/profile 不变，从客户端 base 重新裁决 resume/snapshot。
   */
  resyncReserved(rawParams: unknown): V4SubscribeDispatchResult<RoutedTopicFrame> {
    return subscriptions.resyncReserved(this.state, rawParams);
  }

  /**
   * v4/conversation/rowsRange：按 beforeRowId 游标向上取一窗
   * 历史行。只读 query，不建订阅；数据源 = 该会话投影全量行——冷会话（重启后直开
   * 历史）复用与 subscribe 相同的冷恢复 + hydration 管线先把投影建起来。
   */
  rowsRange(rawParams: unknown): Promise<V4ConversationRowsRangeResult> {
    return this.state.fileQueries.rowsRange(rawParams);
  }

  plans(rawParams: unknown): Promise<V4ConversationPlansResult> {
    return this.state.fileQueries.plans(rawParams);
  }

  workflowRunEvents(rawParams: unknown): Promise<V4ConversationWorkflowRunEventsResult> {
    return this.state.workflowQueries.workflowRunEvents(rawParams);
  }

  workflowRuns(rawParams: unknown): Promise<V4ConversationWorkflowRunsResult> {
    return this.state.workflowQueries.workflowRuns(rawParams);
  }

  workflowRunArtifacts(rawParams: unknown): Promise<V4ConversationWorkflowRunArtifactsResult> {
    return this.state.workflowQueries.workflowRunArtifacts(rawParams);
  }

  workflowRunArtifactData(
    rawParams: unknown,
  ): Promise<V4ConversationWorkflowRunArtifactDataResult> {
    return this.state.workflowQueries.workflowRunArtifactData(rawParams);
  }

  workflowRunArtifactRead(
    rawParams: unknown,
  ): Promise<V4ConversationWorkflowRunArtifactReadResult> {
    return this.state.workflowQueries.workflowRunArtifactRead(rawParams);
  }

  workflowRunWorkspace(rawParams: unknown): Promise<V4ConversationWorkflowRunWorkspaceResult> {
    return this.state.workflowQueries.workflowRunWorkspace(rawParams);
  }

  workflowRunNodeResult(rawParams: unknown): Promise<V4ConversationWorkflowRunNodeResultResult> {
    return this.state.workflowQueries.workflowRunNodeResult(rawParams);
  }

  fileChanges(rawParams: unknown): Promise<V4ConversationFileChangesResult> {
    return this.state.fileQueries.fileChanges(rawParams);
  }

  backgroundBashOutput(rawParams: unknown): Promise<BackgroundBashOutputResult> {
    return this.state.fileQueries.backgroundBashOutput(rawParams);
  }

  fileRewindPreview(rawParams: unknown): Promise<V4ConversationFileRewindPreviewResult> {
    return this.state.fileQueries.fileRewindPreview(rawParams);
  }

  /** begin 只 admission metadata，不解码/暂存 full payload。 */
  async attachmentBegin(rawParams: unknown): Promise<V4AttachmentBeginResult> {
    return attachments.attachmentBegin(this.state, rawParams);
  }

  async attachmentChunk(rawParams: unknown): Promise<V4AttachmentChunkResult> {
    return attachments.attachmentChunk(this.state, rawParams);
  }

  attachmentCommit(rawParams: unknown): Promise<V4AttachmentCommitResult> {
    return attachments.attachmentCommit(this.state, rawParams);
  }

  async attachmentAbort(rawParams: unknown): Promise<void> {
    return attachments.attachmentAbort(this.state, rawParams);
  }

  async attachmentRead(rawParams: unknown): Promise<V4AttachmentReadResult> {
    return attachments.attachmentRead(this.state, rawParams);
  }

  async conversationAttachmentRead(
    rawParams: unknown,
  ): Promise<V4ConversationAttachmentReadResult> {
    return attachments.conversationAttachmentRead(this.state, rawParams);
  }

  async conversationAttachmentStat(
    rawParams: unknown,
  ): Promise<V4ConversationAttachmentStatResult> {
    return attachments.conversationAttachmentStat(this.state, rawParams);
  }

  async attachmentPreviewSource(rawParams: unknown): Promise<V4AttachmentPreviewSourceResult> {
    return attachments.attachmentPreviewSource(this.state, rawParams);
  }

  /** v4/conversation/unsubscribe。 */
  unsubscribe(rawParams: unknown): void {
    return subscriptions.unsubscribe(this.state, rawParams);
  }

  /**
   * v4/command：inbox 六态裁决；accepted 时执行副作用并把终态随响应返回。
   *
   * 这里曾经"立即回初始 ACK、后台 settle"，
   * 导致 createSession/forkAssistant 的调用方拿不到 result.sessionId（settle 只回填
   * 幂等表，只有同 commandId 重试才能读到）——违反
   * 「accepted 即时带 result」。命令副作用本身是快返回的（sendPrompt 后台起 turn），
   * await 不会把 RPC 挂到整个 turn 结束，所以同步等待终态。
   * settle 仍然固化结果供 duplicate 重放。
   */
  async handleCommand(rawParams: unknown): Promise<CommandAck> {
    return commands.handleCommand(this.state, rawParams);
  }

  /** v4/commands/query：同 key 与 handleCommand 共用 CommandInbox gate。 */
  async queryCommands(rawParams: unknown): Promise<CommandsQueryResult> {
    return commands.queryCommands(this.state, rawParams);
  }

  getQueueItem(sessionId: string, queueItemId: string): QueueItem | null {
    return readmodel.getQueueItem(this.state, sessionId, queueItemId);
  }

  hasQueueItemKind(sessionId: string, kind: QueueItem["kind"]): boolean {
    return readmodel.hasQueueItemKind(this.state, sessionId, kind);
  }

  hasQueuedDelivery(sessionId: string, delivery: "guide" | "queue"): boolean {
    return readmodel.hasQueuedDelivery(this.state, sessionId, delivery);
  }

  getQueueLength(sessionId: string): number {
    return readmodel.getQueueLength(this.state, sessionId);
  }

  /** Resident 回收保护：publisher queue 与 CommandInbox pinned facts 任一存在都不可关闭。 */
  hasResidencyBlockingCommands(sessionId: string): boolean {
    return readmodel.hasResidencyBlockingCommands(this.state, sessionId);
  }

  getQueueHead(sessionId: string): {
    autoDrain: boolean;
    dispatchState: QueueItem["dispatch"]["state"];
    kind: QueueItem["kind"];
    queueItemId: string;
    text: string;
  } | null {
    return readmodel.getQueueHead(this.state, sessionId);
  }

  /**
   * 当前输入路由模式（v4 原生能力，供命令层 host.getInputRoutingMode 使用）：
   * held choice 裁决（heldQueueInputRequiresChoice）读投影 inputRouting.mode。
   */
  getInputRoutingMode(
    sessionId: string,
  ): "startNow" | "enqueue" | "guide" | "reject" | "choice" | null {
    return readmodel.getInputRoutingMode(this.state, sessionId);
  }

  getSessionFollowupMode(sessionId: string): "queue" | "guide" | null {
    return readmodel.getSessionFollowupMode(this.state, sessionId);
  }

  /**
   * rowId → 权威 messageId（v4 原生能力，供 forkAssistant/retryTurn 定位 assistant 行）。
   * 会话无 publisher / 行不存在 / 非 assistant 行 → null（命令层据此 reject，不静默兜底）。
   */
  getMessageIdForRow(sessionId: string, rowId: number): string | null {
    return readmodel.getMessageIdForRow(this.state, sessionId, rowId);
  }

  resolveRowActionTarget(
    sessionId: string,
    target: ConversationRowTarget,
    action: ConversationRowTargetAction,
  ) {
    return readmodel.resolveRowActionTarget(this.state, sessionId, target, action);
  }

  /** rowId → 所属 product turn 内所有 transcript messageId（文件摘要撤销 / diff 查询）。 */
  getMessageIdsForTurnRow(sessionId: string, rowId: number): string[] {
    return readmodel.getMessageIdsForTurnRow(this.state, sessionId, rowId);
  }

  /** fork 目标必须是所属轮最后一段 assistantText（无投影 → null，按未知处理）。 */
  isLatestAssistantSegmentRow(sessionId: string, rowId: number): boolean | null {
    return readmodel.isLatestAssistantSegmentRow(this.state, sessionId, rowId);
  }

  resolveStableForkCandidate(sessionId: string, rowId: number) {
    return readmodel.resolveStableForkCandidate(this.state, sessionId, rowId);
  }

  /** latestAssistantRetryOnly：retry 目标必须是全时间线最新且有 realUser cause 的 assistantText。 */
  isLatestRetryAssistantRow(sessionId: string, rowId: number): boolean | null {
    return readmodel.isLatestRetryAssistantRow(this.state, sessionId, rowId);
  }

  /** latestQueryEditOnly：edit 目标必须是当前投影里的最后一条 realUser userInput row。 */
  isLatestEditableUserRow(sessionId: string, rowId: number): boolean | null {
    return readmodel.isLatestEditableUserRow(this.state, sessionId, rowId);
  }

  /** rowId → product turnId（editUserQuery 无 assistant anchor 时回查 user messageId）。 */
  getTurnIdForRow(sessionId: string, rowId: number): string | null {
    return readmodel.getTurnIdForRow(this.state, sessionId, rowId);
  }

  /**
   * rowId → 所属 turn 的 rewind 锚点 messageId（供 editUserQuery：user 行无 messageId，
   * 用同 turn 内 assistant 行的 messageId 作 `/rewind` 目标）。
   */
  getTurnRewindAnchor(sessionId: string, rowId: number): string | null {
    return readmodel.getTurnRewindAnchor(this.state, sessionId, rowId);
  }

  /** 会话关闭：清 publisher 与其全部订阅调度；hydration 标记同清（重开走冷启动重建）；
   *  仅当 `deleted` 表明持久软删除已完成时才从 workspace index 移除（session.removed）。 */
  disposeSession(sessionId: string, options: { deleted?: boolean } = {}): void {
    return lifecycle.disposeSession(this.state, sessionId, options);
  }

  /**
   * Resident 容量去激活：与 disposeSession 相同的内存运行态清理，但**不**从 sessions-index
   * 移除会话（不发 session.removed）——去激活是纯内存优化，侧边栏列表项必须原样
   * 保留，再次订阅经冷恢复透明重建。
   */
  deactivateSession(sessionId: string): void {
    return lifecycle.deactivateSession(this.state, sessionId);
  }

  /**
   * Resident 回收纯预检：调用方可在拆 runtime event subscription 前拒绝不安全回收。
   * deactivateSession 内仍复用同一校验，防止未来新增调用方绕过执行面 preflight。
   */
  assertSessionRuntimeDeactivatable(sessionId: string): void {
    return lifecycle.assertSessionRuntimeDeactivatable(this.state, sessionId);
  }

  /** Resident 回收判定：该会话是否还有 conversation 订阅者（桌面 tab / 手机 remote）。 */
  hasConversationSubscribers(sessionId: string): boolean {
    return lifecycle.hasConversationSubscribers(this.state, sessionId);
  }

  /**
   * 内存诊断计数器。只读 size，不触碰状态。
   * detachedLive 用于观察子 session publisher 是否随父 session 释放。
   */
  collectMemoryDiagnostics(): Record<string, number> {
    return lifecycle.collectMemoryDiagnostics(this.state);
  }

  dispose(): void {
    return lifecycle.dispose(this.state);
  }

  /** 测试探针：立即排空某订阅（绕过定时器）。 */
  flushNow(subscriptionId: string): ConversationTopicFrame | null {
    return flush.flushNow(this.state, subscriptionId);
  }
}
