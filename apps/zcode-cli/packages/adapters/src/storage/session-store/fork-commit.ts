import type { DatabaseSync } from "node:sqlite";
import type {
  CreateSessionInput,
  ForkChildSessionMetadata,
  ForkCommitBundle,
  SessionEntryInfo,
  SessionId,
  SessionInfo,
  SharedContextImportCommitBundle,
} from "@zcode/contracts";
import type { ForkCommitFaultStage } from "./options.js";
import { cloneSessionTargetForFork } from "../session-target.js";
import * as messageRepository from "./repositories/messages.js";
import * as sessionEntryRepository from "./repositories/session-entries.js";
import * as sessionInputRepository from "./repositories/session-inputs.js";
import * as sessionRepository from "./repositories/sessions.js";

function forkChildSessionId(entry: SessionEntryInfo): SessionId | null {
  if (!entry.data || typeof entry.data !== "object" || Array.isArray(entry.data)) return null;
  const ack = (entry.data as Record<string, unknown>).ack;
  if (!ack || typeof ack !== "object" || Array.isArray(ack)) return null;
  const result = (ack as Record<string, unknown>).result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const sessionId = (result as Record<string, unknown>).sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 ? (sessionId as SessionId) : null;
}

function assertForkBundleChildLocal(bundle: ForkCommitBundle): void {
  const childId = String(bundle.child.id);
  const commandResult = bundle.commandFact.ack.result as unknown;
  const result =
    commandResult && typeof commandResult === "object" && !Array.isArray(commandResult)
      ? (commandResult as Record<string, unknown>)
      : null;
  const sessionId = typeof result?.sessionId === "string" ? result.sessionId.trim() : "";
  const isForkResult =
    result?.type === "forkAssistant" ||
    result?.type === "createSelectionSideSession" ||
    (result?.type === "editUserQuery" && result.disposition === "fork");
  if (!isForkResult || !sessionId || sessionId !== childId) {
    // 缺失或非 fork 的 command result 会留下无法重放到 child 的幂等事实。
    throw new Error("Fork bundle command result is missing, invalid, or not child-local");
  }
  const messageIds = new Set(bundle.messages.map((message) => String(message.info.id)));
  const assertMessage = (value: unknown, field: string) => {
    if (typeof value === "string" && !messageIds.has(value)) {
      throw new Error(`Fork bundle ${field} is not child-local: ${value}`);
    }
  };
  const targetIds = new Set<string>();
  if (bundle.goal) targetIds.add(bundle.goal.source.targetID);
  for (const message of bundle.messages) {
    if (String(message.info.sessionID) !== childId) {
      throw new Error("Fork bundle message session is not child-local");
    }
    if (message.info.role === "assistant" && !messageIds.has(String(message.info.parentID))) {
      throw new Error("Fork bundle assistant parent is not child-local");
    }
    const anchor = message.info.anchor;
    for (const id of anchor?.orderedMessageIds ?? []) {
      assertMessage(id, "anchor orderedMessageId");
    }
    assertMessage(anchor?.boundaryMessageId, "anchor boundaryMessageId");
    if (anchor?.goalBoundary?.kind === "snapshot") {
      if (String(anchor.goalBoundary.target.sessionID) !== childId) {
        throw new Error("Fork bundle anchor goal session is not child-local");
      }
      targetIds.add(anchor.goalBoundary.target.targetID);
    }
    for (const part of message.parts) {
      if (
        String(part.sessionID) !== childId ||
        String(part.messageID) !== String(message.info.id)
      ) {
        throw new Error("Fork bundle part owner is not child-local");
      }
      if (part.type === "timeline") {
        assertMessage(part.anchorMessageId, "timeline anchorMessageId");
        if (part.timelineType === "context_compaction") {
          assertMessage(part.summaryMessageId, "timeline summaryMessageId");
        }
        if (part.timelineType === "goal_verification") targetIds.add(part.targetId);
      }
      if (part.type === "compaction") {
        assertMessage(part.tail_start_id, "compaction tail_start_id");
        assertMessage(part.summaryMessageId, "compaction summaryMessageId");
        const boundary = part.compactBoundary;
        assertMessage(boundary?.lastSummarizedMessageId, "compact lastSummarizedMessageId");
        for (const id of boundary?.summaryMessageIds ?? []) {
          assertMessage(id, "compact summaryMessageId");
        }
        for (const id of boundary?.attachmentMessageIds ?? []) {
          assertMessage(id, "compact attachmentMessageId");
        }
        for (const id of boundary?.hookResultMessageIds ?? []) {
          assertMessage(id, "compact hookResultMessageId");
        }
        assertMessage(boundary?.preservedSegment?.headMessageId, "compact preserved head");
        assertMessage(boundary?.preservedSegment?.anchorMessageId, "compact preserved anchor");
        assertMessage(boundary?.preservedSegment?.tailMessageId, "compact preserved tail");
      }
      if (part.type === "tool" && part.state.status === "completed") {
        for (const attachment of part.state.attachments ?? []) {
          if (
            String(attachment.sessionID) !== childId ||
            String(attachment.messageID) !== String(message.info.id)
          ) {
            throw new Error("Fork bundle tool attachment owner is not child-local");
          }
        }
      }
    }
  }
  if (bundle.goal && String(bundle.goal.source.sessionID) !== childId) {
    throw new Error("Fork bundle goal session is not child-local");
  }
  for (const entry of bundle.entries) {
    if (String(entry.sessionID) !== childId) {
      throw new Error("Fork bundle verifier entry session is not child-local");
    }
    const data =
      entry.data && typeof entry.data === "object" && !Array.isArray(entry.data)
        ? (entry.data as Record<string, unknown>)
        : {};
    const payload =
      data.payload && typeof data.payload === "object" && !Array.isArray(data.payload)
        ? (data.payload as Record<string, unknown>)
        : {};
    assertMessage(payload.anchorAssistantMessageId, "verifier assistant anchor");
    if (typeof payload.targetId === "string" && !targetIds.has(payload.targetId)) {
      throw new Error("Fork bundle verifier target is not child-local");
    }
  }
}

export function validateForkChildMetadata(
  input: CreateSessionInput,
  metadata: ForkChildSessionMetadata,
): { entryId: string; parentID: SessionId } {
  if (!input.parentID || String(input.parentID) !== metadata.parentSessionId) {
    throw new Error("Fork child metadata parent does not match session parentID");
  }
  const orderedMessageIds = metadata.forkTarget.orderedMessageIds;
  // compact 覆盖首轮 query 时，input 前稳定前缀合法为空；boundaryMessageId 仍记录
  // 被编辑 input，供幂等事实定位，但不会被复制进 child。
  const validBoundary =
    metadata.forkTarget.boundaryMessageId.trim().length > 0 &&
    (orderedMessageIds.length === 0 ||
      orderedMessageIds.at(-1) === metadata.forkTarget.boundaryMessageId);
  if (!metadata.sourceCommandId.trim() || !validBoundary) {
    throw new Error("Fork child metadata is invalid");
  }

  // command key 是 (parentSessionId, sourceCommandId)；session_entry.id 是全库主键，
  // 必须把 parent 纳入 id，避免两个 session 恰好复用 commandId 时互相覆盖事实。
  return {
    entryId: `v4_command_fact:child:${metadata.parentSessionId}:${metadata.sourceCommandId}`,
    parentID: input.parentID,
  };
}

export function createForkedSessionWithMetadata(
  db: DatabaseSync,
  input: CreateSessionInput,
  metadata: ForkChildSessionMetadata,
  entryId: string,
  parentID: SessionId,
): SessionInfo {
  const existing = sessionEntryRepository
    .sessionEntries(db, {
      sessionID: parentID,
      type: "v4/command_fact",
    })
    .find((entry) => entry.id === entryId);
  if (existing) {
    const childSessionId = forkChildSessionId(existing);
    if (!childSessionId) {
      throw new Error(`Fork child command fact is corrupt: ${entryId}`);
    }
    const child = sessionRepository.getSession(db, childSessionId);
    if (!child) {
      throw new Error(`Fork child session is missing: ${childSessionId}`);
    }
    return child;
  }

  const child = sessionRepository.createSession(db, input);
  const now = Date.now();
  sessionEntryRepository.saveSessionEntry(db, {
    id: entryId,
    sessionID: parentID,
    type: "v4/command_fact",
    time: { created: now, updated: now },
    data: {
      source: "child",
      ack: {
        commandId: metadata.sourceCommandId,
        status: "accepted",
        revisionAtDecision: 0,
        result: { type: "forkAssistant", sessionId: String(child.id) },
      },
      metadata,
    },
  });
  return child;
}

export function validateForkBundle(bundle: ForkCommitBundle): {
  entryId: string;
  parentID: SessionId;
} {
  const { child, commandFact, initialInput } = bundle;
  if (
    !child.parentID ||
    String(child.parentID) !== commandFact.parentSessionId ||
    (initialInput && String(initialInput.sessionID) !== String(child.id)) ||
    commandFact.ack.commandId !== commandFact.sourceCommandId
  ) {
    throw new Error("Fork commit bundle identity is invalid");
  }
  return {
    entryId: `v4_command_fact:child:${commandFact.parentSessionId}:${commandFact.sourceCommandId}`,
    parentID: child.parentID,
  };
}

export async function commitForkBundle(
  db: DatabaseSync,
  bundle: ForkCommitBundle,
  entryId: string,
  parentID: SessionId,
  maybeThrowFault: (stage: ForkCommitFaultStage) => void,
): Promise<SessionInfo> {
  const { child, commandFact, initialInput } = bundle;
  const existing = sessionEntryRepository
    .sessionEntries(db, {
      sessionID: parentID,
      type: "v4/command_fact",
    })
    .find((entry) => entry.id === entryId);
  if (existing) {
    const existingChildId = forkChildSessionId(existing);
    const existingChild = existingChildId
      ? sessionRepository.getSession(db, existingChildId)
      : null;
    if (!existingChild) throw new Error(`Fork bundle command fact is corrupt: ${entryId}`);
    return existingChild;
  }

  assertForkBundleChildLocal(bundle);
  const persistedChild = sessionRepository.createSession(db, child);
  maybeThrowFault("afterChild");
  for (const message of bundle.messages) {
    const messageSource = bundle.copySources?.messages[message.info.id];
    await messageRepository.saveMessage(
      db,
      message.info,
      messageSource ? { sessionID: parentID, id: messageSource } : undefined,
    );
    for (const part of message.parts) {
      const partSource = bundle.copySources?.parts[part.id];
      await messageRepository.savePart(
        db,
        part,
        partSource ? { sessionID: parentID, id: partSource } : undefined,
      );
    }
  }
  maybeThrowFault("afterMessages");
  if (bundle.goal) {
    cloneSessionTargetForFork(db, {
      source: bundle.goal.source,
      sessionID: child.id,
      status: bundle.goal.status,
    });
  }
  maybeThrowFault("afterGoal");
  for (const entry of bundle.entries) {
    sessionEntryRepository.saveSessionEntry(db, entry);
  }
  maybeThrowFault("afterEntries");
  if (initialInput) {
    await sessionInputRepository.saveSessionInput(db, initialInput);
  }
  maybeThrowFault("afterInput");
  const now = Date.now();
  sessionEntryRepository.saveSessionEntry(db, {
    id: entryId,
    sessionID: parentID,
    type: "v4/command_fact",
    time: { created: now, updated: now },
    data: {
      source: "child",
      ack: commandFact.ack,
      metadata: commandFact.metadata,
    },
  });
  maybeThrowFault("afterCommandFact");
  maybeThrowFault("beforeCommit");
  return persistedChild;
}

export function validateSharedContextImportBundle(bundle: SharedContextImportCommitBundle): void {
  const { session, contextMessage, provenance } = bundle;
  if (
    String(contextMessage.info.sessionID) !== String(session.id) ||
    String(provenance.sessionID) !== String(session.id) ||
    // session_entry.id 是全库主键，saveSessionEntry 的 on conflict(id)
    // 会把 session_id 改绑到后写入者。provenance id 若不含 session 命名空间，同一个
    // share 导入到第二个会话时会夺走第一个会话的条目（旧会话 transcript 静默丢失）。
    // 这里在唯一写入口做守卫，覆盖所有调用方，而不是只修某一个构造点。
    !provenance.id.includes(String(session.id)) ||
    contextMessage.info.role !== "user" ||
    contextMessage.info.visibility !== "model-only" ||
    contextMessage.info.source !== "shared_context"
  ) {
    throw new Error("Shared context import bundle identity is invalid");
  }
}

export async function commitSharedContextImportBundle(
  db: DatabaseSync,
  bundle: SharedContextImportCommitBundle,
): Promise<SessionInfo> {
  const { session, contextMessage, provenance } = bundle;
  const existing = sessionRepository.getSession(db, session.id);
  if (existing) {
    const entry = sessionEntryRepository
      .sessionEntries(db, { sessionID: session.id, type: provenance.type })
      .find((candidate) => candidate.id === provenance.id);
    if (!entry) throw new Error("Shared context import session is incomplete");
    return existing;
  }
  const persisted = sessionRepository.createSession(db, session);
  await messageRepository.saveMessage(db, contextMessage.info);
  for (const part of contextMessage.parts) {
    await messageRepository.savePart(db, part);
  }
  sessionEntryRepository.saveSessionEntry(db, provenance);
  return persisted;
}
