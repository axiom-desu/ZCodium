import type {
  CompactPhase,
  CompactReason,
  CompactTrigger,
  MessageId,
  Model,
  PermissionBrokerRequest,
  PermissionBrokerResult,
  SessionEvent,
  ToolCallId,
  TraceContext,
  ToolCall,
  ToolSchedule,
  ToolExecutionResult,
} from "../deps.js";
import type { ExecuteToolsOptions, ExecuteToolsResult } from "../types.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type {
  AutoCompactLoopContext,
  AutoCompactOutcome,
  CompactAttemptOutcome,
  ReactiveCompactLoopContext,
  TurnRequestState,
} from "../methods/turn-loop-state.js";

export interface TurnCompactToolMethods {
  autoCompactIfNeeded(
    turnTraceContext: TraceContext,
    events: SessionEvent[],
    abortSignal: AbortSignal | undefined,
    context: AutoCompactLoopContext,
  ): Promise<AutoCompactOutcome>;
  microcompactIfNeeded(
    turnTraceContext: TraceContext,
    events: SessionEvent[],
    abortSignal: AbortSignal | undefined,
    context: {
      model: Model;
      modelStepIndex: number;
      phase: CompactPhase;
      turnRequestState: TurnRequestState;
    },
  ): Promise<void>;
  reactiveCompactAfterContextExceeded(
    originalError: unknown,
    turnTraceContext: TraceContext,
    events: SessionEvent[],
    abortSignal: AbortSignal | undefined,
    context: ReactiveCompactLoopContext,
  ): Promise<CompactAttemptOutcome>;
  compactActiveConversation(
    customInstructions: string | undefined,
    turnTraceContext: TraceContext,
    events: SessionEvent[],
    options?: {
      abortSignal?: AbortSignal;
      autoCompactThreshold?: number;
      compactReason?: CompactReason;
      initialPromptTooLongCause?: unknown;
      phase?: CompactPhase;
      sourceCommandId?: string;
      trigger?: CompactTrigger;
      model?: Model;
      activeEntries?: readonly RuntimeMessageEntry[];
    },
  ): Promise<{
    displayText: string;
    entries: readonly RuntimeMessageEntry[];
    outcome: Extract<CompactAttemptOutcome, "compacted" | "skipped">;
    tokenCount: number;
  }>;
  scheduleTools(toolCalls: ToolCall[]): Promise<ToolSchedule>;
  executeTools(
    toolCalls: ToolCall[],
    schedule: ToolSchedule,
    options?: ExecuteToolsOptions,
  ): Promise<ExecuteToolsResult>;
  emitToolScheduledEvents(
    toolCalls: ToolCall[],
    schedule: ToolSchedule,
    assistantMessageId: MessageId,
    traceContext: TraceContext,
  ): Promise<SessionEvent[]>;
  emitFileMutationCheckpoint(options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    messageId: MessageId;
    result: ToolExecutionResult;
    toolMessageId?: MessageId;
    traceContext: TraceContext;
  }): Promise<void>;
  emitPermissionRequest(toolCallId: ToolCallId, toolName: string, riskLevel: string): Promise<void>;
  resolvePermission(toolCallId: ToolCallId, decision: PermissionBrokerResult): Promise<void>;
  getPendingPermissionRequests(): PermissionBrokerRequest[];
}
