import type { BackgroundBashOutputResult } from "@zcode/shared";
import type {
  CollaborationMode,
  BackgroundTaskCancelResult,
  SessionEvent,
  MessageId,
  Model,
  ModelSelection,
  ModelSelectionOrigin,
  PermissionBrokerRequest,
  PermissionBrokerResult,
  ProjectId,
  SessionEventSink,
  SessionEventStorePort,
  SessionId,
  SessionProjection,
  SessionGoal,
  SavedWorkflowScope,
  TargetChangedPayload,
  DynamicWorkflowRunProgressPayload,
  UserInputAutoResolutionUpdatedPayload,
  SkillLoadOutcome,
  ToolCallId,
  TraceContext,
  TurnSteerInput,
  TurnInputIntentMetadata,
  TurnSteerResult,
  ToolCall,
  TurnState,
  ToolSchedule,
  ToolExecutor,
  ToolRegistry,
  ContextBuilder,
  ExecutionShellSelection,
  TurnId,
} from "./deps.js";
import type {
  ActiveTurnInfo,
  AcquireForegroundPromotionLeaseResult,
  AgentRuntimeConfig,
  ContinueActiveTargetLoopOptions,
  ConversationBeforeInputForkOptions,
  ConversationRewindResult,
  ExecuteToolsOptions,
  ExecuteToolsResult,
  ExecuteTurnOptions,
  ForegroundPromotionLeaseMode,
  PromptAdmissionOptions,
  PromptAdmissionReceipt,
  ResumeSessionOptions,
  ResumeSessionResult,
  SelectionSideChatCreateOptions,
  StableConversationForkOptions,
  StopActiveForegroundExecutionOptions,
  StopActiveForegroundExecutionResult,
  TurnResult,
  WorkspaceCheckpointSummary,
  WorkspaceFileRewindApplyResult,
  WorkspaceFileRewindPreview,
  WorkspaceForkResult,
} from "./types.js";
import type { ChildClientPortsContext, ClientFacingPorts } from "./helpers/child-client-ports.js";
import type { StartSavedWorkflowRunResult } from "./methods/dynamic-workflow-run-start.js";
import type {
  AmendWorkflowRunSettingsInput,
  AmendWorkflowRunSettingsResult,
} from "./methods/dynamic-workflow-run-settings.js";
import type {
  ModelConnectivityTestInput,
  WorkspaceGenerateTextInput,
  WorkspaceGenerateTextResult,
} from "./methods/workspace-generate-text.js";
import type {
  RuntimeBackgroundStopOptions,
  RuntimeBackgroundStopResult,
} from "./methods/background.js";

/**
 * AgentRuntime 的公开调用面（纯类型声明）。
 *
 * 运行期实现由 `installAgentRuntimeMethods(AgentRuntime)` 装配到 prototype；本文件只描述
 * 合并到 class 上的方法签名，不持有状态、不引入实现依赖，避免 `agent-runtime.ts` 同时承载
 * 构造/装配与整张 surface 而超出 max-lines。
 */
export interface AgentRuntimeSurface {
  lastPermissionGrantId?: string;
  beginShutdown(): void;
  closeBrowserSession(): Promise<void>;
  updateConfig(
    patch: Pick<AgentRuntimeConfig, "mode" | "planEnabled" | "language" | "outputStyle">,
  ): void;
  initializeSessionShellEnvironmentIfNeeded(
    selection: ExecutionShellSelection | (() => ExecutionShellSelection),
  ): boolean;
  getSessionShellSelection(): ExecutionShellSelection | undefined;
  getMode(): CollaborationMode;
  getPlanEnabled(): boolean;
  grantPermissionFullAccess(interactionId: string, signal?: AbortSignal): Promise<string>;
  setExecutionState(
    input: { mode?: string; planEnabled?: boolean },
    traceContext?: TraceContext,
  ): Promise<void>;
  getSessionModelSelection(): ModelSelection | undefined;
  setSessionModelSelection(selection: ModelSelection | undefined): void;
  getProjectId(): ProjectId;
  ensureSessionPersistedForExternalActivity(
    input: string,
    options?: { traceContext?: TraceContext },
  ): Promise<void>;
  maybeStartSessionTitleGenerationFromExternalInput(
    input: string,
    options?: { goalSummaryTargetID?: string; traceContext?: TraceContext },
  ): void;
  /** renameSession：用户显式重命名（titleSource=custom，发 SessionTitleUpdated）。 */
  setCustomSessionTitle(input: { title: string; traceContext: TraceContext }): Promise<void>;
  maybeStartGoalSummaryTitleGeneration(
    input: string,
    targetID: string,
    options?: { traceContext?: TraceContext },
  ): boolean;
  recordExternalUserPrompt(
    input: string,
    options?: {
      goalSummaryTargetID?: string;
      traceContext?: TraceContext;
      intent?: TurnInputIntentMetadata;
    },
  ): Promise<MessageId>;
  recordPendingModelChange(input: {
    fromModel?: ModelSelection;
    fromModelLabel?: string;
    toModel: ModelSelection;
    toModelLabel: string;
  }): void;
  getActiveTurnInfo(): ActiveTurnInfo | undefined;
  admitPrompt(
    input: string,
    attachments?: TurnState["attachments"],
    options?: PromptAdmissionOptions,
  ): Promise<PromptAdmissionReceipt>;
  /** Session 常驻池使用的 runtime busy 权威事实，包含 queue/drain/reservation。 */
  hasActiveOrQueuedTurnWork(): boolean;
  /** Session 常驻池使用的后台 Bash/Agent/Workflow running 权威事实。 */
  hasRunningBackgroundTasks(): boolean;
  /**
   * Session 常驻池唯一消费的 runtime owned-work 聚合事实。
   * 包含前台/队列、registry background task、detached sidecar 和 memory work。
   */
  hasResidencyBlockingWork(): boolean;
  /**
   * 登记一段会越过当前同步调用栈的 runtime-owned work，计数在**本同步片**增加、在 promise 的
   * finally 释放（实现见 runtime/methods/residency.ts）。
   *
   * 公开在这一面上，是因为 runtime 之外的 sidecar 也要经同一个口登记：dwf 引擎跑在会话 App 里、
   * 不进 runtime task registry，因此出现「引擎在飞时会话被按 idle 关掉」。
   * 新增 sidecar 一律登记到这里，而不是在 bootstrap 侧另加一条猜测。
   */
  trackResidencyBlockingWork<T>(work: Promise<T>): Promise<T>;
  /**
   * 会话是否已落进持久化 store。协议层 record 的 draft（deferred）判定以此为事实源：任何经 runtime
   * 首次持久化的路径（首条输入、外部活动、中枢直接启动的启动轮）都会让会话离开 draft。
   */
  isSessionPersisted(): boolean;
  getActiveForegroundExecutionId(): string | undefined;
  acquireForegroundPromotionLease(options: {
    leaseId: string;
    mode: ForegroundPromotionLeaseMode;
    promotedInputId: string;
  }): AcquireForegroundPromotionLeaseResult;
  releaseForegroundPromotionLease(leaseId: string): boolean;
  enqueueDeferredInput(input: string | TurnSteerInput): Promise<TurnSteerResult>;
  steerTurn(input: string | TurnSteerInput): Promise<TurnSteerResult>;
  /** v4 queue 单项删除：按 pendingInputId 移除当前 active turn 的一条排队输入。 */
  removePendingInputById(options: {
    pendingInputId: string;
    reason: "user_removed" | "promoted";
    reservationId?: string;
    traceContext?: TraceContext;
  }): Promise<boolean>;
  reservePendingInputById(options: {
    pendingInputId: string;
    reservationId: string;
    traceContext?: TraceContext;
  }): Promise<boolean>;
  markPendingInputPromoting(options: {
    pendingInputId: string;
    reservationId: string;
    traceContext?: TraceContext;
  }): Promise<boolean>;
  releasePendingInputReservation(options: {
    pendingInputId: string;
    reservationId: string;
    traceContext?: TraceContext;
  }): Promise<boolean>;
  /** v4 queue 单项编辑：按 pendingInputId 替换排队输入文本（保位）。 */
  editPendingInputById(options: {
    pendingInputId: string;
    newText: string;
    traceContext?: TraceContext;
  }): Promise<boolean>;
  /** v4 queue 重排：移动 pendingInputId 到 beforePendingInputId 之前（null=队尾）。 */
  reorderPendingInput(options: {
    pendingInputId: string;
    beforePendingInputId: string | null;
    traceContext?: TraceContext;
  }): Promise<boolean>;
  /**
   * v4 heldQueueDisposition=clearQueueAndSend 执行件：
   * 清空全部排队输入（active turn 内存项 + held 投影残留），返回丢弃条数。
   */
  clearAllPendingInputs(traceContext: TraceContext): Promise<number>;
  /** v4 setAutoDrain：翻转 queue autoDrain 授权位（会话级）。 */
  setQueueAutoDrain(options: { autoDrain: boolean; traceContext?: TraceContext }): Promise<void>;
  /** 暂停队列外层 FIFO 已消费到空，恢复后续 running queue 的行内 drain。 */
  completeExternalQueueDrain(): void;
  /** v4 setFollowupMode：翻转 followup 路由模式（queue/guide，会话级）。 */
  setFollowupMode(options: { mode: "queue" | "guide"; traceContext?: TraceContext }): Promise<void>;
  /** v4 switchModelConfig：模型选型变化后补发 ModelSelected（config/marker 投影）。 */
  emitModelSelected(options: {
    modelSelection: ModelSelection;
    model?: Model;
    effectiveReasoningLevel?: string;
    previousModelSelection?: ModelSelection | null;
    origin?: ModelSelectionOrigin;
    supportedThoughtLevels?: readonly string[];
    traceContext?: TraceContext;
  }): Promise<void>;
  /** v4 switchCollaborationMode：协作模式切换后补发 SessionModeChanged（config.mode 投影）。 */
  emitModeChanged(options: {
    mode: CollaborationMode;
    previousMode: CollaborationMode;
    traceContext: TraceContext;
  }): Promise<void>;
  getToolRegistry(): ToolRegistry;
  /**
   * 注册表被外部改写后让 getTools 重算。公开它的唯一使用者是 dwf driver 的 submit profile 运行时
   * 守卫：静态 profile 与实际 ask 不符时把
   * typed 的 submit_result 换回通用声明——改的是同一个注册表，缓存不失效就会继续把旧声明发给模型。
   */
  invalidateToolCache(): void;
  getToolExecutor(): ToolExecutor;
  subscribeEvents(sink: SessionEventSink): () => void;
  /** Bootstrap-owned lifecycle producers append only validated session events through this durable path. */
  appendEvent(event: SessionEvent, traceContext: TraceContext): Promise<void>;
  /**
   * 外部子 runtime 的接缝（一）：交出本 runtime 的会话事件 store，供 class 外构造的子
   * runtime 共享（照 `subagent.ts` 的 `eventStore: this.eventStore`）。理由见
   * `methods/config.ts` 的实现注释。
   */
  getSessionEventStore(): SessionEventStorePort;
  /**
   * 外部子 runtime 的接缝（二）：把子会话的原始事件扇出给本 runtime 的外部 sink 集
   * （保留子 sessionId、只通知不 append）。**必须在子 runtime 构造期装成它的
   * `deps.eventSink`**——理由见 `methods/config.ts` 的实现注释。
   */
  notifyExternalChildSessionEvent(input: {
    childSessionId: SessionId;
    event: SessionEvent;
    traceContext?: TraceContext;
  }): Promise<void>;
  /**
   * 外部子 runtime 的权限交互端口已绑定本 runtime 的客户端路由身份。
   * class 外构造的子 runtime 必须经这里取得端口，不能从 appOptions 直接透传。
   */
  createChildClientPorts(context: ChildClientPortsContext): ClientFacingPorts;
  getContextBuilder(): ContextBuilder;
  /** Composer 使用的 Session Skill 快照；同一 runtime 冻结，runtime 重建后重新发现。 */
  getSkillCatalog(traceContext: TraceContext): Promise<SkillLoadOutcome>;
  resumeFromStore(options?: ResumeSessionOptions): Promise<ResumeSessionResult>;
  recordTargetChanged(input: TargetChangedPayload & { traceContext: TraceContext }): Promise<void>;
  recordUserInputAutoResolutionUpdate(
    input: UserInputAutoResolutionUpdatedPayload & { traceContext?: TraceContext },
  ): Promise<void>;
  /** workflow run 进度的出回合追加（事件源在 bootstrap 的 run service）。 */
  recordDynamicWorkflowRunProgress(
    input: DynamicWorkflowRunProgressPayload & { traceContext?: TraceContext },
  ): Promise<void>;
  /** 恢复的 workflow run 的追踪重臂（registry 登记 + started 事件 + waiter + 结算通知）。 */
  trackResumedDynamicWorkflowRun(input: {
    runId: string;
    toolCallId?: string;
    name?: string;
    traceContext?: TraceContext;
  }): Promise<void>;
  /**
   * 中枢直接启动一个已保存的工作流：解析 + 校验 + 编译，
   * 干净则 submit 启动 run、落 controlOnly 启动轮、登记后台追踪。`app.startSavedWorkflow` 能力的
   * 落地实现（端口在场时注册）。
   */
  startSavedWorkflowRun(input: {
    name: string;
    scope?: SavedWorkflowScope;
    args?: Record<string, unknown>;
    traceContext?: TraceContext;
  }): Promise<StartSavedWorkflowRunResult>;
  /**
   * GUI「配置」改一个 run 的子代理模型与并发上界：以同一份脚本修订出新 run、登记后台追踪、把设置轮排进队列。
   * `app.amendWorkflowRunSettings` 能力的落地实现。
   */
  amendWorkflowRunSettings(
    input: AmendWorkflowRunSettingsInput,
  ): Promise<AmendWorkflowRunSettingsResult>;
  recordGoalStateChangeReminder(input: {
    text: string;
    traceContext?: TraceContext;
  }): Promise<void>;
  continueActiveTargetIfIdle(options?: {
    abortSignal?: AbortSignal;
    inputId?: string;
    intent?: TurnInputIntentMetadata;
    traceContext?: TraceContext;
    verifyBeforeContinue?: boolean;
  }): Promise<TurnResult | null>;
  continueActiveTargetLoop(options: ContinueActiveTargetLoopOptions): Promise<TurnResult | null>;
  stopActiveForegroundExecution(
    options?: StopActiveForegroundExecutionOptions,
  ): StopActiveForegroundExecutionResult;
  activatePausedTargetAfterResume(traceContext: TraceContext): Promise<SessionGoal | null>;
  executeTurn(
    input: string,
    attachments?: TurnState["attachments"],
    options?: ExecuteTurnOptions,
  ): Promise<TurnResult>;
  scheduleTools(toolCalls: ToolCall[]): Promise<ToolSchedule>;
  executeTools(
    toolCalls: ToolCall[],
    schedule: ToolSchedule,
    options?: ExecuteToolsOptions,
  ): Promise<ExecuteToolsResult>;
  emitPermissionRequest(toolCallId: ToolCallId, toolName: string, riskLevel: string): Promise<void>;
  resolvePermission(toolCallId: ToolCallId, decision: PermissionBrokerResult): Promise<void>;
  getPendingPermissionRequests(): PermissionBrokerRequest[];
  getProjection(): Promise<SessionProjection>;
  readBackgroundBashOutput(workId: string, sessionId?: string): Promise<BackgroundBashOutputResult>;
  cancelBackgroundTask(
    taskId: string,
    options?: { traceContext?: TraceContext },
  ): Promise<BackgroundTaskCancelResult>;
  stopBackgroundTask(
    taskId: string,
    options: RuntimeBackgroundStopOptions,
  ): Promise<RuntimeBackgroundStopResult>;
  cancelRunningRuntimeBackgroundTasks(input: {
    reason: "subagent_cancelled";
    traceContext?: TraceContext;
  }): Promise<void>;
  sealBackgroundTaskNotifications(input: {
    reason: "subagent_terminal" | "subagent_cancelled";
    traceContext?: TraceContext;
  }): void;
  getSessionId(): SessionId;
  listWorkspaceCheckpoints(options?: { limit?: number }): Promise<WorkspaceCheckpointSummary[]>;
  forkWorkspaceFromCheckpoint(options?: {
    abortSignal?: AbortSignal;
    forkedSessionId?: SessionId;
    targetCheckpointId?: string;
    targetMessageId?: MessageId;
    traceContext?: TraceContext;
  }): Promise<WorkspaceForkResult>;
  forkStableConversationAtMessage(
    options: StableConversationForkOptions,
  ): Promise<WorkspaceForkResult>;
  createSelectionSideConversation(
    options: SelectionSideChatCreateOptions,
  ): Promise<WorkspaceForkResult>;
  forkConversationBeforeMessage(
    options: ConversationBeforeInputForkOptions,
  ): Promise<WorkspaceForkResult>;
  /**
   * conversation edit/retry 的 same-session branch cut primitive。
   *
   * 该入口故意不经过 executeTurn command queue：组合文件 rewind 会在文件事务的
   * commit gate 内调用它；若再排队 `/rewind`，当前 edit command 会等待自己释放队列。
   */
  rewindConversationToMessage(options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    targetMessageId: MessageId;
    traceContext: TraceContext;
  }): Promise<ConversationRewindResult>;
  previewWorkspaceFileRewind(options?: {
    abortSignal?: AbortSignal;
    targetCheckpointId?: string;
    targetMessageId?: MessageId;
    targetMessageIds?: MessageId[];
    targetTurnId?: TurnId;
    traceContext?: TraceContext;
  }): Promise<WorkspaceFileRewindPreview>;
  applyWorkspaceFileRewind(options?: {
    abortSignal?: AbortSignal;
    targetCheckpointId?: string;
    targetMessageId?: MessageId;
    targetMessageIds?: MessageId[];
    targetTurnId?: TurnId;
    traceContext?: TraceContext;
    commitAfterApply?: () => Promise<void>;
  }): Promise<WorkspaceFileRewindApplyResult>;
  sampleModel(
    input: import("./methods/sample-model.js").SampleModelInput,
    options: { abortSignal: AbortSignal; traceContext?: TraceContext },
  ): Promise<import("@zcode/shared/mcp-apps").McpAppsSamplingResult>;
  generateWorkspaceText(
    input: WorkspaceGenerateTextInput,
    options?: { abortSignal?: AbortSignal; traceContext?: TraceContext },
  ): Promise<WorkspaceGenerateTextResult>;
  testModelConnectivity(
    input: ModelConnectivityTestInput,
    options?: { abortSignal?: AbortSignal; traceContext?: TraceContext },
  ): Promise<void>;
  isProjectMemoryEnabled(): boolean;
  /** 缺省等待最多 60 秒；null 等待全部已调度提取结束，不设置 drain deadline。 */
  drainMemoryExtractions(timeoutMs?: number | null): Promise<void>;
  /**
   * 激活本会话的工作流工具面（launch.md「On demand: activation」）。已激活时 no-op 返回 false。
   */
  activateDynamicWorkflowTools(input: {
    source: import("./methods/dynamic-workflow-activation.js").DynamicWorkflowActivationSource;
    traceContext?: TraceContext;
  }): Promise<boolean>;
}
