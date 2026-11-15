// ============================================================
// Hook `onError: "deny"` 的失败处置判定
// ============================================================
// 从 runner 拆出：runner 已接近 max-lines 上限，这里只放"hook 出错时要不要拦"的纯判定，
// 不持有状态、不发事件，方便单独读与单独测。

import { HookEventName, HookOnError, HookOutcome, type HookJSONOutput } from "@zcode/contracts";
import { sanitizeHookDisplayText } from "./display-metadata.js";
import type { HookRegistration } from "./types.js";
import type { HookInput } from "@zcode/contracts";

/**
 * `onError: "deny"` 只在 PreToolUse 上、且 hook 真的运行过并出错时生效。用户中断不算出错：
 * 把它变成拦截，会让「取消」看起来像策略拒绝。返回拦截理由；不拦截时返回 undefined。
 */
export function resolveDenyOnErrorReason(
  hook: HookRegistration,
  input: HookInput,
  outcome: HookOutcome,
  errorMessage: string,
): string | undefined {
  if (hook.onError !== HookOnError.Deny) return undefined;
  if (input.hookEventName !== HookEventName.PreToolUse) return undefined;
  if (outcome === HookOutcome.Cancelled) return undefined;
  return sanitizeHookDisplayText(
    `PreToolUse hook failed and its onError is "deny", so the tool call is blocked: ${errorMessage}`,
  );
}

/** 与退出码 2 的拦截同形（configured-runner-callback.ts 的 createExitCodeBlockOutput）。 */
export function preToolUseDenyOutput(reason: string): HookJSONOutput {
  return {
    continue: false,
    reason,
    hookSpecificOutput: {
      hookEventName: HookEventName.PreToolUse,
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}
