import { parseRuntimeInputPresentation } from "@zcode/contracts";
import { isRuntimeAttachmentEntry, type RuntimeMessageEntry } from "../../agent/message-history.js";
import {
  formatIncomingMessage,
  isMidTurnInputPresentation,
} from "../../system-reminder/incoming-message.js";
import { wrapSystemReminderForSource } from "../../system-reminder/source.js";

/** 仅单次请求拥有的投影映射；不写入 canonical history 或 provider payload。 */
export class ProviderEntryOrigins {
  private readonly origins = new WeakMap<RuntimeMessageEntry, readonly RuntimeMessageEntry[]>();

  get(entry: RuntimeMessageEntry): readonly RuntimeMessageEntry[] {
    return this.origins.get(entry) ?? [entry];
  }

  set(entry: RuntimeMessageEntry, inputs: readonly RuntimeMessageEntry[]): void {
    this.origins.set(
      entry,
      inputs.flatMap((input) => this.get(input)),
    );
  }

  hasRealUser(entry: RuntimeMessageEntry): boolean {
    return this.get(entry).some(isCanonicalRealUser);
  }

  representative(entry: RuntimeMessageEntry): RuntimeMessageEntry | undefined {
    const entries = this.get(entry);
    return (
      entries.findLast(isCanonicalRealUser) ??
      entries.findLast((item) => !isRuntimeAttachmentEntry(item))
    );
  }
}

function isCanonicalRealUser(entry: RuntimeMessageEntry): boolean {
  return (
    !isRuntimeAttachmentEntry(entry) &&
    entry.queryScope !== "output_token_continuation" &&
    entry.message.role === "user" &&
    !entry.message.toolCallId &&
    !entry.message.toolName &&
    (!entry.metadata || entry.metadata.source === "real_user")
  );
}

/** 轮首的真实用户输入：普通 user 消息且不是 attachment 投影（上游 3.18.2 同名判定）。 */
export function isRealUserPrompt(entry: RuntimeMessageEntry): boolean {
  return isCanonicalRealUser(entry) && !isPresentedInput(entry);
}

export function isPresentedInput(entry: RuntimeMessageEntry): boolean {
  return parseRuntimeInputPresentation(entry.metadata?.inputPresentation) !== undefined;
}

export function projectIncomingMessageEntries(
  entries: readonly RuntimeMessageEntry[],
  origins: ProviderEntryOrigins,
): RuntimeMessageEntry[] {
  return entries.map((entry) => {
    if (isRuntimeAttachmentEntry(entry) || entry.message.role !== "user") return entry;
    const presentation = parseRuntimeInputPresentation(entry.metadata?.inputPresentation);
    if (!presentation) return entry;
    const content = entry.message.content;
    if (typeof content !== "string" && content.some((block) => block.type !== "text")) return entry;
    const body =
      typeof content === "string"
        ? content
        : content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
    const formatted = formatIncomingMessage(body, presentation);
    // 新轮通知不经过 Attachment 包装；在同一投影边界补齐标签与转义，保持 user 身份和原始历史。
    const text =
      presentation === "task_notification"
        ? wrapSystemReminderForSource("incoming_message", formatted)
        : formatted;
    const projected: RuntimeMessageEntry = isMidTurnInputPresentation(presentation)
      ? {
          kind: "attachment",
          content: text,
          metadata: { source: "incoming_message", inputPresentation: presentation },
        }
      : { ...entry, message: { ...entry.message, content: text } };
    origins.set(projected, [entry]);
    return projected;
  });
}
