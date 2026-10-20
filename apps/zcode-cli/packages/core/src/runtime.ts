export { AgentRuntime } from "./runtime/agent-runtime.js";
export type {
  WorkspaceGenerateTextInput,
  WorkspaceGenerateTextResult,
} from "./runtime/methods/workspace-generate-text.js";
export type { StartSavedWorkflowRunResult } from "./runtime/methods/dynamic-workflow-run-start.js";
export type {
  AmendWorkflowRunSettingsInput,
  AmendWorkflowRunSettingsResult,
} from "./runtime/methods/dynamic-workflow-run-settings.js";
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
  StopActiveForegroundExecutionOptions,
  StopActiveForegroundExecutionResult,
  TurnResult,
  WorkspaceCheckpointSummary,
  WorkspaceFileRewindApplyResult,
  WorkspaceFileRewindPreview,
  WorkspaceForkResult,
  WorkspaceRewindRestoredFile,
  WorkspaceRewindResult,
} from "./runtime/types.js";

import type { AgentRuntime } from "./runtime/agent-runtime.js";
import type { AgentRuntimeConfig } from "./runtime/types.js";

export interface RuntimeFactory {
  create(config: AgentRuntimeConfig): Promise<AgentRuntime>;
}
