import type { MessageId, PartId, SessionId } from "../shared.js";
import type { ModelId, ModelProviderId } from "../../model/index.js";
import type { CreateSessionInput, SessionEntryInfo } from "./session-contracts.js";
import type {
  AgentPart,
  AssistantErrorInfo,
  CompactionPart,
  FilePart,
  MessageInfo,
  ReasoningPart,
  TextPart,
  TimelinePart,
  TokenUsageInfo,
} from "./message-contracts.js";

export interface SubtaskPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "subtask";
  prompt: string;
  description: string;
  agent: string;
  model?: {
    providerId: ModelProviderId;
    modelId: ModelId;
  };
  command?: string;
}

export interface RetryPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "retry";
  attempt: number;
  error: AssistantErrorInfo;
  time: {
    created: number;
  };
}

export interface StepStartPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "step-start";
  snapshot?: string;
}

export interface StepFinishPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "step-finish";
  reason: string;
  snapshot?: string;
  cost: number;
  tokens: TokenUsageInfo;
}

export interface SnapshotPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "snapshot";
  snapshot: string;
}

export interface PatchPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "patch";
  hash: string;
  files: string[];
}

export interface ToolStatePending {
  status: "pending";
  input: Record<string, unknown>;
  raw: string;
}

export interface ToolStateRunning {
  status: "running";
  input: Record<string, unknown>;
  title?: string;
  metadata?: Record<string, unknown>;
  time: {
    start: number;
  };
}

export interface ToolStateCompleted {
  status: "completed";
  input: Record<string, unknown>;
  output: string;
  title: string;
  metadata: Record<string, unknown>;
  time: {
    start: number;
    end: number;
    compacted?: number;
  };
  attachments?: FilePart[];
}

export interface ToolStateError {
  status: "error";
  input: Record<string, unknown>;
  error: string;
  metadata?: Record<string, unknown>;
  time: {
    start: number;
    end: number;
  };
}

export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError;

export interface ToolPart {
  id: PartId;
  sessionID: SessionId;
  messageID: MessageId;
  type: "tool";
  callID: string;
  /** 同一 assistant 内本地工具的声明序号；旧记录可缺失，不能用落盘顺序代替。 */
  declarationIndex?: number;
  tool: string;
  state: ToolState;
  metadata?: Record<string, unknown>;
}

export type MessagePart =
  | TextPart
  | ReasoningPart
  | FilePart
  | AgentPart
  | CompactionPart
  | TimelinePart
  | SubtaskPart
  | RetryPart
  | StepStartPart
  | StepFinishPart
  | SnapshotPart
  | PatchPart
  | ToolPart;

export interface MessageWithParts {
  info: MessageInfo;
  parts: MessagePart[];
}

/** 分享导入的单事务载荷：新 session、唯一 model-only 上下文和 provenance 全有或全无。 */
export interface SharedContextImportCommitBundle {
  session: CreateSessionInput;
  contextMessage: MessageWithParts;
  provenance: SessionEntryInfo;
}

export type SharedContextImportStatus = "pending" | "reserved" | "attached" | "discarded";

export interface SharedContextImportTransition {
  sessionID: SessionId;
  contextId: string;
  expectedStatus: SharedContextImportStatus | readonly SharedContextImportStatus[];
  status: SharedContextImportStatus;
  /** queue/input identity or accepted user message identity for audit/recovery. */
  sourceId?: string;
}
