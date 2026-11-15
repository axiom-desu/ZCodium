// ============================================================
// Core package exports
// ============================================================

// Agent components
export * from "./agent/index.js";

// Context Builder
export * from "./context/index.js";

// Compact helpers
export * from "./compact/index.js";

// Memory paths
export { resolveProjectMemoryRoot } from "./memory/project-root.js";

// Project Memory semantic recall / Dream（上游 3.18.2 §5/§7）。分支常量是唯一开关。
export {
  ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH,
  resolveProjectMemoryRetrievalBranch,
} from "./memory/project-memory-retrieval-branch.js";
export type { ProjectMemoryRetrievalBranch } from "./memory/project-memory-retrieval-branch.js";
export {
  consumeSettledProjectMemoryRecall,
  disposeProjectMemoryRecallPrefetch,
  invalidateProjectMemoryRecallPaths,
  resetProjectMemoryRecall,
  startProjectMemoryRecallPrefetch,
} from "./runtime/helpers/project-memory-recall.js";
export {
  consumePendingProjectMemoryUpdate,
  runProjectMemoryDream,
  selectProjectDreamSessions,
} from "./runtime/helpers/project-memory-dream.js";
export {
  acquireDreamLock,
  buildMemoryDreamPrompt,
  collectDreamTouchedPaths,
  evaluateAutoDreamTiming,
  readDreamLastConsolidatedAt,
  restoreDreamLockAfterFailure,
} from "./memory/dream.js";
export {
  canStartMemoryRecall,
  createMemoryRecallState,
  filterMemorySelections,
  findLatestMemoryRecallQuery,
  formatMemoryManifest,
  formatRelevantMemoryAttachment,
  getMemoryRecallManifest,
  isMemoryRecallQueryEligible,
  MEMORY_RECALL_SESSION_CHARACTER_LIMIT,
  readRecalledMemories,
  recordRecalledMemories,
  runMemorySelector,
  scanMemoryManifest,
} from "./memory/recall/index.js";
export type {
  MemoryManifestEntry,
  MemoryRecallState,
  MemorySelectorResult,
  RecalledMemory,
} from "./memory/recall/index.js";

// Tool components
export { ToolScheduler, defaultToolScheduler, READ_ONLY_TOOLS } from "./tool/scheduler.js";
export type { ToolSchedule, ToolScheduleItem, ToolDependency } from "./tool/scheduler.js";
export { createToolRegistry, ToolRegistry, ToolRegistryImpl } from "./tool/registry.js";
export { createToolExecutor, ToolExecutor, ToolExecutorImpl } from "./tool/executor.js";
export {
  APP_SESSION_CONTROL_TOOL_NAMES,
  CLI_SESSION_CONTROL_TOOL_NAMES,
  builtInTools,
  registerBuiltInTools,
  SESSION_CONTROL_TOOL_NAMES,
  appSessionControlTools,
  sessionControlTools,
  sessionControlToolsByKind,
} from "./tool/handlers/index.js";
// 会话控制绑定由启动装配构造：命令工具面与执行面共用同一份类型，避免 bootstrap 另立结构。
export type {
  AppSessionControlBinding,
  CliSessionControlBinding,
  SessionControlBinding,
} from "./tool/session-control/contract.js";
// dwf driver 的 submit profile 运行时守卫要把 typed 声明换回通用声明。
export {
  createSubmitResultToolEntry,
  submitResultToolEntry,
} from "./tool/handlers/submit-result.js";
// 已保存工作流的 store / codec：GUI 中枢的协议处理器住在
// bootstrap，但解析器与序列化器只能有一份——写侧与读侧各自演化的症状是「刚保存的 workflow
// 列不出来」，所以从这里导出而不是让 bootstrap 再抄一份。
export {
  SAVED_WORKFLOW_SENTINEL,
  findSavedWorkflowShadowing,
  listSavedWorkflows,
  moveSavedWorkflow,
  parseSavedWorkflow,
  resolveSavedWorkflow,
  saveSavedWorkflow,
  savedWorkflowExists,
  savedWorkflowFileName,
  savedWorkflowPath,
  savedWorkflowRoot,
  savedWorkflowRoots,
  serializeSavedWorkflow,
  validateWorkflowArgs,
} from "./tool/handlers/saved-workflows/index.js";
export type {
  ResolvedSavedWorkflow,
  SavedWorkflowListResult,
  SavedWorkflowMoveResult,
  SavedWorkflowParseErrorReason,
  SavedWorkflowParseResult,
  SavedWorkflowResolveFailure,
  SavedWorkflowResolveResult,
  SavedWorkflowRoot,
  SavedWorkflowRootsOptions,
  WorkflowArgsValidation,
} from "./tool/handlers/saved-workflows/index.js";
export {
  DEFAULT_BASH_MAX_TIMEOUT_MS,
  DEFAULT_BASH_TIMEOUT_MS,
  DEFAULT_BASH_TIMEOUT_POLICY,
  resolveBashTimeoutMs,
  resolveBashTimeoutPolicy,
} from "./tool/bash-timeout-policy.js";
export type { BashTimeoutPolicy } from "./tool/bash-timeout-policy.js";
export type {
  ToolMetadata,
  ToolHandler,
  ToolExecutionContext,
  ToolEntry,
  ToolExecutionResult,
  ToolResultSerialization,
  ToolBatchResult,
  ExecutableToolCall,
  ToolBatchEvent,
} from "./tool/types.js";

// Hooks
export * from "./hooks/index.js";

// MCP components
export * from "./mcp/index.js";

// Plugin 对话引用（@ Plugin capability hint）
export * from "./plugin-reference/index.js";

// Node REPL/browser-use plugin runtime primitives
export { NodeReplSession } from "./repl/node-repl-session.js";
export type {
  NodeReplCuaAppIdentity,
  NodeReplImage,
  NodeReplRequestMeta,
  NodeReplRunResult,
  NodeReplStructuredResult,
  NodeReplSessionOptions,
} from "./repl/node-repl-session.js";
export { setupBrowserRuntime } from "./browser-client/index.js";
export type { BrowserClientTransport } from "./browser-client/index.js";

// Subagent components
export * from "./subagent/index.js";

// Runtime task components
export * from "./runtime-task/index.js";

// 手机远控输入预测 sidecar（纯函数 + 模型调用编排壳，供 bootstrap handler 使用）。
export * from "./runtime/methods/input-prediction-sidecar.js";

// Workflow components
export * from "./workflow/definition.js";
export * from "./workflow/expert.js";
export * from "./workflow/lifecycle.js";
export * from "./workflow/scheduler.js";

// Permission components
export {
  DenyPermissionBroker,
  ManualPermissionBroker,
  PermissionService,
  createDenyPermissionBroker,
  createManualPermissionBroker,
  defaultPermissionConfig,
} from "./permission/index.js";
export type {
  ManualPermissionBrokerOptions,
  PermissionBehavior,
  PermissionContext,
  PermissionDecisionResult,
  PermissionToolCapability,
} from "./permission/index.js";
export type { PermissionConfig } from "./permission/index.js";

// Runtime
export { AgentRuntime } from "./runtime.js";
export { createExternalTurnFaultError } from "./runtime/helpers/turn-errors.js";
export { repairPersistedRemoteSessionPaths } from "./runtime/helpers/persisted-remote-session-path-repair.js";
// 「按值把一段转录复制进另一个会话」的克隆器。fork 之外的第二个消费者是 dwf 的 amend-resume
// 转录截断（bootstrap 的 workflow-actor-transcript.ts）：同一个动作——新会话用本地 id 续写，
// parentID / part 内嵌锚点随之重映射。导出而不是让它再写一份，是因为漏掉任何一处重映射的症状
// （悬空 parentID、指向父会话的锚点）离成因都很远。
export { cloneMessageForFork, clonePartForFork } from "./runtime/helpers/steering.js";
export type {
  ChildClientPortsContext,
  ClientFacingPorts,
} from "./runtime/helpers/child-client-ports.js";
export type {
  ActiveTurnInfo,
  AgentRuntimeConfig,
  AgentRuntimeDeps,
  ConversationRewindResult,
  ExecuteTurnOptions,
  ModelExecutionContext,
  PromptAdmissionOptions,
  PromptAdmissionReceipt,
  ResumeSessionOptions,
  ResumeSessionResult,
  StartSavedWorkflowRunResult,
  AmendWorkflowRunSettingsInput,
  AmendWorkflowRunSettingsResult,
  TurnResult,
  WorkspaceGenerateTextInput,
  WorkspaceGenerateTextResult,
  WorkspaceForkResult,
  WorkspaceCheckpointSummary,
  WorkspaceFileRewindApplyResult,
  WorkspaceFileRewindPreview,
  WorkspaceRewindRestoredFile,
  WorkspaceRewindResult,
  RuntimeFactory,
} from "./runtime.js";

// Output helpers
export { color, formatJson, supportsColor } from "./output.js";

// Environment helpers
export { getRuntimeInfo } from "./environment.js";
export type { RuntimeInfo } from "./environment.js";

export type {
  Logger,
  LoggerFactory,
  LogContext,
  LogEntry,
  SessionEvent,
  SessionEventSink,
} from "@zcode/contracts";
export { LogLevel, SessionEventType } from "@zcode/contracts";
