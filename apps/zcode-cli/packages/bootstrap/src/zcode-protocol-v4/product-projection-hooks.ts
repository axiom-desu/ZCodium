import {
  SessionEventType,
  type HookRunLifecyclePayload,
  type SessionEvent,
} from "@zcode/contracts";
import type { HookExecutionProjection, HookInvocationRow } from "@zcode/shared/zcode-protocol-v4";

const HOOK_SCRIPT_RUNNERS = new Set([
  "bash",
  "bun",
  "deno",
  "node",
  "node.exe",
  "powershell",
  "pwsh",
  "python",
  "python3",
  "ruby",
  "sh",
  "zsh",
]);

function unquoteHookDisplayToken(token: string): string {
  if (token.startsWith('"') && token.endsWith('"')) {
    try {
      return JSON.parse(token) as string;
    } catch {
      return token.slice(1, -1);
    }
  }
  if (token.startsWith("'") && token.endsWith("'")) return token.slice(1, -1);
  return token;
}

function hookCommandLabel(commandDisplay: string): string | undefined {
  const tokens = commandDisplay.match(/"(?:\\.|[^"])*"|'[^']*'|\S+/gu) ?? [];
  const executableToken = tokens[0];
  if (!executableToken) return undefined;
  const executable = unquoteHookDisplayToken(executableToken).split(/[\\/]/u).at(-1);
  if (!executable) return undefined;
  const scriptToken = tokens[1];
  if (!HOOK_SCRIPT_RUNNERS.has(executable.toLowerCase()) || !scriptToken) return executable;
  const script = unquoteHookDisplayToken(scriptToken);
  if (!script || script.startsWith("-")) return executable;
  const scriptName = script.split(/[\\/]/u).at(-1);
  return scriptName ? `${executable} · ${scriptName}` : executable;
}

export function hookExecutionDisplayName(
  descriptor: NonNullable<HookRunLifecyclePayload["descriptor"]>,
  hookIndex: number,
): string {
  const executable = hookCommandLabel(descriptor.commandDisplay);
  return (
    descriptor.statusMessage?.trim() ||
    (descriptor.pluginName && executable
      ? `${descriptor.pluginName} · ${executable}`
      : descriptor.pluginName || executable) ||
    `Hook #${hookIndex + 1}`
  );
}

export function hookExecutionState(
  eventType: SessionEvent["type"],
): HookExecutionProjection["state"] {
  if (eventType === SessionEventType.HookRunFailed) return "failed";
  if (
    eventType === SessionEventType.HookRunCompleted ||
    eventType === SessionEventType.HookRunBlocked
  ) {
    return "completed";
  }
  return "running";
}

export function hookExecutionOutcome(
  eventType: SessionEvent["type"],
  outcome: HookRunLifecyclePayload["outcome"],
): HookExecutionProjection["outcome"] {
  if (outcome) return outcome;
  if (eventType === SessionEventType.HookRunCompleted) return "success";
  if (eventType === SessionEventType.HookRunBlocked) return "blocked";
  if (eventType === SessionEventType.HookRunFailed) return "failed";
  return undefined;
}

export function hookInvocationState(
  executions: readonly HookExecutionProjection[],
  hookCount: number,
): HookInvocationRow["state"] {
  if (
    executions.length < hookCount ||
    executions.some((execution) => execution.state === "running")
  ) {
    return "running";
  }
  return executions.some((execution) => execution.state === "failed") ? "failed" : "completed";
}

export function hookInvocationLane(
  eventName: HookRunLifecyclePayload["hookEventName"],
): HookInvocationRow["lane"] {
  if (eventName === "PreToolUse" || eventName === "PermissionRequest") return "toolBefore";
  if (eventName === "PostToolUse" || eventName === "PostToolUseFailure") return "toolAfter";
  return "assistantWork";
}
