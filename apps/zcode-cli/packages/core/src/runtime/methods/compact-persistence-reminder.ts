import { createModelId, createModelProviderId } from "@zcode/contracts";
import { createMessageId, createPartId, traceContextToLogContext } from "../deps.js";
import type { MessageId, Model, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  isRuntimeAttachmentEntry,
  type RuntimeMessageEntry,
  type RuntimeMessageMetadata,
} from "../../agent/message-history.js";

/**
 * Compact reminder 消息的持久化与失败回滚投影。
 *
 * 只使用 receiver 上既有的 persistMessage/persistPart/sessionStore 接口，不新增状态；
 * compact 事务（何时写、何时回滚、什么算成功）仍由 `compact-persistence.ts` 决定。
 */
export async function persistCompactReminderMessage(
  this: AgentRuntimeInternal,
  entry: RuntimeMessageEntry,
  created: number,
  traceContext: TraceContext,
  model?: Model,
): Promise<MessageId | undefined> {
  if (!this.sessionStore || !isRuntimeAttachmentEntry(entry)) return;

  const messageID = createMessageId();
  const currentModel = resolvePersistedModel(this, model);
  try {
    await this.persistMessage(
      {
        id: messageID,
        sessionID: this.sessionId,
        role: "user",
        time: {
          created,
        },
        agent: this.config.agentName ?? "zcode-agent",
        metadata: compactReminderPartMetadata(entry.metadata),
        modelSelection: currentModel,
        semantics: {
          origin: "agent_runtime",
          kind: "system_reminder",
          source: String(entry.metadata.source ?? "compact_reminder"),
          uiVisibility: "hidden",
          providerVisibility: "visible",
          transcriptVisibility: "hidden",
        },
        system: this.config.systemPrompt,
        synthetic: true,
        tools: Object.fromEntries(this.getTools().map((tool) => [tool.name, true])),
        visibility: "model-only",
      },
      traceContext,
    );
    await this.persistPart(
      {
        id: createPartId(),
        sessionID: this.sessionId,
        messageID,
        type: "text",
        text: entry.content,
        synthetic: true,
        time: {
          start: created,
          end: created,
        },
        metadata: compactReminderPartMetadata(entry.metadata),
      },
      traceContext,
    );
    return messageID;
  } catch (error) {
    await removeCompactPersistenceMessagesBestEffort.call(this, [messageID], traceContext);
    throw error;
  }
}

export function resolvePersistedModel(runtime: AgentRuntimeInternal, model?: Model) {
  if (model) return { providerId: model.providerId, modelId: model.modelId };
  const selection = runtime.getSessionModelSelection();
  return selection
    ? {
        providerId: createModelProviderId(selection.providerId),
        modelId: createModelId(selection.modelId),
      }
    : undefined;
}

export async function removeCompactPersistenceMessagesBestEffort(
  this: AgentRuntimeInternal,
  messageIds: readonly MessageId[],
  traceContext: TraceContext,
): Promise<void> {
  if (!this.sessionStore) return;

  for (const rollbackMessageId of new Set(messageIds)) {
    try {
      await this.sessionStore.removeMessage({
        sessionID: this.sessionId,
        messageID: rollbackMessageId,
      });
    } catch (cleanupError) {
      this.logger?.warn("Compact persistence cleanup failed", {
        ...traceContextToLogContext(traceContext),
        errorMessage: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        event: "compact.persistence.cleanup_failed",
        messageId: rollbackMessageId,
        module: "core.runtime",
      });
    }
  }
}

function compactReminderPartMetadata(
  runtimeMessage: RuntimeMessageMetadata,
): Record<string, unknown> {
  return {
    runtimeMessage,
    source: runtimeMessage.source,
    visibility: "model-only",
  };
}
