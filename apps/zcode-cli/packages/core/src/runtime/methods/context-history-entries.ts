import {
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import type { ContextBuildResult } from "../deps.js";

// Context prefix 只含 system 消息与 meta user 公告；指令文件的已公告文件集合由
// runtime/session entry 拥有，这里不写 metadata.instructions（前缀正文可能是冻结的旧公告）。
export function buildContextHistoryEntries(
  contextResult: ContextBuildResult,
): RuntimeMessageEntry[] {
  return [
    ...contextResult.systemMessages.map((message): RuntimeMessageEntry => ({ message })),
    ...contextResult.metaUserAttachments.map((attachment) =>
      systemReminderAttachmentEntry(attachment.source, attachment.content),
    ),
  ];
}
