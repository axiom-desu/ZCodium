// ============================================================
// Message History - Maintains conversation context across turns
// ============================================================

import {
  type RuntimeInputPresentation,
  modelMessageContentToText,
  type ModelCacheControl,
  type ModelMessageContent,
  type Model,
  type ModelReasoningContentBlock,
  type TokenUsageInfo,
} from "@zcode/contracts";
import { SYSTEM_REMINDER_SOURCES, type SystemReminderSource } from "../system-reminder/source.js";
import {
  cloneEntryInput,
  cloneReasoningBlock,
  cloneRuntimeMessageEntry,
  cloneRuntimeMessageMetadata,
  cloneTokenUsageInfo,
  isRuntimeAttachmentEntry,
  messageFromEntryInput,
  metadataFromEntryInput,
} from "./message-history-entries.js";

export {
  cloneModelInputMessage,
  cloneModelMessageContent,
  cloneRuntimeMessageEntry,
  invalidateRuntimeTokenUsage,
  isRuntimeAttachmentEntry,
} from "./message-history-entries.js";

// Tool call from model (simple type, no brand)
export interface ToolCallInput {
  id: string;
  name: string;
  input: unknown;
}

export type ReasoningContentInput = ModelReasoningContentBlock;

export interface ModelInputMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: ModelMessageContent;
  cacheControl?: ModelCacheControl;
  toolCalls?: ToolCallInput[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  providerId?: Model["providerId"];
  modelId?: Model["modelId"];
}

export type RuntimeMessageSource =
  | SystemReminderSource
  | "shared_context"
  | "real_user"
  | "legacy_synthetic";

export interface RuntimeMessageMetadata {
  source: RuntimeMessageSource;
  inputPresentation?: RuntimeInputPresentation;
}

export interface RuntimeMessageMessageEntry {
  kind?: "message";
  message: ModelInputMessage;
  metadata?: RuntimeMessageMetadata;
  /** 已提交 assistant 自己的 provider tokens；不会发送到 provider。 */
  tokens?: TokenUsageInfo;
  /** 仅在当前 query 内生效；不得进入 canonical history 或 Session persistence。 */
  queryScope?: "output_token_continuation";
}

export interface RuntimeAttachmentEntry {
  kind: "attachment";
  content: string;
  cacheControl?: ModelCacheControl;
  metadata: RuntimeMessageMetadata;
}

export type RuntimeMessageEntry = RuntimeMessageMessageEntry | RuntimeAttachmentEntry;

export interface CacheStats {
  totalMessages: number;
  cachedMessages: number;
  lastCacheHit: boolean;
  cacheReadTokens?: number;
}

// ============================================================
// Message History Interface
// ============================================================

export interface MessageHistory {
  // Initialize with optional system prompt or context prefix messages
  init(systemPromptOrMessages?: string | Array<ModelInputMessage | RuntimeMessageEntry>): void;

  // Add user message
  addUser(content: ModelMessageContent, metadata?: RuntimeMessageMetadata): void;

  // Add structured internal context that provider projection renders at request time.
  addAttachment(source: SystemReminderSource, content: string): void;

  // Add already-built runtime entries while preserving their source metadata.
  addEntries(entries: readonly RuntimeMessageEntry[]): void;

  // Add assistant message (may include tool calls)
  addAssistant(
    content: string,
    toolCalls?: ToolCallInput[],
    reasoning?: ReasoningContentInput[],
    model?: Pick<Model, "providerId" | "modelId">,
    tokens?: TokenUsageInfo,
  ): void;

  // Add tool result
  addToolResult(
    toolCallId: string,
    toolName: string,
    content: ModelMessageContent,
    success: boolean,
    isError?: boolean,
  ): void;

  // 借用当前权威 entries，只允许同步只读；跨异步边界时由调用方做数组浅快照。
  borrowReadOnlyRuntimeEntries(): readonly RuntimeMessageEntry[];

  // 创建可写的防御性副本；Runtime 内部普通只读点应使用 borrowReadOnlyRuntimeEntries。
  toRuntimeEntries(): RuntimeMessageEntry[];

  // Replace the active provider-visible history after compact/rewind.
  replaceMessages(messages: readonly (ModelInputMessage | RuntimeMessageEntry)[]): void;

  // Get current message count
  getMessageCount(): number;

  // Cache management
  getCacheStats(): CacheStats;
  setCacheHit(tokens?: number): void;
  setCacheMiss(): void;

  // Reset for new turn
  reset(): void;
}

// ============================================================
// Message History Implementation
// ============================================================

export class MessageHistoryImpl implements MessageHistory {
  private entries: RuntimeMessageEntry[] = [];
  private cacheStats: CacheStats = {
    totalMessages: 0,
    cachedMessages: 0,
    lastCacheHit: false,
  };

  init(systemPromptOrMessages?: string | Array<ModelInputMessage | RuntimeMessageEntry>): void {
    this.entries = [];

    if (typeof systemPromptOrMessages === "string" && systemPromptOrMessages.length > 0) {
      this.entries.push({
        message: {
          role: "system",
          content: systemPromptOrMessages,
        },
      });
    } else if (Array.isArray(systemPromptOrMessages)) {
      this.entries.push(...systemPromptOrMessages.map(cloneEntryInput));
    }

    this.cacheStats = {
      totalMessages: this.entries.length,
      cachedMessages: countContextPrefixMessages(this.entries),
      lastCacheHit: false,
    };
  }

  addUser(content: ModelMessageContent, metadata?: RuntimeMessageMetadata): void {
    this.entries.push(createRuntimeUserEntry(content, metadata));
    this.cacheStats.totalMessages = this.entries.length;
  }

  addAttachment(source: SystemReminderSource, content: string): void {
    this.entries.push(systemReminderAttachmentEntry(source, content));
    this.cacheStats.totalMessages = this.entries.length;
  }

  addEntries(entries: readonly RuntimeMessageEntry[]): void {
    this.entries.push(...entries.map(cloneRuntimeMessageEntry));
    this.cacheStats.totalMessages = this.entries.length;
  }

  addAssistant(
    content: string,
    toolCalls?: ToolCallInput[],
    reasoning?: ReasoningContentInput[],
    model?: Pick<Model, "providerId" | "modelId">,
    tokens?: TokenUsageInfo,
  ): void {
    const reasoningBlocks = reasoning?.map((block) => cloneReasoningBlock(block)) ?? [];
    this.entries.push({
      message: {
        role: "assistant",
        content:
          reasoningBlocks.length > 0
            ? [
                ...reasoningBlocks,
                ...(content.length > 0 ? [{ type: "text" as const, text: content }] : []),
              ]
            : content,
        toolCalls: toolCalls?.map((tc) => ({
          id: tc.id,
          name: tc.name,
          input: tc.input,
        })),
        ...(model ? { providerId: model.providerId, modelId: model.modelId } : {}),
      },
      ...(tokens ? { tokens: cloneTokenUsageInfo(tokens) } : {}),
    });
    this.cacheStats.totalMessages = this.entries.length;
  }

  addToolResult(
    toolCallId: string,
    toolName: string,
    content: ModelMessageContent,
    success: boolean,
    isError = !success,
  ): void {
    this.entries.push(createRuntimeToolResultEntry(toolCallId, toolName, content, isError));
    this.cacheStats.totalMessages = this.entries.length;
  }

  borrowReadOnlyRuntimeEntries(): readonly RuntimeMessageEntry[] {
    return this.entries;
  }

  toRuntimeEntries(): RuntimeMessageEntry[] {
    return this.entries.map(cloneRuntimeMessageEntry);
  }

  replaceMessages(messages: readonly (ModelInputMessage | RuntimeMessageEntry)[]): void {
    this.entries = messages.map(cloneEntryInput);
    this.cacheStats = {
      totalMessages: this.entries.length,
      cachedMessages: countContextPrefixMessages(this.entries),
      lastCacheHit: false,
    };
  }

  getMessageCount(): number {
    return this.entries.length;
  }

  getCacheStats(): CacheStats {
    return { ...this.cacheStats };
  }

  setCacheHit(tokens?: number): void {
    this.cacheStats.lastCacheHit = true;
    this.cacheStats.cacheReadTokens = tokens;
    // Mark all messages as potentially cached
    this.cacheStats.cachedMessages = this.entries.length;
  }

  setCacheMiss(): void {
    this.cacheStats.lastCacheHit = false;
    this.cacheStats.cacheReadTokens = undefined;
    this.cacheStats.cachedMessages = countContextPrefixMessages(this.entries);
  }

  reset(): void {
    const contextPrefixMessages = this.entries.slice(0, countContextPrefixMessages(this.entries));
    this.entries = contextPrefixMessages.map(cloneRuntimeMessageEntry);
    this.cacheStats = {
      totalMessages: contextPrefixMessages.length,
      cachedMessages: contextPrefixMessages.length,
      lastCacheHit: false,
    };
  }
}

export function countContextPrefixMessages(
  messagesOrEntries: readonly (ModelInputMessage | RuntimeMessageEntry)[],
): number {
  let count = 0;
  for (const item of messagesOrEntries) {
    if (isRuntimeAttachmentEntry(item)) {
      if (item.metadata.source === "context_prefix" || item.metadata.source === "skills_listing") {
        count++;
        continue;
      }
      break;
    }
    const message = messageFromEntryInput(item);
    const metadata = metadataFromEntryInput(item);
    if (message.role === "system") {
      count++;
      continue;
    }
    if (message.role !== "user") break;
    if (metadata) {
      if (metadata.source === "context_prefix" || metadata.source === "skills_listing") {
        count++;
        continue;
      }
      break;
    }
    if (isMetaUserContext(message.content)) {
      count++;
      continue;
    }
    break;
  }
  return count;
}

function isMetaUserContext(content: ModelMessageContent): boolean {
  return modelMessageContentToText(content).trimStart().startsWith("<system-reminder>");
}

export function systemReminderRuntimeMetadata(
  source: SystemReminderSource,
): RuntimeMessageMetadata {
  return { source };
}

export function realUserRuntimeMetadata(): RuntimeMessageMetadata {
  return { source: "real_user" };
}

export function legacySyntheticRuntimeMetadata(): RuntimeMessageMetadata {
  return { source: "legacy_synthetic" };
}

export function todoReminderRuntimeMetadata(): RuntimeMessageMetadata {
  return { source: "todo_reminder" };
}

export function systemReminderAttachmentEntry(
  source: SystemReminderSource,
  content: string,
): RuntimeAttachmentEntry {
  return {
    kind: "attachment",
    content,
    metadata: systemReminderRuntimeMetadata(source),
  };
}

export function createRuntimeUserEntry(
  content: ModelMessageContent,
  metadata?: RuntimeMessageMetadata,
): RuntimeMessageMessageEntry {
  return {
    message: {
      role: "user",
      content,
    },
    metadata: cloneRuntimeMessageMetadata(metadata),
  };
}

export function createRuntimeAssistantEntry(
  content: string,
  toolCalls?: readonly ToolCallInput[],
  reasoning?: readonly ReasoningContentInput[],
  model?: Pick<Model, "providerId" | "modelId">,
  tokens?: TokenUsageInfo,
): RuntimeMessageMessageEntry {
  const reasoningBlocks = reasoning?.map((block) => cloneReasoningBlock(block)) ?? [];
  return {
    message: {
      role: "assistant",
      content:
        reasoningBlocks.length > 0
          ? [
              ...reasoningBlocks,
              ...(content.length > 0 ? [{ type: "text" as const, text: content }] : []),
            ]
          : content,
      toolCalls: toolCalls?.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.input,
      })),
      ...(model ? { providerId: model.providerId, modelId: model.modelId } : {}),
    },
    ...(tokens ? { tokens: cloneTokenUsageInfo(tokens) } : {}),
  };
}

export function createRuntimeToolResultEntry(
  toolCallId: string,
  toolName: string,
  content: ModelMessageContent,
  isError: boolean,
): RuntimeMessageMessageEntry {
  return {
    message: {
      role: "tool",
      content,
      toolCallId,
      toolName,
      isError,
    },
  };
}

export function isKnownSystemReminderSource(value: unknown): value is SystemReminderSource {
  return (
    typeof value === "string" && SYSTEM_REMINDER_SOURCES.includes(value as SystemReminderSource)
  );
}

// ============================================================
// Factory
// ============================================================

export function createMessageHistory(): MessageHistory {
  return new MessageHistoryImpl();
}
