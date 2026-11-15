export const ModelApiOperation = {
  AgentStep: "agent_step",
  ContextCompaction: "context_compaction",
  GoalTitle: "goal_title_generation",
  GoalVerification: "goal_completion_verification",
  GitCommitMessage: "workspace_git_commit_message",
  ProjectMemoryDream: "project_memory_dream",
  ProjectMemoryExtract: "project_memory_extract",
  ReadSessionContextExtract: "read_session_context_extract",
  ReadSessionContextSynthesize: "read_session_context_synthesize",
  SessionTitle: "session_title_generation",
  ToolInternalModelCall: "tool_internal_model_call",
  WebFetch: "web_fetch_processing",
  WebSearch: "web_search",
  WorkspaceGenerateText: "workspace_generate_text",
} as const;

export type ModelApiOperation = (typeof ModelApiOperation)[keyof typeof ModelApiOperation];

export const ModelApiActorKind = {
  MainAgent: "main",
  Subagent: "subagent",
  WorkflowChild: "workflow_child",
  System: "system",
  Tool: "tool",
} as const;

export type ModelApiActorKind = (typeof ModelApiActorKind)[keyof typeof ModelApiActorKind];
export type ModelApiCallCause = "initial" | "continuation" | "fallback_replacement" | "recovery";
export type ModelApiErrorPhase =
  | "prepare"
  | "configuration"
  | "connect"
  | "response"
  | "stream"
  | "parse"
  | "validation"
  | "unhandled";
export const ModelFailureExceptionKind = {
  ApiCall: "api_call",
  Generic: "generic",
  Protocol: "protocol",
  ProviderBusiness: "provider_business",
  Transport: "transport",
  TypeError: "type_error",
  Validation: "validation",
} as const;
export type ModelFailureExceptionKind =
  (typeof ModelFailureExceptionKind)[keyof typeof ModelFailureExceptionKind];
export type ModelReasoningCapabilityStatus = "supported" | "unsupported" | "unknown";
export type ModelReasoningState = "enabled" | "disabled" | "provider_default" | "unknown";
export type ModelReasoningControlType =
  | "fixed_level"
  | "fixed_budget"
  | "adaptive"
  | "toggle"
  | "provider_default"
  | "unknown";

/** 调用点只声明用户/业务请求的 reasoning 意图，Provider Adapter 决定最终事实。 */
export interface ModelReasoningCallHint {
  requestedLevel?: string;
  explicit?: {
    state: Exclude<ModelReasoningState, "unknown">;
    controlType?: Exclude<ModelReasoningControlType, "unknown">;
    effectiveLevel?: string;
    effectiveBudgetTokens?: number;
  };
}

/** 一次最终 Provider 请求的 canonical reasoning 事实。 */
export interface ModelReasoningObservation {
  capability: ModelReasoningCapabilityStatus;
  requestedState: ModelReasoningState;
  requestedControl: ModelReasoningControlType;
  requestedLevel?: string;
  requestedBudgetTokens?: number;
  effectiveState: ModelReasoningState;
  effectiveControl: ModelReasoningControlType;
  effectiveLevel?: string;
  effectiveBudgetTokens?: number;
}

/**
 * 受控调用专属事实。禁止 prompt、message、header、body、原始 URL、命令和工具 I/O。
 */
export interface ModelApiCustomAttributes {
  compactionOuterAttempt?: number;
  compactionTrigger?: string;
  streamRecoveryNumber?: number;
}

export interface ModelApiCallObservation {
  operation?: ModelApiOperation;
  actorKind?: ModelApiActorKind;
  operationId?: string;
  logicalCallId?: string;
  callCause?: ModelApiCallCause;
  previousLogicalCallId?: string;
  agentName?: string;
  stepIndex?: number;
  reasoning?: ModelReasoningCallHint;
  attributes?: ModelApiCustomAttributes;
}

export type ResolvedModelApiCallObservation = Omit<ModelApiCallObservation, "reasoning"> & {
  logicalCallId: string;
  operation: ModelApiOperation;
  actorKind: ModelApiActorKind;
  reasoning: ModelReasoningObservation;
};

export function resolveModelApiCallObservation(
  querySource: string | undefined,
  observation: ModelApiCallObservation | undefined,
): Required<Pick<ModelApiCallObservation, "operation" | "actorKind" | "logicalCallId">> &
  ModelApiCallObservation {
  const mapped = mapQuerySourceToModelApiOperation(querySource);
  return {
    ...mapped,
    ...observation,
    operation: observation?.operation ?? mapped.operation,
    actorKind: observation?.actorKind ?? mapped.actorKind,
    logicalCallId: observation?.logicalCallId?.trim() || crypto.randomUUID(),
  };
}

function mapQuerySourceToModelApiOperation(querySource: string | undefined): {
  operation: ModelApiOperation;
  actorKind: ModelApiActorKind;
} {
  switch (querySource?.trim()) {
    case "main_turn":
      return { operation: ModelApiOperation.AgentStep, actorKind: ModelApiActorKind.MainAgent };
    case "subagent":
      return { operation: ModelApiOperation.AgentStep, actorKind: ModelApiActorKind.Subagent };
    case "workflow_child":
      return {
        operation: ModelApiOperation.AgentStep,
        actorKind: ModelApiActorKind.WorkflowChild,
      };
    case "compact":
      return {
        operation: ModelApiOperation.ContextCompaction,
        actorKind: ModelApiActorKind.System,
      };
    case "session_title":
      return {
        operation: ModelApiOperation.SessionTitle,
        actorKind: ModelApiActorKind.System,
      };
    case "goal_summary_title":
      return { operation: ModelApiOperation.GoalTitle, actorKind: ModelApiActorKind.System };
    case "target_completion_verification":
      return {
        operation: ModelApiOperation.GoalVerification,
        actorKind: ModelApiActorKind.System,
      };
    case "git_commit_message":
      return {
        operation: ModelApiOperation.GitCommitMessage,
        actorKind: ModelApiActorKind.System,
      };
    case "web_search_tool":
      return { operation: ModelApiOperation.WebSearch, actorKind: ModelApiActorKind.Tool };
    case "web_fetch_processing":
      return { operation: ModelApiOperation.WebFetch, actorKind: ModelApiActorKind.Tool };
    case "read_session_context":
      return {
        operation: ModelApiOperation.ReadSessionContextExtract,
        actorKind: ModelApiActorKind.Tool,
      };
    case "project_memory_extract":
      return {
        operation: ModelApiOperation.ProjectMemoryExtract,
        actorKind: ModelApiActorKind.System,
      };
    case "project_memory_dream":
      return {
        operation: ModelApiOperation.ProjectMemoryDream,
        actorKind: ModelApiActorKind.System,
      };
    default:
      return {
        operation: ModelApiOperation.ToolInternalModelCall,
        actorKind: ModelApiActorKind.System,
      };
  }
}
