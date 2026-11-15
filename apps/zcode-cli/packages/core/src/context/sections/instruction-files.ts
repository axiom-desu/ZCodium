// ============================================================
// Instruction file blocks and change announcements
// ============================================================
// 从上游 3.18.2（apps/zcode-cli/packages/core/src/context/sections/instruction-files.ts）
// 语义搬迁：区块形状、类型文案、增量公告与解析规则保持一致。
// 差异：额外兼容本仓 3.17 时代的两条旧标题行（workspace/user default instructions），
// 否则没有 metadata 的历史会话在冷恢复时无法拆出已公告文件。

import { createHash } from "node:crypto";

import type {
  InstructionAnnouncement,
  InstructionFile,
  InstructionRefreshReason,
} from "../types.js";

export const INSTRUCTIONS_PREAMBLE =
  "Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.";

export const INSTRUCTION_TYPE_PROJECT = "project instructions, checked into the codebase";
export const INSTRUCTION_TYPE_USER = "user's private global instructions for all projects";
export const INSTRUCTION_TYPE_AUTO_MEMORY = "user's auto-memory, persists across conversations";

const INSTRUCTION_TYPES = [
  INSTRUCTION_TYPE_PROJECT,
  INSTRUCTION_TYPE_USER,
  INSTRUCTION_TYPE_AUTO_MEMORY,
] as const;

/** 本仓 3.17 时代渲染的两种旧类型文案；只用于解析历史，不再写出。 */
const LEGACY_INSTRUCTION_TYPES = ["workspace instructions", "user default instructions"] as const;

const REFRESH_REASON_TEXT: Record<InstructionRefreshReason, string> = {
  session_start: "when this session started",
  compaction: "after the conversation was compacted",
};

function renderInstructionFile(file: InstructionFile): string {
  return `Contents of ${file.path} (${file.type}):\n\n${file.body}`;
}

/** 完整公告：preamble 加全部文件块。 */
export function renderInstructionAnnouncement(files: readonly InstructionFile[]): string {
  return `${INSTRUCTIONS_PREAMBLE}\n\n${files.map(renderInstructionFile).join("\n\n")}`;
}

/**
 * 增量公告：变化或新增的文件共用一句说明，再跟完整文件块；每个删除的文件一段。
 * 只有删除时首段只说明已重读。段落之间空一行。
 */
export function renderInstructionDelta(
  changed: readonly InstructionFile[],
  removed: readonly string[],
  reason: InstructionRefreshReason,
): string {
  const reread = `Instruction files were re-read ${REFRESH_REASON_TEXT[reason]}`;
  const head =
    changed.length > 0
      ? `${reread}; these differ from their earlier copies — each replaces its earlier copy, and the instructions preamble above still applies:\n\n${changed.map(renderInstructionFile).join("\n\n")}`
      : `${reread}.`;
  return [head, ...removed.map((path) => `Instructions no longer present: ${path}`)].join("\n\n");
}

/**
 * 构建指令文件：正文去掉首尾空白，hash 在这里算一次。
 * 优化原因：持有的文件只在读取时变化，每次请求前对每个文件重新算 sha256 是纯浪费。
 */
export function createInstructionFile(path: string, type: string, body: string): InstructionFile {
  const trimmed = body.trim();
  return { path, type, body: trimmed, hash: createHash("sha256").update(trimmed).digest("hex") };
}

export function instructionFileRecord(
  file: InstructionFile,
): InstructionAnnouncement["files"][number] {
  return { path: file.path, type: file.type, hash: file.hash };
}

export function parseInstructionAnnouncement(value: unknown): InstructionAnnouncement | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { files, removed, reason } = value as Record<string, unknown>;
  if (!Array.isArray(files)) return undefined;
  const parsedFiles: InstructionAnnouncement["files"] = [];
  for (const file of files) {
    if (typeof file !== "object" || file === null) return undefined;
    const { path, type, hash } = file as Record<string, unknown>;
    if (typeof path !== "string" || typeof type !== "string" || typeof hash !== "string")
      return undefined;
    parsedFiles.push({ path, type, hash });
  }
  if (
    removed !== undefined &&
    (!Array.isArray(removed) || !removed.every((path) => typeof path === "string"))
  )
    return undefined;
  if (reason !== undefined && reason !== "session_start" && reason !== "compaction")
    return undefined;
  return {
    files: parsedFiles,
    ...(removed && removed.length > 0 ? { removed: [...(removed as string[])] } : {}),
    ...(reason ? { reason } : {}),
  };
}

const LEGACY_HEADING = new RegExp(
  `^Contents of (.+) \\((${[...INSTRUCTION_TYPES, ...LEGACY_INSTRUCTION_TYPES].map(escapeRegExp).join("|")})\\):$`,
  "gm",
);

/**
 * 没有 metadata 的旧完整公告：按标题行拆出文件。正文到下一个标题行为止，与新记录同样 trim 后取哈希。
 */
export function parseLegacyInstructionFiles(content: string): InstructionAnnouncement["files"] {
  const headings = [...content.matchAll(LEGACY_HEADING)];
  return headings.map((heading, index) => {
    const start = heading.index! + heading[0].length;
    const end = headings[index + 1]?.index ?? content.length;
    return instructionFileRecord(
      createInstructionFile(heading[1]!, heading[2]!, content.slice(start, end)),
    );
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
