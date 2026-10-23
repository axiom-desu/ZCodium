import type { MessageId, PartId, ProjectId, SessionId } from "../shared.js";
import type { TodoItem } from "../../tools/todo.js";
import type { SessionGoal, GoalStatus } from "../../tools/target.js";
import type { PermissionRuleset } from "../permission.port.js";
import type { CollaborationMode } from "../session.port.js";
import type {
  ClaimLegacySessionWorkspaceInput,
  CreateSessionInput,
  FileDiff,
  ForkChildSessionMetadata,
  ForkCommitBundle,
  ListSessionsInput,
  RepairLegacyRemoteSessionWorkspaceInput,
  RepairRemoteSessionPathsInput,
  SessionEntryInfo,
  SessionEntryType,
  SessionInfo,
  SessionInputDelivery,
  SessionInputRecord,
  SessionInputStatus,
  SessionRevert,
  UpdateSessionInput,
} from "./session-contracts.js";
import type { MessageInfo } from "./message-contracts.js";
import type {
  MessagePart,
  MessageWithParts,
  SharedContextImportCommitBundle,
  SharedContextImportTransition,
} from "./part-contracts.js";

export interface LocalSettingStorePort {
  getProjectPermissionMode(
    projectID: ProjectId,
  ): CollaborationMode | null | Promise<CollaborationMode | null>;
  saveProjectPermissionMode(input: {
    mode: CollaborationMode;
    projectID: ProjectId;
  }): CollaborationMode | Promise<CollaborationMode>;
}

export interface SessionStorePort {
  createSession(input: CreateSessionInput): Promise<SessionInfo>;
  /** legacy 兼容原语；V4 stable/compact-edit fork 禁止调用，统一走 commitForkBundle。 */
  createForkedSessionWithMetadata?(
    input: CreateSessionInput,
    metadata: ForkChildSessionMetadata,
  ): Promise<SessionInfo>;
  /** V4 stable/compact-edit fork 的唯一事务入口。legacy workspace fork 不调用。 */
  commitForkBundle?(bundle: ForkCommitBundle): Promise<SessionInfo>;
  commitSharedContextImportBundle?(bundle: SharedContextImportCommitBundle): Promise<SessionInfo>;
  transitionSharedContextImport?(input: SharedContextImportTransition): Promise<boolean>;
  updateSession(input: UpdateSessionInput): Promise<SessionInfo>;
  getSession(sessionID: SessionId): Promise<SessionInfo | null>;
  listSessions(input?: ListSessionsInput): Promise<SessionInfo[]>;
  /**
   * 用 host task-index allowlist 为旧远端 session 补写 workspace identity。
   * 实现必须同时校验 id、directory 与 workspace_id is null，禁止覆盖已有 identity。
   */
  claimLegacySessionWorkspace?(input: ClaimLegacySessionWorkspaceInput): Promise<number>;
  /**
   * 修复曾把 remote identity 写入 directory/path 的单条历史 session。
   * 实现必须校验 session id、NULL workspace_id 及旧目录精确匹配，禁止批量路径迁移。
   */
  repairLegacyRemoteSessionWorkspace?(
    input: RepairLegacyRemoteSessionWorkspaceInput,
  ): Promise<boolean>;
  /**
   * 已有 remote identity 的维护性路径自愈 CAS。
   * 实现只能更新 directory、path 和单调 time_updated，禁止写回其它 session 元数据。
   */
  repairRemoteSessionPaths?(input: RepairRemoteSessionPathsInput): Promise<boolean>;
  saveMessage(input: MessageInfo, copyFrom?: { sessionID: SessionId; id: string }): Promise<void>;
  removeMessage(input: { sessionID: SessionId; messageID: MessageId }): Promise<void>;
  savePart(input: MessagePart, copyFrom?: { sessionID: SessionId; id: string }): Promise<void>;
  removePart(input: { sessionID: SessionId; messageID: MessageId; partID: PartId }): Promise<void>;
  messageWithParts(input: {
    sessionID: SessionId;
    messageID: MessageId;
  }): Promise<MessageWithParts | null>;
  messages(input: { sessionID: SessionId }): Promise<MessageWithParts[]>;
  saveSessionEntry?(input: SessionEntryInfo): Promise<void>;
  sessionEntries?(input: {
    sessionID: SessionId;
    type?: SessionEntryType | string;
  }): Promise<SessionEntryInfo[]>;
  // ── session_input 账本（可选方法，旧宿主可不实现）──
  /** admission：输入已被接受（排队/待注入），durable 记账。幂等（同 id 重入更新 payload）。 */
  saveSessionInput?(input: {
    id: string;
    sessionID: SessionId;
    kind: string;
    delivery: SessionInputDelivery;
    payload: { text: string; [key: string]: unknown };
  }): Promise<void>;
  /** 审批完全访问：execution、固定队列权限和幂等 receipt 同一事务；无 schema migration。 */
  commitPermissionFullAccess?(input: {
    sessionID: SessionId;
    queueItemIds: string[];
    execution: SessionEntryInfo;
    receipt: SessionEntryInfo;
    signal?: AbortSignal;
  }): Promise<void>;
  /** queue 编辑/重排的 durable 原子更新；只允许修改 admitted 记录。 */
  updateSessionInputs?(input: {
    sessionID: SessionId;
    updates: Array<{
      delivery?: SessionInputDelivery;
      id: string;
      intent?: import("../session.port.js").TurnInputIntentMetadata;
      text?: string;
      queuePosition?: number;
    }>;
  }): Promise<void>;
  /**
   * promotion（原子性硬要求）：账本置 promoted + user message/parts
   * 持久化在同一事务——杜绝「queue 已消费但 transcript 无 user message」的孤儿窗口。
   */
  promoteSessionInput?(input: {
    id: string;
    sessionID: SessionId;
    message: MessageInfo;
    parts: MessagePart[];
  }): Promise<void>;
  /**
   * 非原子 promotion 标记：message 持久化已在别处完成的路径（background wake 的
   * synthetic notice）只补账本状态。新路径应优先用 promoteSessionInput（原子）。
   */
  markSessionInputPromoted?(input: {
    id: string;
    sessionID: SessionId;
    promotedMessageID: MessageId;
  }): Promise<void>;
  /** 终态收口：cancelled（user_removed 等）/ discarded（session_resumed / user_cleared）。 */
  settleSessionInput?(input: {
    id: string;
    sessionID: SessionId;
    status: "cancelled" | "discarded" | "failed";
    reason?: string;
  }): Promise<void>;
  listSessionInputs?(input: {
    sessionID: SessionId;
    status?: SessionInputStatus;
  }): Promise<SessionInputRecord[]>;
  /** global createSession.firstInput 查重：由 queue_<sourceCommandId> 找回真实 session。 */
  getSessionInputById?(id: string): Promise<SessionInputRecord | null>;
  readTodos(input: { sessionID: SessionId }): Promise<TodoItem[]>;
  updateTodos(input: { sessionID: SessionId; todos: TodoItem[] }): Promise<void>;
  readTarget(input: { sessionID: SessionId }): Promise<SessionGoal | null>;
  setTarget(input: {
    objective: string;
    sessionID: SessionId;
    status?: GoalStatus;
    tokenBudget?: number | null;
  }): Promise<SessionGoal>;
  cloneTargetForFork?(input: {
    source: SessionGoal;
    sessionID: SessionId;
    status?: GoalStatus;
  }): Promise<SessionGoal>;
  createTarget(input: {
    objective: string;
    sessionID: SessionId;
    tokenBudget?: number | null;
  }): Promise<SessionGoal | null>;
  updateTargetStatus(input: {
    sessionID: SessionId;
    status: GoalStatus;
  }): Promise<SessionGoal | null>;
  startTargetRun?(input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    startedAtMs: number;
  }): Promise<SessionGoal | null>;
  heartbeatTargetRun?(input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    seenAtMs: number;
  }): Promise<SessionGoal | null>;
  finishTargetRun?(input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    endedAtMs: number;
    status?: GoalStatus;
    tokensUsedDelta?: number;
  }): Promise<SessionGoal | null>;
  recoverInterruptedTargetRun?(input: { sessionID: SessionId }): Promise<SessionGoal | null>;
  accountTargetUsage(input: {
    sessionID: SessionId;
    targetID: string;
    tokensUsedDelta?: number;
    timeUsedSecondsDelta?: number;
  }): Promise<SessionGoal | null>;
  updateTargetSummaryTitle(input: {
    sessionID: SessionId;
    targetID: string;
    summaryTitle: string;
  }): Promise<SessionGoal | null>;
  clearTarget(input: { sessionID: SessionId }): Promise<boolean>;
  getProjectPermission(projectID: ProjectId): Promise<PermissionRuleset | null>;
  saveProjectPermission(input: {
    projectID: ProjectId;
    permission: PermissionRuleset;
  }): Promise<PermissionRuleset>;
  setRevert(input: {
    sessionID: SessionId;
    revert: SessionRevert;
    summary?: { additions: number; deletions: number; files: number; diffs?: FileDiff[] };
  }): Promise<void>;
  clearRevert(sessionID: SessionId): Promise<void>;
}
