import { ModelCallWrapperSchema } from "@zcode/contracts";
import { hydrateCompactDiscovery, hydrateToolSearchContent } from "./tool-search-hydration.js";
import { runtimeInputMetadata } from "./runtime-input-presentation.js";
// ============================================================
// Session History Hydration - rebuild provider-visible context
// ============================================================

import { selectActiveConversationBranch } from "@zcode/contracts";
import type {
  MessagePart,
  MessageWithParts,
  MessageId,
  ToolArtifactStorePort,
  ToolPart,
} from "@zcode/contracts";
import { persistedTokenUsageBaseline } from "./message-history-usage.js";
import { type MessageHistory, type ToolCallInput } from "./message-history.js";
import {
  assistantReasoningFromParts,
  assistantTextFromParts,
  isToolPart,
  providerToolNameFromPart,
  syntheticSystemReminderAttachmentFromParts,
} from "./session-history-metadata.js";
import { compactActiveSessionMessages, isActiveCompactionBoundaryPart } from "./compact-session.js";
import { userEntriesFromParts } from "./session-history-user-entries.js";
import { filePartToContentBlock, projectPersistedToolMediaContent } from "./file-part-hydration.js";
import { selectToolPartsForHistory } from "./tool-part-order.js";

const INTERRUPTED_TOOL_RESULT = "[Tool execution was interrupted before resume]";

export interface SessionHistoryHydrationResult {
  appliedMessageCount: number;
  interruptedToolCount: number;
  messageCount: number;
  partCount: number;
}

export async function hydrateMessageHistoryFromSession(input: {
  artifactStore?: ToolArtifactStorePort;
  branchCutAfterMessageId?: MessageId;
  history: MessageHistory;
  messages: MessageWithParts[];
  rewindCreatedMessageId?: MessageId;
  rewindKeptMessageIds?: readonly MessageId[];
  rewindTargetMessageId?: MessageId;
}): Promise<SessionHistoryHydrationResult> {
  const activeMessages = activeSessionMessages(input.messages, {
    branchCutAfterMessageId: input.branchCutAfterMessageId,
    rewindCreatedMessageId: input.rewindCreatedMessageId,
    rewindKeptMessageIds: input.rewindKeptMessageIds,
    rewindTargetMessageId: input.rewindTargetMessageId,
  });
  let appliedMessageCount = 0,
    interruptedToolCount = 0,
    partCount = 0;

  for (const message of activeMessages) {
    const parts = dedupeParts(message.parts);
    partCount += parts.length;

    if (message.info.role === "user") {
      const sharedContextStatus =
        message.info.source === "shared_context" &&
        message.info.metadata &&
        typeof message.info.metadata === "object"
          ? (message.info.metadata as Record<string, unknown>).sharedContextStatus
          : undefined;
      if (
        message.info.source === "shared_context" &&
        sharedContextStatus !== undefined &&
        sharedContextStatus !== "attached"
      ) {
        // Share handover 的 pending/reserved context 只是本地候选，不能在用户首次
        // 发送前偷偷进入 provider history；attach 后由 runtime 显式注入一次。
        continue;
      }
      // session 持久化的是 raw synthetic notice，hydrate 阶段若提前包成
      // user <system-reminder>，后续 mid-conversation system projection 会失去 attachment source。
      const syntheticAttachment = syntheticSystemReminderAttachmentFromParts(parts);
      if (syntheticAttachment) {
        // 保留 part 上的完整 metadata（含 inputPresentation）；只留 source 会在恢复后丢掉
        // 附件来源，mid-conversation system projection 也跟着失效。
        input.history.addEntries([
          {
            kind: "attachment",
            content: syntheticAttachment.content,
            metadata: syntheticAttachment.metadata,
          },
        ]);
        appliedMessageCount++;
        continue;
      }

      const entries = await userEntriesFromParts(parts, input.artifactStore);
      if (entries.length === 0) continue;
      // 有效 compact 边界携带的发现检查点挂在 summary entry 上；Local 在两次 compact
      // 之间据此提升目标 schema，不能只留在 compaction part 里。
      const boundaryPart = parts.find(isActiveCompactionBoundaryPart);
      const compactBoundary =
        boundaryPart?.type === "compaction"
          ? hydrateCompactDiscovery(boundaryPart.compactBoundary)
          : undefined;
      if (compactBoundary && entries[0]) {
        entries[0] = {
          ...entries[0],
          metadata: {
            ...(entries[0].metadata ?? { source: "legacy_synthetic" as const }),
            compactBoundary,
          },
        };
      }
      const presentation = runtimeInputMetadata(
        (message.info.metadata as Record<string, unknown> | undefined)?.inputPresentation,
      );
      input.history.addEntries(
        presentation
          ? entries.map((entry) =>
              entry.kind === "attachment"
                ? entry
                : { ...entry, metadata: { ...entry.metadata, ...presentation } },
            )
          : entries,
      );
      appliedMessageCount++;
      continue;
    }

    const text = assistantTextFromParts(parts);
    const reasoning = assistantReasoningFromParts(parts);
    const toolParts = selectToolPartsForHistory(parts.filter(isToolPart));
    // live history 会保留带合法 provider usage 的空 assistant 作为估算锚点，
    // 旧 hydration 却无条件丢弃它，导致重启前后的 context estimate 不一致。
    if (
      text.trim().length === 0 &&
      reasoning.length === 0 &&
      toolParts.length === 0 &&
      !persistedTokenUsageBaseline(message.info.tokens)
    ) {
      continue;
    }

    input.history.addAssistant(
      text,
      toolParts.map(
        (part): ToolCallInput => ({
          id: part.callID,
          input: part.state.input,
          modelCallWrapper: modelCallWrapperFromPart(part),
          name: providerToolNameFromPart(part),
        }),
      ),
      reasoning,
      message.info.modelId && message.info.providerId
        ? { modelId: message.info.modelId, providerId: message.info.providerId }
        : undefined,
      message.info.tokens,
    );
    appliedMessageCount++;

    for (const part of toolParts) {
      const providerToolName = providerToolNameFromPart(part);
      const modelCallWrapper = modelCallWrapperFromPart(part);
      if (part.state.status === "completed") {
        // live tool result 使用结构化媒体，但旧恢复只读取 output 摘要，
        // 导致模型切换或冷恢复后丢失 Read/MCP 产生的真实媒体。
        const attachmentBlocks = part.state.attachments
          ? await Promise.all(
              part.state.attachments.map((attachment) =>
                filePartToContentBlock(attachment, input.artifactStore),
              ),
            )
          : [];
        // 旧 completed part 也可能有 attachments；只有完整有效的 layout 才能证明
        // 它们属于新的 provider-visible 媒体内容，缺失或损坏时必须保留 legacy output。
        const projectedMediaContent =
          attachmentBlocks.length > 0
            ? projectPersistedToolMediaContent(
                part.state.metadata?.modelContentLayout,
                attachmentBlocks,
              )
            : undefined;
        // 合法 modelContent（有序文本/引用）优先：ToolSearch 的发现集合只从真实引用恢复。
        const content =
          hydrateToolSearchContent(part.state.metadata?.modelContent) ??
          projectedMediaContent ??
          part.state.output;
        input.history.addToolResult(
          part.callID,
          providerToolName,
          content,
          true,
          false,
          modelCallWrapper,
        );
        continue;
      }

      if (part.state.status === "error") {
        const persistedModelContent = part.state.metadata?.modelContent;
        // 实时链路使用 ToolExecutionResult.modelContent，但旧恢复逻辑只重放
        // 面向 UI / 日志的 state.error；优先使用持久化字符串并兼容旧 session。
        input.history.addToolResult(
          part.callID,
          providerToolName,
          hydrateToolSearchContent(persistedModelContent) ??
            (typeof persistedModelContent === "string" ? persistedModelContent : part.state.error),
          false,
          true,
          modelCallWrapper,
        );
        continue;
      }

      interruptedToolCount++;
      input.history.addToolResult(
        part.callID,
        providerToolName,
        INTERRUPTED_TOOL_RESULT,
        false,
        true,
        modelCallWrapper,
      );
    }
  }

  return {
    appliedMessageCount,
    interruptedToolCount,
    messageCount: activeMessages.length,
    partCount,
  };
}

function modelCallWrapperFromPart(part: ToolPart) {
  const parsed = ModelCallWrapperSchema.safeParse(part.metadata?.modelCallWrapper);
  return parsed.success ? parsed.data : undefined;
}

export function activeSessionMessages(
  messages: MessageWithParts[],
  options: {
    branchCutAfterMessageId?: MessageId;
    includeCompactPreservedSegment?: boolean;
    rewindCreatedMessageId?: MessageId;
    rewindKeptMessageIds?: readonly MessageId[];
    rewindTargetMessageId?: MessageId;
  } = {},
): MessageWithParts[] {
  if (!options.branchCutAfterMessageId) {
    // 旧数据没有 branch cut，继续使用 compact-first/createdMessageID 兼容语义；不能把
    // 历史上非法的 compact 前 kept IDs 解释成新式 branch，从而改变既有冷恢复结果。
    let legacyCompactIndex = -1;
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index]!.parts.some(isActiveCompactionBoundaryPart)) {
        legacyCompactIndex = index;
        break;
      }
    }
    const compactActiveMessages =
      legacyCompactIndex >= 0
        ? compactActiveSessionMessages(
            messages,
            legacyCompactIndex,
            options.includeCompactPreservedSegment !== false,
          )
        : messages;
    if (options.rewindKeptMessageIds && legacyCompactIndex >= 0) {
      const postCompactIds = new Set(
        messages.slice(legacyCompactIndex).map((message) => message.info.id),
      );
      if (!options.rewindKeptMessageIds.some((messageId) => postCompactIds.has(messageId))) {
        return compactActiveMessages;
      }
    }
    return selectActiveConversationBranch(compactActiveMessages, options);
  }

  // 最后一个 compact boundary。顺序相反会让 compact 前 kept prefix 永远无法恢复。
  const branchActiveMessages = selectActiveConversationBranch(messages, options);
  let lastCompactionIndex = -1;
  for (let index = branchActiveMessages.length - 1; index >= 0; index--) {
    if (branchActiveMessages[index]!.parts.some(isActiveCompactionBoundaryPart)) {
      lastCompactionIndex = index;
      break;
    }
  }
  return lastCompactionIndex >= 0
    ? compactActiveSessionMessages(
        branchActiveMessages,
        lastCompactionIndex,
        options.includeCompactPreservedSegment !== false,
      )
    : branchActiveMessages;
}

function dedupeParts(parts: MessagePart[]): MessagePart[] {
  const byId = new Map<string, MessagePart>();
  for (const part of parts) {
    byId.set(part.id, part);
  }
  return [...byId.values()];
}
