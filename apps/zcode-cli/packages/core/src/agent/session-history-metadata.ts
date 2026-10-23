// 会话历史恢复的 message metadata / part 投影：把持久化的 part 还原成 runtime metadata，
// 不持有 hydration 状态（写入仍由 hydrateMessageHistoryFromSession 唯一拥有）。

import type { MessagePart, ModelReasoningContentBlock, ToolPart } from "@zcode/contracts";
import {
  getSystemReminderDescriptor,
  type SystemReminderSource,
} from "../system-reminder/source.js";
import { runtimeInputMetadata } from "./runtime-input-presentation.js";
import { hydrateToolSearchAnnouncement } from "./tool-search-hydration.js";
import {
  isKnownSystemReminderSource,
  legacySyntheticRuntimeMetadata,
  realUserRuntimeMetadata,
  systemReminderRuntimeMetadata,
  todoReminderRuntimeMetadata,
  type RuntimeMessageMetadata,
  type RuntimeMessageSource,
} from "./message-history.js";

interface SyntheticSystemReminderAttachment {
  metadata: RuntimeMessageMetadata;
  content: string;
}

export function syntheticSystemReminderAttachmentFromParts(
  parts: MessagePart[],
): SyntheticSystemReminderAttachment | undefined {
  const visibleParts = parts.filter((part) => !(part.type === "text" && part.ignored));
  if (visibleParts.length !== 1) return undefined;

  const part = visibleParts[0]!;
  if (part.type !== "text" || !part.synthetic) return undefined;
  return syntheticSystemReminderAttachmentFromTextPart(part);
}

export function syntheticSystemReminderAttachmentFromTextPart(
  part: Extract<MessagePart, { type: "text" }>,
): SyntheticSystemReminderAttachment | undefined {
  if (!part.synthetic) return undefined;
  if (part.text.trim().length === 0) return undefined;
  const metadata = metadataFromSyntheticTextPart(part);
  const announcement = metadata.toolSearchAnnouncement;
  const wrapped = isProviderWrappedSystemReminderText(part.text);
  // 公告正文在持久化时可能带 provider 包装；只有已校验的公告身份可以还原，
  // 普通用户正文即使以 <system-reminder> 开头也不能被改写成 attachment。
  if (wrapped && !announcement) return undefined;
  if (!isRestorableSystemReminderAttachmentSource(metadata.source)) return undefined;

  return {
    metadata,
    content:
      wrapped && announcement
        ? part.text
            .trim()
            .replace(/^<system-reminder>\s*/, "")
            .replace(/\s*<\/system-reminder>$/, "")
        : part.text,
  };
}

function isRestorableSystemReminderAttachmentSource(
  source: RuntimeMessageSource,
): source is SystemReminderSource {
  if (!isKnownSystemReminderSource(source)) return false;
  const descriptor = getSystemReminderDescriptor(source);
  return (
    descriptor.isMeta &&
    descriptor.providerVisibility === "provider_visible" &&
    descriptor.channel !== "real_user" &&
    descriptor.channel !== "tool_result"
  );
}

export function isProviderWrappedSystemReminderText(text: string): boolean {
  return text.trimStart().startsWith("<system-reminder");
}

export function metadataFromUserParts(parts: MessagePart[]): RuntimeMessageMetadata {
  const visibleTextParts = parts.filter(
    (part): part is Extract<MessagePart, { type: "text" }> => part.type === "text" && !part.ignored,
  );
  const hasRealUserText = visibleTextParts.some((part) => !part.synthetic);
  const hasStructuredUserPart = parts.some((part) => part.type === "file" || part.type === "agent");
  if (hasRealUserText || hasStructuredUserPart) {
    return realUserRuntimeMetadata();
  }

  const syntheticTextPart = visibleTextParts.find((part) => part.synthetic);
  if (!syntheticTextPart) {
    return realUserRuntimeMetadata();
  }

  return metadataFromSyntheticTextPart(syntheticTextPart);
}

function metadataFromSyntheticTextPart(
  part: Extract<MessagePart, { type: "text" }>,
): RuntimeMessageMetadata {
  const source = part.metadata?.source;
  if (source === "background_task" || source === "subagent_message") {
    // runtime command carrier 对齐直接 user-like 注入；即使旧持久化里带过
    // system reminder metadata，恢复时也不能把后台完成或 child 回复重新包成 reminder。
    return legacySyntheticRuntimeMetadata();
  }

  const persistedRuntimeMetadata = runtimeMessageMetadataFromPartMetadata(part.metadata);
  const topLevelAnnouncement = hydrateToolSearchAnnouncement(
    isRecord(part.metadata) ? part.metadata.toolSearchAnnouncement : undefined,
  );
  const announcement = persistedRuntimeMetadata?.toolSearchAnnouncement ?? topLevelAnnouncement;
  if (
    source === "tool_search_announcement" ||
    persistedRuntimeMetadata?.source === "tool_search_announcement"
  ) {
    // 旧写入把增量放在 part.metadata 顶层；已校验的 delta 仍要恢复，否则 fork/resume
    // 会把已公告工具当成首次出现并重复公告。损坏的 delta 只丢增量字段，不丢 source。
    return {
      ...legacySyntheticRuntimeMetadata(),
      source: "tool_search_announcement",
      ...(announcement ? { toolSearchAnnouncement: announcement } : {}),
    };
  }
  if (persistedRuntimeMetadata) return persistedRuntimeMetadata;

  if (source === "subagent") {
    return systemReminderRuntimeMetadata("queued_system_notification");
  }
  if (source === "todo_reminder") {
    return todoReminderRuntimeMetadata();
  }
  if (source === "goal-continuation") {
    return systemReminderRuntimeMetadata("target_continuation");
  }
  if (source === "rewind" || source === "fork") {
    return systemReminderRuntimeMetadata("rewind_notice");
  }
  if (isKnownSystemReminderSource(source)) {
    return systemReminderRuntimeMetadata(source);
  }

  return legacySyntheticRuntimeMetadata();
}

export function runtimeMessageMetadataFromPartMetadata(
  metadata: Record<string, unknown> | undefined,
): RuntimeMessageMetadata | undefined {
  const runtimeMessage = metadata?.runtimeMessage;
  if (!isRecord(runtimeMessage)) return undefined;

  const presentation = runtimeInputMetadata(runtimeMessage.inputPresentation);
  if (presentation) return presentation;
  const source = runtimeMessage.source;
  if (source === "real_user") {
    return realUserRuntimeMetadata();
  }
  if (source === "legacy_synthetic" || source === "tool_search_announcement") {
    const announcement = hydrateToolSearchAnnouncement(runtimeMessage.toolSearchAnnouncement);
    return {
      ...legacySyntheticRuntimeMetadata(),
      ...(announcement
        ? { source: "tool_search_announcement" as const, toolSearchAnnouncement: announcement }
        : {}),
    };
  }
  if (source === "todo_reminder") {
    return todoReminderRuntimeMetadata();
  }
  if (isKnownSystemReminderSource(source)) {
    return systemReminderRuntimeMetadata(source);
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assistantTextFromParts(parts: MessagePart[]): string {
  const chunks: string[] = [];

  for (const part of parts) {
    if (part.type === "text" && !part.ignored) {
      chunks.push(part.text);
    }
  }

  return chunks.join("\n\n");
}

export function assistantReasoningFromParts(parts: MessagePart[]): ModelReasoningContentBlock[] {
  const blocks: ModelReasoningContentBlock[] = [];

  for (const part of parts) {
    if (part.type === "reasoning") {
      blocks.push({
        type: "reasoning",
        text: part.text,
        providerOptions: part.metadata ? { ...part.metadata } : undefined,
      });
    }
  }

  return blocks;
}

export function isToolPart(part: MessagePart): part is ToolPart {
  return part.type === "tool";
}

export function providerToolNameFromPart(part: ToolPart): string {
  const providerToolName = part.metadata?.providerToolName;
  // 空字符串在 cold hydration 中曾只能依赖 non-empty ToolPart.tool；
  // 必须按字段存在性恢复原值，不能用 truthy 判断把空名重新覆盖成占位值。
  return providerToolName !== undefined && typeof providerToolName === "string"
    ? providerToolName
    : part.tool;
}
