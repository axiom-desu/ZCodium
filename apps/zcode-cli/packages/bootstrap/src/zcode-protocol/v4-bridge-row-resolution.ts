import { isConversationRealUserTurnStarter } from "@zcode/shared";
import type { V4CommandCoreHost } from "../zcode-protocol-v4/commands/types.js";
import { resolveStableForkTargetFromTranscript } from "../zcode-protocol-v4/stable-fork-target.js";
import { persistAssistantFeedback } from "../zcode-protocol-v4/assistant-feedback-persistence.js";
import type { SessionId } from "@zcode/contracts";
import type { V4BridgeBasePorts } from "./v4-bridge-shared.js";

export function createCommandEntryRowResolution(
  ports: V4BridgeBasePorts,
): Pick<
  V4CommandCoreHost,
  | "resolveRowActionTarget"
  | "getMessageIdsForTurnRow"
  | "isLatestAssistantSegmentRow"
  | "resolveStableForkTarget"
  | "isLatestRetryAssistantRow"
  | "isLatestEditableUserRow"
  | "getTurnIdForRow"
  | "hasUsableRuntimeModelTarget"
  | "getTurnRewindAnchor"
  | "resolveUserMessageIdForRow"
  | "resolveTurnUserPrompt"
  | "setAssistantFeedback"
> {
  const context = ports.context;
  return {
    resolveRowActionTarget: (sessionId, target, action) =>
      context.v4Gateway?.resolveRowActionTarget(sessionId, target, action) ?? null,
    getMessageIdsForTurnRow: (sessionId, rowId) =>
      context.v4Gateway?.getMessageIdsForTurnRow(sessionId, rowId) ?? [],
    isLatestAssistantSegmentRow: (sessionId, rowId) =>
      context.v4Gateway?.isLatestAssistantSegmentRow(sessionId, rowId) ?? null,
    resolveStableForkTarget: async (sessionId, rowId) => {
      const candidate = context.v4Gateway?.resolveStableForkCandidate(sessionId, rowId) ?? null;
      if (!candidate) return { ok: false, reasonCode: "guard.forkTargetAmbiguous" };
      if (!candidate.ok) return candidate;
      const store = context.deps.sessionStore;
      if (!store) return { ok: false, reasonCode: "guard.forkTargetAmbiguous" };
      const messages = await store.messages({ sessionID: sessionId as SessionId });
      return await resolveStableForkTargetFromTranscript({
        candidate: candidate.candidate,
        messages,
        store,
      });
    },
    isLatestRetryAssistantRow: (sessionId, rowId) =>
      context.v4Gateway?.isLatestRetryAssistantRow(sessionId, rowId) ?? null,
    isLatestEditableUserRow: (sessionId, rowId) =>
      context.v4Gateway?.isLatestEditableUserRow(sessionId, rowId) ?? null,
    getTurnIdForRow: (sessionId, rowId) =>
      context.v4Gateway?.getTurnIdForRow(sessionId, rowId) ?? null,
    // restoreWarning 时序自愈探针：App 的模型视图直接来自进程 Registry。
    hasUsableRuntimeModelTarget: (record) => record.app.listModels().length > 0,
    getTurnRewindAnchor: (sessionId, rowId) =>
      context.v4Gateway?.getTurnRewindAnchor(sessionId, rowId) ?? null,
    resolveUserMessageIdForRow: async (sessionId, rowId) => {
      const turnId = context.v4Gateway?.getTurnIdForRow(sessionId, rowId) ?? null;
      const sessionStore = context.deps.sessionStore;
      if (!turnId || !sessionStore) return null;
      const messages = await sessionStore.messages({
        sessionID: sessionId as SessionId,
      });
      const user = messages
        .filter(
          (message) =>
            message.info.role === "user" &&
            String(message.info.anchor?.turnId ?? "") === turnId &&
            isConversationRealUserTurnStarter(message),
        )
        .at(-1);
      return user ? String(user.info.id) : null;
    },
    // retryTurn 原 prompt 解析：assistant messageId → parentID（user 消息）→ 文本。
    // 数据源 = core sessionStore（transcript 权威）；实现放 binder 只因 deps 注入点
    // 在宿主（随 host 原生持有）。找不到返回 null → handler 只截断不重发。
    resolveTurnUserPrompt: async (sessionId, assistantMessageId) => {
      const sessionStore = context.deps.sessionStore;
      if (!sessionStore) return null;
      const messages = await sessionStore.messages({
        sessionID: sessionId as SessionId,
      });
      const assistantInfo = messages.find(
        (message) => message.info.id === assistantMessageId,
      )?.info;
      if (assistantInfo?.role !== "assistant") return null;
      const user = messages.find((message) => message.info.id === assistantInfo.parentID);
      if (!user || user.info.role !== "user") return null;
      const text = user.parts
        .filter(
          (part): part is Extract<(typeof user.parts)[number], { type: "text" }> =>
            part.type === "text" && part.ignored !== true,
        )
        .map((part) => part.text)
        .join("");
      return text.length > 0 ? text : null;
    },
    setAssistantFeedback: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      const sessionStore = context.deps.sessionStore;
      if (!record || !sessionStore) throw new Error("proto.sessionNotFound");
      // 原因：反馈必须先落 transcript，CLI 重启后才能从 cold hydration 恢复；
      // eventStore/投影随后推进，失败重试仍可从同一持久事实幂等补齐。
      await persistAssistantFeedback({
        sessionStore,
        eventStore: record.eventStore,
        sessionId,
        messageId: input.messageId,
        entityId: input.entityId,
        feedback: input.feedback,
        traceId: String(record.traceContext.traceId),
        onPersistedEvent: (persisted) => context.v4Gateway?.ingest(sessionId, persisted),
        onLiveProjectionError: (error) =>
          context.logger?.warn("v4 assistant feedback live projection failed", {
            error: error instanceof Error ? error.message : String(error),
            sessionId,
          }),
      });
    },
    // ── 过渡钩子──────────────────────────────
  };
}
