// 当前 turn 的 provider 可见工具面：主请求与 compact 续写必须读取同一份目录。
import { AUTOMATION_MUTATION_TOOL_NAMES } from "./turn-loop-state.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { isAutomationMutationRestrictedTurn } from "./turn-loop-state.js";
import type { AgentRuntimeInternal } from "../internal.js";

export function getTurnTools(runtime: AgentRuntimeInternal, state: RegularTurnLoopState) {
  const disallowed = buildTurnDisallowedTools(state);
  if (state.automationCreateLimitReached) return [];
  const tools = runtime.getTools(state.model);
  return disallowed ? tools.filter((tool) => !disallowed.has(tool.name)) : tools;
}

export function buildTurnDisallowedTools(state: RegularTurnLoopState): Set<string> | null {
  const tools = new Set(state.toolDisallowlist ?? []);
  if (isAutomationMutationRestrictedTurn(state)) {
    // 定时任务执行轮只应运行任务 prompt，不能反过来管理自己的定义。
    // 保留 CronList 供只读查询；所有 mutation 在 provider 请求边界统一隐藏。
    for (const toolName of AUTOMATION_MUTATION_TOOL_NAMES) {
      tools.add(toolName);
    }
  }
  return tools.size > 0 ? tools : null;
}
