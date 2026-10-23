// Bash 执行请求构造：把工具入参与上下文投影成 execution adapter 的请求与 output 骨架。

import {
  SessionEventType,
  type BackgroundExecutionStartResult,
  type BashInput,
  type BashOutput,
  type ExecutionEvent,
  type ExecutionRequest,
  type ExecutionRunOptions,
  type TraceContext,
} from "@zcode/contracts";
import {
  shouldInjectEmbeddedSearchBashPrelude,
  supportsEmbeddedSearchShellSelection,
} from "../../embedded-search/shell.js";
import { resolveBashTimeoutMs, type BashTimeoutPolicy } from "../bash-timeout-policy.js";
import { resolveToolWorkingDirectory } from "../path-policy.js";
import type { ToolExecutionContext } from "../types.js";
import {
  createBashBackgroundPerformance,
  createEmptyBashPerformance,
  type BashProgressTiming,
} from "./bash-output.js";
import { attachToolExecutionPerformance } from "./tool-perf.js";

export const MAX_INLINE_OUTPUT_BYTES = 30_000;
const MAX_RUNTIME_PERSISTED_OUTPUT_BYTES = 5 * 1024 * 1024 * 1024;

export function emptyBashOutput(input: BashInput): BashOutput {
  return attachToolExecutionPerformance(
    {
      stdout: "",
      stderr: "",
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
      status: "completed",
      dangerouslyDisableSandbox: input.dangerouslyDisableSandbox,
    },
    createEmptyBashPerformance(),
  );
}

export function toBackgroundedBashOutput(
  task: BackgroundExecutionStartResult,
  input: BashInput,
): BashOutput {
  return attachToolExecutionPerformance(
    {
      stdout: "",
      stderr: "",
      interrupted: false,
      status: "backgrounded",
      backgroundTaskId: task.taskId,
      rawOutputPath: task.outputPath,
      persistedOutputPath: task.outputPath,
      stdoutPersistedOutputPath: task.stdoutPersistedOutputPath,
      stderrPersistedOutputPath: task.stderrPersistedOutputPath,
      dangerouslyDisableSandbox: input.dangerouslyDisableSandbox,
    },
    createBashBackgroundPerformance(input),
  );
}

export function createExecutionRunOptions(
  context: ToolExecutionContext,
  progressTiming?: BashProgressTiming,
): ExecutionRunOptions {
  return {
    signal: context.abortSignal,
    onEvent: async (event) => {
      if (event.type !== "progress") return;
      if (
        progressTiming &&
        progressTiming.firstOutputMs === undefined &&
        event.stdoutBytes + event.stderrBytes > 0
      ) {
        progressTiming.firstOutputMs = Math.max(0, Math.round(event.elapsedMs));
      }
      await emitProgressEvent(event, context);
    },
  };
}

async function emitProgressEvent(
  event: Extract<ExecutionEvent, { type: "progress" }>,
  context: ToolExecutionContext,
): Promise<void> {
  if (!context.emitEvent) return;

  await context.emitEvent({
    id: crypto.randomUUID() as any,
    sessionId: context.sessionId,
    turnId: context.turnId,
    type: SessionEventType.ToolCallProgress,
    timestamp: event.timestamp,
    traceId: context.traceId,
    sequenceNumber: 0,
    payload: {
      toolCallId: context.toolCallId,
      toolName: "Bash",
      elapsedMs: event.elapsedMs,
      pid: event.pid,
      stdoutBytes: event.stdoutBytes,
      stderrBytes: event.stderrBytes,
      outputBytes: event.stdoutBytes + event.stderrBytes,
      outputPreview: event.outputPreview,
      stdoutTail: event.stdoutTail,
      stderrTail: event.stderrTail,
    },
  });
}

export function createExecutionRequest(
  input: BashInput,
  context: ToolExecutionContext,
  timeoutPolicy: BashTimeoutPolicy,
): ExecutionRequest {
  const shellSelection = context.bashShellSelection;
  const bashPrelude =
    shouldInjectEmbeddedSearchBashPrelude() &&
    context.embeddedSearch?.enabled === true &&
    context.embeddedSearch.backend &&
    supportsEmbeddedSearchShellSelection(shellSelection)
      ? {
          kind: "embedded-search" as const,
          backend: context.embeddedSearch.backend,
          ...(context.embeddedSearch.findAndGrepEnabled === false
            ? { findAndGrepEnabled: false }
            : {}),
        }
      : undefined;
  return {
    command: {
      mode: "shell",
      command: input.command,
      shellProfile: "posix-bash",
      ...(shellSelection ? { shellOverride: shellSelection } : {}),
    },
    cwd: resolveToolWorkingDirectory(undefined, {
      operation: "execute",
      workingDirectory: context.workingDirectory,
      workspaceRoot: context.workspaceRoot,
    }),
    ...(bashPrelude ? { bashPrelude } : {}),
    captureCwdAfterSuccess: input.run_in_background ? undefined : true,
    timeoutMs: resolveBashTimeoutMs(input.timeout, timeoutPolicy),
    outputLimit: {
      maxInlineBytes: MAX_INLINE_OUTPUT_BYTES,
      maxBufferBytes: MAX_INLINE_OUTPUT_BYTES,
      maxPersistedBytes: MAX_RUNTIME_PERSISTED_OUTPUT_BYTES,
      persistOutput: input.run_in_background ? "always" : "on_truncate",
    },
    sandbox: {
      enabled: !input.dangerouslyDisableSandbox,
      dangerouslyDisableSandbox: input.dangerouslyDisableSandbox,
    },
    trace: {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      sessionId: context.sessionId,
      turnId: context.turnId,
      attributes: {
        toolCallId: context.toolCallId,
        toolName: "Bash",
      },
    } as unknown as TraceContext,
  };
}
