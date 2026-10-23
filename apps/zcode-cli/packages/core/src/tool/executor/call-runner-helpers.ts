// call-runner 的纯投影辅助：模型输出 entry 收敛、空工具名与 PreToolUse 上下文追加。

import { OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION } from "@zcode/zcode-cua/frame-contract";
import { hasOfficialCuaFrameAuthority } from "../../mcp/image-normalization.js";
import type { ToolEntry, ToolExecutionResult } from "../types.js";
import { formatHookAdditionalContexts } from "./hook-flow.js";

export function resolveModelOutputEntry(entry: ToolEntry, output: unknown): ToolEntry {
  const isSharedNodeRepl =
    entry.metadata.name === "mcp__node_repl__js" ||
    entry.metadata.mcpPresentation?.serverName === "node_repl";
  if (
    entry.modelContentProtection === OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION ||
    !isSharedNodeRepl ||
    !hasOfficialCuaFrameAuthority(output)
  ) {
    return entry;
  }
  return {
    ...entry,
    modelContentProtection: OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
    resultBudget: {
      ...entry.resultBudget,
      maxInlineBytes: Math.max(entry.resultBudget.maxInlineBytes, 256 * 1024),
      maxModelBytes: Math.max(entry.resultBudget.maxModelBytes, 256 * 1024),
      strategy: "truncate",
      preview: { direction: "head" },
    },
  };
}

export function isEmptyToolName(toolName: string): boolean {
  return toolName.trim().length === 0;
}

export function appendPreToolAdditionalContextsToErrorResult(
  result: ToolExecutionResult,
  additionalContexts: string[],
): ToolExecutionResult {
  if (result.success || !result.error || additionalContexts.length === 0) return result;

  // PreToolUse deny 和权限拒绝会在 handler 前提前返回，旧逻辑只在 handler 的
  // 成功/异常路径追加 context，导致 Hook 明明返回了 additionalContext，模型却看不到。
  const baseModelContent =
    typeof result.modelContent === "string" ? result.modelContent : result.error.message;
  return {
    ...result,
    modelContent: [baseModelContent, formatHookAdditionalContexts(additionalContexts)].join("\n\n"),
  };
}
