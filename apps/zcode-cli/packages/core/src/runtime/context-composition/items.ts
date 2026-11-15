// 技能与指令文件的条目（名字与元数据大小）。类别大小按请求里公告的真实文本计，这里只出明细。
import { join } from "node:path";
import { normalizedInstructionSources } from "../../context/sections/request-user-context.js";
import { estimateTokens } from "../../context/utils.js";
import { formatProjectMemoryIndexContent } from "../../memory/index-content.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { ContextCompositionNamedSize } from "./classifier.js";

/** memory 索引文件的规范名（与 request-user-context 的 MEMORY.md 区块同名）。 */
const MEMORY_INDEX_FILE_NAME = "MEMORY.md";

export function collectContextCompositionItems(runtime: AgentRuntimeInternal): {
  skillItems: ContextCompositionNamedSize[];
  instructionItems: ContextCompositionNamedSize[];
} {
  return {
    skillItems: runtime.buildSkillUsageDetails().map((skill) => ({
      name: skill.name,
      chars: skill.chars,
      tokens: skill.tokens,
    })),
    instructionItems: collectInstructionItems(runtime),
  };
}

function collectInstructionItems(runtime: AgentRuntimeInternal): ContextCompositionNamedSize[] {
  const instructions = runtime.contextSourceSnapshot?.userInstructions;
  const items: ContextCompositionNamedSize[] = instructions
    ? normalizedInstructionSources(instructions)
        .filter((source) => source.content.trim().length > 0)
        .map((source) => sizedItem(source.filePath || source.fileName, source.content))
    : [];
  if (runtime.memoryRoot && runtime.memoryIndexContent !== undefined) {
    const formatted = formatProjectMemoryIndexContent(runtime.memoryIndexContent);
    if (formatted)
      items.push(sizedItem(join(runtime.memoryRoot, MEMORY_INDEX_FILE_NAME), formatted));
  }
  return items;
}

function sizedItem(name: string, content: string): ContextCompositionNamedSize {
  return { name, chars: content.length, tokens: estimateTokens(content) };
}
