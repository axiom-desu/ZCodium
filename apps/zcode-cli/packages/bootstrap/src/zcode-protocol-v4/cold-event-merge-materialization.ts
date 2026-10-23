import {
  selectActiveConversationBranch,
  type MessageWithParts,
  type SessionEntryInfo,
  type SessionEvent,
  type SessionGoal,
} from "@zcode/contracts";
import {
  restoreSharedContextImportState,
  type ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import {
  goalVerificationEntriesFromSessionEntries,
  type HydratedGoalVerificationEntry,
} from "./transcript-hydration.js";

interface ConversationMaterializationSource {
  goalVerificationEntries: HydratedGoalVerificationEntry[];
  memoryEvents: SessionEvent[];
  messages: MessageWithParts[];
  /** shared_context 正文仍是 provider-only；这里只下发脱敏的 handover metadata。 */
  sharedContextImport?: ConversationSnapshot["sharedContextImport"];
  /** 只有成功读取 session_target 后才存在；显式 null 也是持久 authority。 */
  target?: SessionGoal | null;
}

interface PersistedConversationMaterializationStore {
  getSession(sessionId: import("@zcode/contracts").SessionId): Promise<{
    title?: string;
    revert?: {
      branchCutAfterMessageID?: import("@zcode/contracts").MessageId;
      branchGeneration?: number;
      createdMessageID?: import("@zcode/contracts").MessageId;
      keptMessageIDs?: import("@zcode/contracts").MessageId[];
      targetMessageID?: import("@zcode/contracts").MessageId;
    };
  } | null>;
  messages(input: { sessionID: import("@zcode/contracts").SessionId }): Promise<MessageWithParts[]>;
  readTarget(input: {
    sessionID: import("@zcode/contracts").SessionId;
  }): Promise<SessionGoal | null>;
  sessionEntries?(input: {
    sessionID: import("@zcode/contracts").SessionId;
    type?: string;
  }): Promise<SessionEntryInfo[]>;
}

/**
 * cold materialization 的单一持久事实入口。
 *
 * 旧 bridge 只读取全量 message/part，既没有读取 session.revert 来裁掉
 * 已回滚分支，也没有读取 session_target；结果 runtime resume / stable fork 已经使用
 * active branch，而刷新 projection 却会复活旧分支并把 goal 恢复成 null。
 */
export async function loadPersistedConversationMaterialization(input: {
  memoryEvents: readonly SessionEvent[];
  persistedMessages?: MessageWithParts[];
  sessionId: string;
  store?: PersistedConversationMaterializationStore;
}): Promise<ConversationMaterializationSource> {
  if (!input.store) {
    // 无 sessionStore 时旧 bridge 人工填 target:null，把“没有读取”误当成
    // “持久层明确清空”，进而压掉唯一的内存 TargetChanged 并强制 synthesized。
    return {
      goalVerificationEntries: [],
      memoryEvents: [...input.memoryEvents],
      messages: [],
    };
  }
  const sessionID = input.sessionId as import("@zcode/contracts").SessionId;
  const [session, allMessages, target, entries] = await Promise.all([
    input.store.getSession(sessionID),
    input.persistedMessages ?? input.store.messages({ sessionID }),
    input.store.readTarget({ sessionID }),
    input.store.sessionEntries ? input.store.sessionEntries({ sessionID }) : Promise.resolve([]),
  ]);
  const messages = selectActiveConversationBranch(allMessages, {
    branchCutAfterMessageId: session?.revert?.branchCutAfterMessageID,
    rewindCreatedMessageId: session?.revert?.createdMessageID,
    rewindKeptMessageIds: session?.revert?.keptMessageIDs,
    rewindTargetMessageId: session?.revert?.targetMessageID,
  });
  const sharedContextMessage = messages.find(
    (message) =>
      message.info.role === "user" &&
      message.info.source === "shared_context" &&
      message.info.semantics?.origin === "import" &&
      message.info.semantics?.kind === "shared_context",
  );
  const sharedContextEntry = entries.find((entry) => entry.type === "v4/shared_context_import");
  const sharedContextData =
    sharedContextEntry?.data && typeof sharedContextEntry.data === "object"
      ? (sharedContextEntry.data as Record<string, unknown>)
      : undefined;
  const sharedContextImport = sharedContextMessage
    ? restoreSharedContextImportState(session?.title, sharedContextData)
    : undefined;
  return {
    goalVerificationEntries: goalVerificationEntriesFromSessionEntries(entries),
    memoryEvents: [...input.memoryEvents],
    messages,
    ...(sharedContextImport ? { sharedContextImport } : {}),
    target,
  };
}
