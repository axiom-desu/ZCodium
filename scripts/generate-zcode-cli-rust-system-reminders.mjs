// Run with node --import tsx. System reminder descriptors are projected from the
// current TS source of truth so Rust never keeps a hand-edited copy.
import { readFile, writeFile } from "node:fs/promises";
import { format } from "oxfmt";
import {
  SYSTEM_REMINDER_SOURCES,
  getSystemReminderDescriptor,
  isMidConversationSystemSource,
  wrapSystemReminderForSource,
} from "../apps/zcode-cli/packages/core/src/system-reminder/source.ts";

const sources = {};
for (const source of SYSTEM_REMINDER_SOURCES) {
  const descriptor = getSystemReminderDescriptor(source);
  sources[source] = {
    channel: descriptor.channel,
    lifecycle: descriptor.lifecycle,
    isMeta: descriptor.isMeta,
    providerVisibility: descriptor.providerVisibility,
    midConversation: isMidConversationSystemSource(source),
    // 从真实包装行为派生尾部换行，避免在生成器里复制 TS 的私有 Set。
    trailingNewline: wrapSystemReminderForSource(source, "x").endsWith("\n"),
  };
}

const path = new URL(
  "../apps/zcode-cli-rust/crates/domain/schema/system-reminders.json",
  import.meta.url,
);
const formatted = await format(path.pathname, `${JSON.stringify({ sources }, null, 2)}\n`);
if (formatted.errors.length) throw new Error("Cannot format Rust system reminders asset");
if (process.argv.includes("--check")) {
  if ((await readFile(path, "utf8")) !== formatted.code)
    throw new Error("Rust system reminders asset differs from TS source");
} else await writeFile(path, formatted.code);
