// Runtime message entry 的克隆与判别：纯转换，不持有历史状态。

import type {
  ModelMessageContent,
  ModelMessageContentBlock,
  TokenUsageInfo,
} from "@zcode/contracts";
import type {
  ModelInputMessage,
  ReasoningContentInput,
  RuntimeAttachmentEntry,
  RuntimeMessageEntry,
  RuntimeMessageMetadata,
} from "./message-history.js";

export function cloneEntryInput(
  input: ModelInputMessage | RuntimeMessageEntry,
): RuntimeMessageEntry {
  if (isRuntimeMessageEntry(input)) {
    return cloneRuntimeMessageEntry(input);
  }
  return { message: cloneModelInputMessage(input) };
}

export function cloneRuntimeMessageEntry(entry: RuntimeMessageEntry): RuntimeMessageEntry {
  if (entry.kind === "attachment") {
    return {
      kind: "attachment",
      content: entry.content,
      cacheControl: entry.cacheControl ? { ...entry.cacheControl } : undefined,
      metadata: cloneRuntimeMessageMetadata(entry.metadata)!,
    };
  }
  return {
    message: cloneModelInputMessage(entry.message),
    metadata: cloneRuntimeMessageMetadata(entry.metadata),
    ...(entry.tokens ? { tokens: cloneTokenUsageInfo(entry.tokens) } : {}),
    ...(entry.queryScope ? { queryScope: entry.queryScope } : {}),
  };
}

/**
 * Compact 之后 preserved assistant 的 provider usage 仍属于被替换的旧前缀。
 * 只对 projection 副本清零，不能改写 SessionStore 中的原始 tokens。
 */
export function invalidateRuntimeTokenUsage(tokens: TokenUsageInfo): TokenUsageInfo {
  return {
    ...tokens,
    total: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cache: {
      read: 0,
      write: 0,
    },
  };
}

export function cloneTokenUsageInfo(tokens: TokenUsageInfo): TokenUsageInfo {
  return {
    ...tokens,
    cache: { ...tokens.cache },
  };
}

export function cloneRuntimeMessageMetadata(
  metadata: RuntimeMessageMetadata | undefined,
): RuntimeMessageMetadata | undefined {
  return metadata ? { ...metadata } : undefined;
}

export function messageFromEntryInput(
  input: ModelInputMessage | RuntimeMessageEntry,
): ModelInputMessage {
  if (isRuntimeAttachmentEntry(input)) {
    throw new Error("Runtime attachment entries do not have a direct model message representation");
  }
  return isRuntimeMessageEntry(input) ? input.message : input;
}

export function metadataFromEntryInput(
  input: ModelInputMessage | RuntimeMessageEntry,
): RuntimeMessageMetadata | undefined {
  return isRuntimeMessageEntry(input) ? input.metadata : undefined;
}

function isRuntimeMessageEntry(
  input: ModelInputMessage | RuntimeMessageEntry,
): input is RuntimeMessageEntry {
  return "message" in input || ("kind" in input && input.kind === "attachment");
}

export function isRuntimeAttachmentEntry(
  input: ModelInputMessage | RuntimeMessageEntry,
): input is RuntimeAttachmentEntry {
  return isRuntimeMessageEntry(input) && "kind" in input && input.kind === "attachment";
}

export function cloneModelInputMessage(message: ModelInputMessage): ModelInputMessage {
  const next: ModelInputMessage = {
    role: message.role,
    content: cloneModelMessageContent(message.content),
  };
  if (message.cacheControl) next.cacheControl = { ...message.cacheControl };
  if (message.toolCalls) next.toolCalls = message.toolCalls.map((toolCall) => ({ ...toolCall }));
  if (message.toolCallId) next.toolCallId = message.toolCallId;
  // 空字符串是可恢复调用的 provider 原始名称，不能在 request-local clone 时按 falsy 丢失。
  if (message.toolName !== undefined) next.toolName = message.toolName;
  if (message.isError !== undefined) next.isError = message.isError;
  if (message.providerId) next.providerId = message.providerId;
  if (message.modelId) next.modelId = message.modelId;
  return next;
}

export function cloneReasoningBlock(block: ReasoningContentInput): ReasoningContentInput {
  return {
    ...block,
    providerOptions: block.providerOptions ? { ...block.providerOptions } : undefined,
  };
}

export function cloneModelMessageContent(content: ModelMessageContent): ModelMessageContent {
  if (typeof content === "string") return content;
  return content.map(cloneModelMessageContentBlock);
}

function cloneModelMessageContentBlock(block: ModelMessageContentBlock): ModelMessageContentBlock {
  if (block.type === "reasoning") {
    return cloneReasoningBlock(block);
  }
  if ("source" in block && block.source) {
    return { ...block, source: { ...block.source } };
  }
  return { ...block };
}
