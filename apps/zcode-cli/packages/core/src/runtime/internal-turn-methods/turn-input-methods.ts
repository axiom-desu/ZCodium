import type {
  MessageId,
  MessageWithParts,
  Model,
  SessionEvent,
  SessionId,
  TraceContext,
  TurnId,
  CheckpointCreatedPayload,
  RewindScope,
  RewindTargetEvaluation,
  WorkspaceCheckpointArtifact,
  TurnState,
} from "../deps.js";
import type {
  ActiveTurnStartReservation,
  ConversationRewindResult,
  ExecuteTurnOptions,
  PromptAdmissionOptions,
  PromptAdmissionReceipt,
  ParsedRewindCommand,
  TurnResult,
  WorkspaceRewindRestoredFile,
  WorkspaceRewindResult,
} from "../types.js";

export interface TurnInputMethods {
  admitPrompt(
    input: string,
    attachments?: TurnState["attachments"],
    options?: PromptAdmissionOptions,
  ): Promise<PromptAdmissionReceipt>;
  executeTurn(
    input: string,
    attachments?: TurnState["attachments"],
    options?: ExecuteTurnOptions,
  ): Promise<TurnResult>;
  executeTurnCommand(
    input: string,
    attachments?: TurnState["attachments"],
    options?: ExecuteTurnOptions,
    startReservation?: ActiveTurnStartReservation,
  ): Promise<TurnResult>;
  executeManualCompact(
    input: string,
    customInstructions: string | undefined,
    turnId: TurnId,
    turnTraceContext: TraceContext,
    abortSignal?: AbortSignal,
    inputId?: string,
    model?: Model,
  ): Promise<TurnResult>;
  executeRewindCommand(
    input: string,
    command: ParsedRewindCommand,
    turnId: TurnId,
    turnTraceContext: TraceContext,
    abortSignal?: AbortSignal,
    inputId?: string,
  ): Promise<TurnResult>;
  formatRewindStatus(): Promise<string>;
  rewindWorkspaceToCheckpoint(options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    targetCheckpointId?: string;
    traceContext: TraceContext;
  }): Promise<WorkspaceRewindResult>;
  rewindToMessage(options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    scope: RewindScope;
    targetMessageId: MessageId;
    traceContext: TraceContext;
  }): Promise<ConversationRewindResult | WorkspaceRewindResult>;
  rewindCascadeToMessage(options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    scope: RewindScope;
    targetMessageId: MessageId;
    traceContext: TraceContext;
  }): Promise<ConversationRewindResult | WorkspaceRewindResult>;
  rewindConversationToMessage(options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    targetMessageId: MessageId;
    traceContext: TraceContext;
  }): Promise<ConversationRewindResult>;
  rewindWorkspaceToMessage(options: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    scope: RewindScope;
    targetMessageId: MessageId;
    traceContext: TraceContext;
  }): Promise<WorkspaceRewindResult>;
  finishUnavailableRewind(options: {
    checkpoint?: CheckpointCreatedPayload;
    evaluation?: RewindTargetEvaluation;
    events: SessionEvent[];
    reason: string;
    rewindId: string;
    scope?: RewindScope;
    targetCheckpointId?: string;
    targetMessageId?: MessageId;
    traceContext: TraceContext;
  }): Promise<WorkspaceRewindResult>;
  restoreWorkspaceCheckpointArtifact(
    artifact: WorkspaceCheckpointArtifact,
    traceContext: TraceContext,
    abortSignal?: AbortSignal,
  ): Promise<WorkspaceRewindRestoredFile[]>;
  copySessionMessagesForFork(options: {
    forkedSessionId: SessionId;
    messages: MessageWithParts[];
    traceContext: TraceContext;
  }): Promise<{
    copiedMessageCount: number;
    messageIdMap: Map<MessageId, MessageId>;
  }>;
}
