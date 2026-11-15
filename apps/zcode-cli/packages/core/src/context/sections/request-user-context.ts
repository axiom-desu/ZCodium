// ============================================================
// Request User Context Section Builder
// ============================================================
// 上游 3.18.2 语义：指令文件是带 path/type/hash 的独立区块，`Contents of <path> (<type>):`
// 之后是正文；Memory 索引按 auto-memory 类型并入同一组文件。
// 已公告过时用 runtime 冻结的正文渲染（字节稳定），当前文件只用于统计与增量比较。

import { join } from "node:path";

import { formatProjectMemoryIndexContent } from "../../memory/index-content.js";
import type {
  ContextSection,
  InstructionFile,
  ResolvedUserInstructionSource,
  ResolvedUserInstructions,
} from "../types.js";
import { estimateTokens } from "../utils.js";
import {
  createInstructionFile,
  INSTRUCTION_TYPE_AUTO_MEMORY,
  INSTRUCTION_TYPE_PROJECT,
  INSTRUCTION_TYPE_USER,
  renderInstructionAnnouncement,
} from "./instruction-files.js";

export function buildRequestUserContextSection(input: {
  userInstructions?: ResolvedUserInstructions;
  memoryIndexContent?: string;
  memoryRoot?: string;
  /** 已公告的完整指令正文；在场时用它代替当前文件渲染。 */
  instructionAnnouncementContent?: string;
}): ContextSection | null {
  const instructionFiles = buildInstructionFiles(input);
  const content =
    input.instructionAnnouncementContent ??
    (instructionFiles.length > 0 ? renderInstructionAnnouncement(instructionFiles) : null);
  if (!content) {
    return null;
  }

  return {
    name: "Request User Context",
    source: "request_user_context",
    injectionTarget: "meta_user",
    cacheHint: "dynamic",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
    ...(instructionFiles.length > 0 ? { instructionFiles } : {}),
  };
}

/** 指令文件在前、Memory 索引在后；正文为空的文件不出现。 */
function buildInstructionFiles(input: {
  userInstructions?: ResolvedUserInstructions;
  memoryIndexContent?: string;
  memoryRoot?: string;
}): InstructionFile[] {
  const files = input.userInstructions
    ? normalizedInstructionSources(input.userInstructions).flatMap((source) => {
        const file = buildInstructionSourceFile(source);
        return file ? [file] : [];
      })
    : [];
  const memoryIndexFile = buildProjectMemoryIndexFile(input.memoryRoot, input.memoryIndexContent);
  if (memoryIndexFile) files.push(memoryIndexFile);
  return files;
}

function buildProjectMemoryIndexFile(
  memoryRoot: string | undefined,
  indexContent: string | undefined,
): InstructionFile | null {
  if (!memoryRoot || indexContent === undefined) return null;
  const formatted = formatProjectMemoryIndexContent(indexContent);
  if (!formatted) return null;

  return createInstructionFile(
    join(memoryRoot, "MEMORY.md"),
    INSTRUCTION_TYPE_AUTO_MEMORY,
    formatted,
  );
}

export function normalizedInstructionSources(
  instructions: ResolvedUserInstructions,
): ResolvedUserInstructionSource[] {
  if (instructions.sources && instructions.sources.length > 0) {
    return instructions.sources;
  }

  return [
    {
      scope: "workspace",
      filePath: instructions.filePath,
      fileName: instructions.fileName,
      content: instructions.content,
      bytesRead: instructions.bytesRead,
      sizeBytes: instructions.sizeBytes,
      truncated: instructions.truncated,
    },
  ];
}

function buildInstructionSourceFile(source: ResolvedUserInstructionSource): InstructionFile | null {
  const body = source.truncated
    ? `${source.content}\n\n[File truncated: ${source.fileName}]`
    : source.content;
  const trimmedBody = body.trim();
  if (!trimmedBody) {
    return null;
  }

  return createInstructionFile(
    source.filePath,
    source.scope === "user" ? INSTRUCTION_TYPE_USER : INSTRUCTION_TYPE_PROJECT,
    trimmedBody,
  );
}
