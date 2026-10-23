// Hook callback 结果的解包与诊断清洗：纯转换，不持有状态。

import type { HookCallbackDiagnostics, HookCallbackResult } from "./types.js";
import type { HookJSONOutput } from "@zcode/contracts";
import { sanitizeHookDisplayText } from "./display-metadata.js";

export function unwrapHookCallbackResult(result: HookJSONOutput | HookCallbackResult | void): {
  output: HookJSONOutput | undefined;
  diagnostics: HookCallbackDiagnostics | undefined;
} {
  if (isHookCallbackResult(result)) {
    return { output: result.output, diagnostics: result.diagnostics };
  }
  return { output: result as HookJSONOutput | undefined, diagnostics: undefined };
}

function isHookCallbackResult(value: unknown): value is HookCallbackResult {
  return Boolean(
    value &&
    typeof value === "object" &&
    "kind" in value &&
    (value as { kind?: unknown }).kind === "hookCallbackResult",
  );
}

export function sanitizeHookDiagnostics(
  diagnostics: HookCallbackDiagnostics | undefined,
): HookCallbackDiagnostics | undefined {
  if (!diagnostics) return undefined;
  const sanitize = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed ? sanitizeHookDisplayText(trimmed).slice(0, 4000) : undefined;
  };
  const errorMessage = sanitize(diagnostics.errorMessage);
  const stderrPreview = sanitize(diagnostics.stderrPreview);
  const stdoutPreview = sanitize(diagnostics.stdoutPreview);
  if (!errorMessage && !stderrPreview && !stdoutPreview) return undefined;
  return {
    ...(errorMessage ? { errorMessage } : {}),
    ...(stderrPreview ? { stderrPreview } : {}),
    ...(stdoutPreview ? { stdoutPreview } : {}),
  };
}
