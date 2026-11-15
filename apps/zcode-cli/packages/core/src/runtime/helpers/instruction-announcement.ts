// ============================================================
// 指令公告状态（上游 3.18.2 F1）
// ============================================================
// 唯一所有者是 runtime.instructionAnnouncement：已公告的完整正文（前缀按它渲染，字节冻结）
// 与已公告文件集合（增量比较用）。持久化在 session entry（每会话一行，覆盖写）。
// 已落库的增量提醒是 append-only 历史事实，只用于冷恢复读取，不参与"当前已公告集合"判定。

import { SESSION_ENTRY_INSTRUCTION_ANNOUNCEMENT } from "@zcode/contracts";
import {
  parseLegacyInstructionFiles,
  parseInstructionAnnouncement,
  renderInstructionDelta,
  instructionFileRecord,
} from "../../context/sections/instruction-files.js";
import type {
  InstructionAnnouncement,
  InstructionFile,
  InstructionRefreshReason,
} from "../../context/types.js";
import {
  isRuntimeAttachmentEntry,
  type RuntimeAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import { traceContextToLogContext } from "../deps.js";
import type { TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

type InstructionFileRecord = InstructionAnnouncement["files"][number];

export interface InstructionAnnouncementState {
  /** 首次公告的完整正文（preamble + 全部区块）；前缀按它渲染，不随文件变化改写。 */
  content: string;
  /** 已公告的文件（path/type/hash）；增量比较与冷恢复的唯一来源。 */
  files: InstructionFileRecord[];
}

/** 只有主会话（带 session store）持有指令公告；子 agent 与工作流 actor 不用。 */
function usesInstructionAnnouncement(runtime: AgentRuntimeInternal): boolean {
  return Boolean(runtime.sessionStore);
}

/** 恢复会话时读取已公告状态；读取失败或数据无效按没有公告处理，不阻断恢复。 */
export async function loadInstructionAnnouncement(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  runtime.instructionAnnouncement = undefined;
  if (!usesInstructionAnnouncement(runtime)) return;
  try {
    const entries = await runtime.sessionStore?.sessionEntries?.({
      sessionID: runtime.sessionId,
      type: SESSION_ENTRY_INSTRUCTION_ANNOUNCEMENT,
    });
    runtime.instructionAnnouncement = parseInstructionAnnouncementState(entries?.at(-1)?.data);
  } catch (error) {
    runtime.logger?.warn("Instruction announcement read failed", {
      ...traceContextToLogContext(traceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "context.instructions.announcement_read_failed",
      module: "core.runtime",
    });
  }
}

/**
 * 首次公告：把本次构建出的完整正文与文件集合记成已公告。
 * 已有状态时不覆盖——否则冷恢复后会把冻结正文换成当前文件内容，前缀字节改变。
 */
export async function recordInstructionAnnouncement(
  runtime: AgentRuntimeInternal,
  input: { content: string; files: readonly InstructionFile[] },
  traceContext: TraceContext,
): Promise<void> {
  if (!usesInstructionAnnouncement(runtime) || runtime.instructionAnnouncement) return;
  runtime.instructionAnnouncement = {
    content: input.content,
    files: input.files.map(instructionFileRecord),
  };
  await saveInstructionAnnouncement(runtime, traceContext);
}

/**
 * 按已公告状态与当前文件算出需要追加的增量公告；没有变化时不产生公告。
 * 当前文件来自 runtime 最近一次构建（启动时与 compaction 提交后读取）。
 */
export function buildInstructionDeltaEntry(
  runtime: AgentRuntimeInternal,
  reason: InstructionRefreshReason,
): RuntimeMessageEntry | undefined {
  const state = runtime.instructionAnnouncement;
  if (!state) return undefined;
  const current = currentInstructionFiles(runtime);
  const announced = new Map(state.files.map((file) => [file.path, file]));
  const changed = current.filter((file) => {
    const previous = announced.get(file.path);
    const record = instructionFileRecord(file);
    return !previous || previous.hash !== record.hash || previous.type !== record.type;
  });
  const currentPaths = new Set(current.map((file) => file.path));
  const removed = [...announced.keys()].filter((path) => !currentPaths.has(path));
  if (changed.length === 0 && removed.length === 0) return undefined;
  return {
    kind: "attachment",
    content: renderInstructionDelta(changed, removed, reason),
    metadata: {
      source: "context_prefix",
      instructions: {
        files: changed.map(instructionFileRecord),
        ...(removed.length > 0 ? { removed } : {}),
        reason,
      },
    },
  };
}

/** 增量已落库后把它并入已公告集合；removed 从集合里删除，changed 覆盖同路径。 */
export async function applyInstructionAnnouncement(
  runtime: AgentRuntimeInternal,
  announcement: InstructionAnnouncement,
  traceContext: TraceContext,
): Promise<void> {
  const state = runtime.instructionAnnouncement;
  if (!state) return;
  const files = new Map(state.files.map((file) => [file.path, file]));
  for (const file of announcement.files) files.set(file.path, file);
  for (const path of announcement.removed ?? []) files.delete(path);
  runtime.instructionAnnouncement = { ...state, files: [...files.values()] };
  await saveInstructionAnnouncement(runtime, traceContext);
}

/**
 * 历史里有、状态里没有时的兜底来源：最后一条完整公告加上其后的增量。
 * 只用于旧会话（写入指令公告状态之前）与状态读写失败的恢复路径。
 */
export function announcedInstructionFilesFromHistory(
  entries: readonly RuntimeMessageEntry[],
): Map<string, InstructionFileRecord> | undefined {
  const records = entries.filter(
    (entry): entry is RuntimeAttachmentEntry =>
      isRuntimeAttachmentEntry(entry) && entry.metadata.source === "context_prefix",
  );
  const fullIndex = records.findLastIndex((record) => !record.metadata.instructions?.reason);
  if (fullIndex === -1) return undefined;
  const files = new Map<string, InstructionFileRecord>();
  for (const record of records.slice(fullIndex)) {
    // 旧记录没有 metadata，只可能是完整公告；按标题行拆出文件。
    const announcement = record.metadata.instructions ?? {
      files: parseLegacyInstructionFiles(record.content),
    };
    for (const file of announcement.files) files.set(file.path, file);
    for (const path of announcement.removed ?? []) files.delete(path);
  }
  return files;
}

function currentInstructionFiles(runtime: AgentRuntimeInternal): InstructionFile[] {
  return (
    runtime.latestContextBuildResult?.metaUserAttachments.find(
      (attachment) => attachment.source === "context_prefix",
    )?.files ?? []
  );
}

async function saveInstructionAnnouncement(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  const state = runtime.instructionAnnouncement;
  if (!usesInstructionAnnouncement(runtime) || !runtime.sessionStore?.saveSessionEntry || !state)
    return;
  const timestamp = Date.now();
  try {
    await runtime.sessionStore.saveSessionEntry({
      id: `${runtime.sessionId}:runtime-instruction-announcement`,
      sessionID: runtime.sessionId,
      type: SESSION_ENTRY_INSTRUCTION_ANNOUNCEMENT,
      touchSession: false,
      time: { created: timestamp, updated: timestamp },
      data: state,
    });
  } catch (error) {
    // 写入失败只记 warning：下一次请求会重新比较并再发同一条增量，不会丢内容。
    runtime.logger?.warn("Instruction announcement write failed", {
      ...traceContextToLogContext(traceContext),
      error: error instanceof Error ? error.message : String(error),
      event: "context.instructions.announcement_write_failed",
      module: "core.runtime",
    });
  }
}

/**
 * 状态缺失但历史里有完整公告时，用历史文件集合 + 当前渲染正文补一份状态：
 * 旧会话冷恢复后不会再整份重发，只按之后的差异追加增量。
 */
export function seedInstructionAnnouncementFromHistory(
  runtime: AgentRuntimeInternal,
  entries: readonly RuntimeMessageEntry[],
): boolean {
  if (!usesInstructionAnnouncement(runtime) || runtime.instructionAnnouncement) return false;
  const files = announcedInstructionFilesFromHistory(entries);
  const content = runtime.latestContextBuildResult?.sections.find(
    (section) => section.source === "request_user_context",
  )?.content;
  if (!files || !content) return false;
  runtime.instructionAnnouncement = { content, files: [...files.values()] };
  return true;
}

function parseInstructionAnnouncementState(
  data: unknown,
): InstructionAnnouncementState | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { content, files } = data as Record<string, unknown>;
  if (typeof content !== "string" || content.length === 0) return undefined;
  const parsed = parseInstructionAnnouncement({ files });
  return parsed ? { content, files: parsed.files } : undefined;
}
