import type { TraceContext } from "@zcode/contracts";
import type {
  DynamicWorkflowRunArtifact,
  DynamicWorkflowRunArtifactBytes,
  DynamicWorkflowRunArtifactItem,
  DynamicWorkflowRunEvent,
  DynamicWorkflowRunProgressPayload,
  DynamicWorkflowRunResumeResult,
  DynamicWorkflowRunSessionSummary,
  DynamicWorkflowRunWorkspaceNode,
  DynamicWorkflowRunWorkspaceNodeResult,
  WorkflowEvent,
  WorkflowRunListItem,
} from "@zcode/contracts";
import type {
  AmendWorkflowRunSettingsInput,
  AmendWorkflowRunSettingsResult,
  ExpertWorkflowCommandResult,
  ResumeSessionResult,
  StartSavedWorkflowRunResult,
} from "@zcode/core";
import type { ResumeOptions, SubmitPromptOptions } from "./types.js";

export interface ZCodeAppWorkflowSurface {
  /**
   * workflow run 的事件日志分页（详情页审计面）。可选能力：dwf journal 不可用时 run service
   * 整个不构造，此方法随之缺席，网关据此回结构化的能力不支持错误而不是空页——
   * 「没有事件」与「这个会话没有这个能力」是两件事。
   *
   * cursor = journal sequence（`appendEvent` 单调分配），与 workflowRuns[].lastEventSequence
   * 同一把尺；越界 cursor 返回空页而不报错。
   */
  listDynamicWorkflowRunEvents?(input: {
    runId: string;
    afterSequence?: number;
    limit?: number;
  }): Promise<DynamicWorkflowRunEvent[]>;
  /**
   * 恢复一个 dwf run。可选能力，缺席条件同
   * {@link listDynamicWorkflowRunEvents}。成功路径除了 port.resume 之外还负责**追踪重臂**
   * （runtime.trackResumedDynamicWorkflowRun）：漏掉它，恢复的 run 不可取消、完成通知丢失、
   * 会话被回收护栏当成空闲。失败以结构化 reason 返回（不是 throw）——五种原因全是调用方
   * 可预期的业务分支。
   */
  resumeWorkflowRun?(input: {
    workId: string;
    name?: string;
  }): Promise<DynamicWorkflowRunResumeResult>;
  /**
   * 中枢直接启动一个已保存的工作流。GUI 在目标项目里建一个
   * 空会话后向它发 `startSavedWorkflow`：agent 解析 saved 来源 + 校验实参 + 编译，干净则以一条
   * controlOnly「启动轮」把用户的真实动作落进会话并 `port.submit` 启动 run（不经模型回合、不弹
   * `CreateWorkflow` 确认窗——用户在中枢里的点击就是同意）。可选能力，缺席条件同
   * {@link resumeWorkflowRun}（无 dwf 端口即不注册；网关回能力不支持错误）。失败以结构化 `reason`
   * 返回（不是 throw）——六种原因全是调用方可预期的业务分支，`message` 携带人可读诊断供实参窗行内展示；
   * ①② 阶段失败在**任何持久化之前**（无 run、无消息、无事件、无任务），GUI 据此 `deleteSession`
   * 收回空会话，转写里只出现真正启动了的 run。
   */
  startSavedWorkflow?(input: {
    name: string;
    scope?: "project" | "global";
    args?: Record<string, unknown>;
  }): Promise<StartSavedWorkflowRunResult>;
  /**
   * GUI「配置」改一个 run 的子代理模型与并发上界：以同一份脚本修订出新 run，不经模型轮、不开确认窗。可选能力：端口
   * 缺席、或端口不带 `amend` / `getScript` 时不注册（网关回能力不支持错误）。失败以结构化 `reason`
   * 返回——每一种都发生在停下或新建任何东西之前。
   */
  amendWorkflowRunSettings?(
    input: Omit<AmendWorkflowRunSettingsInput, "traceContext">,
  ): Promise<AmendWorkflowRunSettingsResult>;
  /**
   * workflow run 的枚举面（重启后的发现查询）。可选能力，缺席条件同
   * {@link listDynamicWorkflowRunEvents}；journal 无枚举窄查询时回空列表（诚实答案——
   * 内存 journal 的 run 本就不会活过进程）。`resumable` 按 resume 门的同一个谓词算好。
   */
  listDynamicWorkflowRuns?(input: { limit?: number }): Promise<DynamicWorkflowRunSessionSummary[]>;
  /**
   * workflow run 的冷回放：本会话名下、`excludeRunIds`
   * 之外的 run 从 journal 回放成进度事件载荷，冷物化把它们当内存事件喂给同一个 reducer——
   * `workflowRuns` 投影因此在重启前后一致。可选能力，缺席条件同 {@link listDynamicWorkflowRuns}。
   */
  replayDynamicWorkflowRuns?(input: {
    excludeRunIds: ReadonlySet<string>;
  }): Promise<DynamicWorkflowRunProgressPayload[]>;
  /**
   * workflow run 的**用户面产物**读面。三条能力
   * 一起注册、一起缺席：它们是同一个 journal 读面的三个切片，部分在场只会让 UI 拿到一张
   * 有卡片却打不开的侧板。缺席条件同 {@link listDynamicWorkflowRunEvents}，另加端口的三个
   * 可选成员必须都在。
   *
   * ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 发布给**用户**看的产出，不是引擎内部对
   * 「脚本顶层返回值」的同名叫法。
   *
   * 未知 runId 回 `undefined`（网关归一成 not found）；零件的 run 回空数组。
   */
  listDynamicWorkflowRunArtifacts?(input: {
    runId: string;
  }): Promise<readonly DynamicWorkflowRunArtifact[] | undefined>;
  /**
   * 喂给某个预置看板的 `report` 条目分页（cursor = journal sequence，严格大于）。
   * `limit` 由网关钳好再传下来，这里**精确**兑现——调用方传「上限 + 1」探测 hasMore。
   * 缺席条件同 {@link listDynamicWorkflowRunArtifacts}。
   */
  listDynamicWorkflowRunArtifactItems?(input: {
    runId: string;
    artifactId: string;
    afterSequence?: number;
    limit: number;
  }): Promise<readonly DynamicWorkflowRunArtifactItem[]>;
  /**
   * 读一个产物版本的**全部**字节；分块归网关（≤ 512 KiB 一块）。授权链在端口实现侧：
   * 该 run 必须属于本会话 ∧ journal 里有 `(artifactId, version)` 的 completed 行，然后才拿
   * **行上的** uri 去 store 读——调用方传来的任何 id 绝不直接成为路径。
   * 无此版本 / 预置看板（没有字节）/ store 缺席都回 `undefined`。
   * 缺席条件同 {@link listDynamicWorkflowRunArtifacts}。
   */
  readDynamicWorkflowRunArtifact?(input: {
    runId: string;
    artifactId: string;
    version: number;
  }): Promise<DynamicWorkflowRunArtifactBytes | undefined>;
  /**
   * workflow run 的工作区 transcript：`files.*` /
   * `git.*` / `world.run` 的 journal 行，两条一起注册、一起缺席（清单 + 一个节点的有界正文）。
   * 授权在端口实现侧（run 必须属于本会话）；不是你的 run / 未知 run 都回 `undefined`。
   * 缺席条件同 {@link listDynamicWorkflowRunArtifacts}。
   */
  listDynamicWorkflowRunWorkspaceNodes?(input: {
    runId: string;
  }): Promise<readonly DynamicWorkflowRunWorkspaceNode[] | undefined>;
  readDynamicWorkflowRunNodeResult?(input: {
    runId: string;
    siteId: string;
    ordinal: number;
    maxBytes: number;
  }): Promise<DynamicWorkflowRunWorkspaceNodeResult | undefined>;
  expertWorkflowStatus(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    runId?: string;
    workflowKind?: string;
  }): Promise<ExpertWorkflowCommandResult>;
  workflowStatus?(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    runId?: string;
    workflowKind?: string;
  }): Promise<ExpertWorkflowCommandResult>;
  validateWorkflowScript?(input: { scriptPath: string }): Promise<ExpertWorkflowCommandResult>;
  runWorkflowScript?(
    input: { args?: unknown; resumeFromRunId?: string; scriptPath: string },
    options?: SubmitPromptOptions,
  ): Promise<ExpertWorkflowCommandResult>;
  resumeWorkflowScript?(
    input: { runId: string },
    options?: SubmitPromptOptions,
  ): Promise<ExpertWorkflowCommandResult>;
  scriptWorkflowStatus?(options?: { runId?: string }): Promise<ExpertWorkflowCommandResult>;
  listScriptWorkflows?(options?: { limit?: number }): Promise<ExpertWorkflowCommandResult>;
  retryWorkflow?(options?: {
    abortSignal?: AbortSignal;
    activityId?: string;
    definitionId?: string;
    nodeId?: string;
    onEvent?: SubmitPromptOptions["onEvent"];
    phase?: string;
    runId?: string;
    traceContext?: TraceContext;
    workflowKind?: string;
  }): Promise<ExpertWorkflowCommandResult>;
  listExpertWorkflows?(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    limit?: number;
    workflowKind?: string;
  }): Promise<WorkflowRunListItem[]>;
  listWorkflows?(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    limit?: number;
    workflowKind?: string;
  }): Promise<WorkflowRunListItem[]>;
  readExpertWorkflowEvents?(options: {
    abortSignal?: AbortSignal;
    limit?: number;
    runId: string;
  }): Promise<WorkflowEvent[]>;
  readWorkflowEvents?(options: {
    abortSignal?: AbortSignal;
    limit?: number;
    runId: string;
  }): Promise<WorkflowEvent[]>;
  resume(options?: ResumeOptions): Promise<ResumeSessionResult>;
  resumeExpertWorkflow(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    onEvent?: SubmitPromptOptions["onEvent"];
    runId?: string;
    traceContext?: TraceContext;
    workflowKind?: string;
  }): Promise<ExpertWorkflowCommandResult>;
  resumeWorkflow?(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    onEvent?: SubmitPromptOptions["onEvent"];
    runId?: string;
    traceContext?: TraceContext;
    workflowKind?: string;
  }): Promise<ExpertWorkflowCommandResult>;
}
