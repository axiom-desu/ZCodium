import {
  DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
  type AppSettings,
  type ZCodeSessionRuntimePreferencesResult,
  type ZCodeSessionRuntimePreferencesScope,
} from "@zcode/shared";

/**
 * Host 侧「新建/冷恢复会话」偏好的唯一构造点（本地 Host 与远端 Host 同源）。
 *
 * 这些值在 session 物化时一次性写进 runtimeConfig，运行中的会话不会被改写：
 *   - `toolSearchMode` 只在新建/冷恢复时读取，热 resume 保持原值；缺省 Off。
 *   - `integratedTerminalShell` 只对 user-execution 作用域生效（共享作用域是统一 result schema
 *     的兼容占位，不会覆盖 runtime-materialization 阶段已经固定的策略）。
 *
 * 放在这里而不是两个装配点各写一份：本地与远端 Host 的偏好字节一旦漂移，
 * 同一次设置改动会在两条链路上表现不同。
 */
export function buildHostSessionRuntimePreferences(input: {
  settings: Pick<
    AppSettings,
    | "askUserQuestionAutoResolutionEnabled"
    | "nativeSearchEnhancementsEnabled"
    | "toolSearchMode"
    | "memoryEnabled"
    | "integratedTerminalShell"
  >;
  scope: ZCodeSessionRuntimePreferencesScope;
}): ZCodeSessionRuntimePreferencesResult {
  const { settings, scope } = input;
  return {
    askUserQuestionAutoResolutionEnabled: settings.askUserQuestionAutoResolutionEnabled !== false,
    nativeSearchEnhancementsEnabled: settings.nativeSearchEnhancementsEnabled !== false,
    toolSearchMode: settings.toolSearchMode ?? "off",
    memoryEnabled: settings.memoryEnabled === true,
    modelContextBudgetStrategy: DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
    ...(scope === "user-execution" && settings.integratedTerminalShell
      ? { integratedTerminalShell: settings.integratedTerminalShell }
      : {}),
  };
}
