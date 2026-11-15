import type {
  ClaimLegacySessionWorkspaceInput,
  CreateSessionInput,
  FileDiff,
  ListSessionsInput,
  MessageId,
  MessageInfo,
  MessagePart,
  MessageWithParts,
  PartId,
  RepairLegacyRemoteSessionWorkspaceInput,
  RepairRemoteSessionPathsInput,
  SessionEntryInfo,
  SessionEntryType,
  SessionDeletionSnapshot,
  SessionId,
  SessionInfo,
  SessionInputDelivery,
  SessionInputRecord,
  SessionInputStatus,
  SessionRevert,
  SessionStorePort,
  TodoItem,
  UpdateSessionInput,
} from "@zcode/contracts";
import * as permissionFullAccessRepository from "./repositories/permission-full-access.js";
import * as messageRepository from "./repositories/messages.js";
import * as sessionDeletionRepository from "./repositories/session-deletion.js";
import * as sessionEntryRepository from "./repositories/session-entries.js";
import * as sessionInputRepository from "./repositories/session-inputs.js";
import * as sessionRepository from "./repositories/sessions.js";
import * as todoRepository from "./repositories/todos.js";
import { SessionStoreSurface } from "./surface-base.js";

export class RepositorySurface extends SessionStoreSurface {
  async createSession(input: CreateSessionInput): Promise<SessionInfo> {
    this.throwBeforeWrite();
    return sessionRepository.createSession(this.db, input);
  }

  async updateSession(input: UpdateSessionInput): Promise<SessionInfo> {
    this.throwBeforeWrite();
    return sessionRepository.updateSession(this.db, input);
  }

  async getSession(sessionID: SessionId): Promise<SessionInfo | null> {
    return sessionRepository.getSession(this.db, sessionID);
  }

  async softDeleteSession(sessionID: SessionId, timeDeleted?: number): Promise<void> {
    this.throwBeforeWrite();
    sessionRepository.softDeleteSession(this.db, sessionID, timeDeleted ?? Date.now());
  }

  // 项目数据彻底删除（v4/storage/sessionData/*）：owned 树、附件引用保护、行删除。
  async listOwnedSessionTrees(sessionIDs: SessionId[]): Promise<Map<SessionId, SessionId[]>> {
    return sessionRepository.listOwnedSessionTrees(this.db, sessionIDs);
  }

  async listArtifactReferrers(sessionIDs: SessionId[]): Promise<Map<SessionId, SessionId[]>> {
    return sessionRepository.listArtifactReferrers(this.db, sessionIDs);
  }

  async purgeSessions(sessionIDs: SessionId[]): Promise<void> {
    this.throwBeforeWrite();
    sessionRepository.purgeSessions(this.db, sessionIDs);
  }

  // 归档永久删除：预检 → 写入删除凭据 → 文件清理 → 删正文（bootstrap 执行面编排）。
  async inspectSessionDeletion(sessionID: SessionId): Promise<SessionDeletionSnapshot> {
    return sessionDeletionRepository.inspectSessionDeletion(
      this.db,
      sessionID,
      this.runtimeOwnerId,
    );
  }

  async beginSessionDeletion(
    sessionID: SessionId,
    revision: string,
    operationId: string,
    retained: Array<{ sessionId: SessionId; artifactId: string }>,
  ): Promise<void> {
    this.throwBeforeWrite();
    sessionDeletionRepository.beginSessionDeletion(
      this.db,
      sessionID,
      this.runtimeOwnerId,
      revision,
      operationId,
      retained,
    );
  }

  async completeSessionDeletion(sessionID: SessionId): Promise<void> {
    this.throwBeforeWrite();
    sessionDeletionRepository.completeSessionDeletion(this.db, sessionID);
  }

  async registerSessionRuntime(sessionID: SessionId): Promise<void> {
    this.throwBeforeWrite();
    sessionDeletionRepository.registerSessionRuntime(this.db, this.runtimeOwnerId, sessionID);
  }

  async unregisterSessionRuntime(sessionID: SessionId): Promise<void> {
    this.throwBeforeWrite();
    sessionDeletionRepository.unregisterSessionRuntime(this.db, this.runtimeOwnerId, sessionID);
  }

  /** 连接关闭时清掉本 owner 的运行态行，不留“永远活着”的残留。 */
  clearRuntimePresence(): void {
    sessionDeletionRepository.clearSessionRuntimePresence(this.db, this.runtimeOwnerId);
  }

  async listSessions(input: ListSessionsInput = {}): Promise<SessionInfo[]> {
    return sessionRepository.listSessions(this.db, input);
  }

  async claimLegacySessionWorkspace(input: ClaimLegacySessionWorkspaceInput): Promise<number> {
    this.throwBeforeWrite();
    return sessionRepository.claimLegacySessionWorkspace(this.db, input);
  }

  async repairLegacyRemoteSessionWorkspace(
    input: RepairLegacyRemoteSessionWorkspaceInput,
  ): Promise<boolean> {
    this.throwBeforeWrite();
    return sessionRepository.repairLegacyRemoteSessionWorkspace(this.db, input);
  }

  async repairRemoteSessionPaths(input: RepairRemoteSessionPathsInput): Promise<boolean> {
    this.throwBeforeWrite();
    return sessionRepository.repairRemoteSessionPaths(this.db, input);
  }

  async saveMessage(
    input: MessageInfo,
    copyFrom?: Parameters<SessionStorePort["saveMessage"]>[1],
  ): Promise<void> {
    this.throwBeforeWrite();
    return messageRepository.saveMessage(this.db, input, copyFrom);
  }

  async removeMessage(input: { sessionID: SessionId; messageID: MessageId }): Promise<void> {
    this.throwBeforeWrite();
    return messageRepository.removeMessage(this.db, input);
  }

  async savePart(
    input: MessagePart,
    copyFrom?: Parameters<SessionStorePort["savePart"]>[1],
  ): Promise<void> {
    this.throwBeforeWrite();
    return messageRepository.savePart(this.db, input, copyFrom);
  }

  async removePart(input: {
    sessionID: SessionId;
    messageID: MessageId;
    partID: PartId;
  }): Promise<void> {
    this.throwBeforeWrite();
    return messageRepository.removePart(this.db, input);
  }

  async messageWithParts(input: {
    sessionID: SessionId;
    messageID: MessageId;
  }): Promise<MessageWithParts | null> {
    return messageRepository.messageWithParts(this.db, input);
  }

  async messages(input: { sessionID: SessionId }): Promise<MessageWithParts[]> {
    return messageRepository.messages(this.db, input);
  }

  async saveSessionEntry(input: SessionEntryInfo): Promise<void> {
    this.throwBeforeWrite();
    return sessionEntryRepository.saveSessionEntry(this.db, input);
  }

  async sessionEntries(input: {
    sessionID: SessionId;
    type?: SessionEntryType | string;
  }): Promise<SessionEntryInfo[]> {
    return sessionEntryRepository.sessionEntries(this.db, input);
  }

  async saveSessionInput(input: {
    id: string;
    sessionID: SessionId;
    kind: string;
    delivery: SessionInputDelivery;
    payload: { text: string; [key: string]: unknown };
  }): Promise<void> {
    this.throwBeforeWrite();
    return sessionInputRepository.saveSessionInput(this.db, input);
  }

  async commitPermissionFullAccess(
    input: Parameters<NonNullable<SessionStorePort["commitPermissionFullAccess"]>>[0],
  ): Promise<void> {
    this.throwBeforeWrite();
    return permissionFullAccessRepository.commitPermissionFullAccess(this.db, input);
  }

  async updateSessionInputs(
    input: Parameters<NonNullable<SessionStorePort["updateSessionInputs"]>>[0],
  ): Promise<void> {
    this.throwBeforeWrite();
    return sessionInputRepository.updateSessionInputs(this.db, input);
  }

  async promoteSessionInput(input: {
    id: string;
    sessionID: SessionId;
    message: MessageInfo;
    parts: MessagePart[];
  }): Promise<void> {
    this.throwBeforeWrite();
    return sessionInputRepository.promoteSessionInput(this.db, input);
  }

  async markSessionInputPromoted(input: {
    id: string;
    sessionID: SessionId;
    promotedMessageID: MessageId;
  }): Promise<void> {
    this.throwBeforeWrite();
    return sessionInputRepository.markSessionInputPromoted(this.db, input);
  }

  async settleSessionInput(input: {
    id: string;
    sessionID: SessionId;
    status: "cancelled" | "discarded" | "failed";
    reason?: string;
  }): Promise<void> {
    this.throwBeforeWrite();
    return sessionInputRepository.settleSessionInput(this.db, input);
  }

  async listSessionInputs(input: {
    sessionID: SessionId;
    status?: SessionInputStatus;
  }): Promise<SessionInputRecord[]> {
    return sessionInputRepository.listSessionInputs(this.db, input);
  }

  async getSessionInputById(id: string): Promise<SessionInputRecord | null> {
    return sessionInputRepository.getSessionInputById(this.db, id);
  }

  async readTodos(input: { sessionID: SessionId }): Promise<TodoItem[]> {
    return todoRepository.readTodos(this.db, input);
  }

  async updateTodos(input: { sessionID: SessionId; todos: TodoItem[] }): Promise<void> {
    this.throwBeforeWrite();
    return todoRepository.updateTodos(this.db, input);
  }

  async setRevert(input: {
    sessionID: SessionId;
    revert: SessionRevert;
    summary?: { additions: number; deletions: number; files: number; diffs?: FileDiff[] };
  }): Promise<void> {
    return sessionRepository.setRevert(this.db, input);
  }

  async clearRevert(sessionID: SessionId): Promise<void> {
    return sessionRepository.clearRevert(this.db, sessionID);
  }
}
