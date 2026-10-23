import type {
  BackgroundExecutionSnapshot,
  BackgroundTaskInfo,
  BackgroundTaskInfoStatus,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeBackgroundStopStatus } from "./background-stop-types.js";
import type { RuntimeTaskSnapshot, RuntimeTaskType } from "../../runtime-task/registry.js";

/**
 * BackgroundTaskInfo 的纯投影：把 runtime task snapshot / execution snapshot 映射成协议
 * payload，不写 registry、不发事件。任务生命周期与 stop 分派仍由 `background.ts` 拥有。
 */
export function buildBackgroundTaskPayload(
  this: AgentRuntimeInternal,
  taskId: string,
  existing: BackgroundTaskInfo | undefined,
  snapshot: BackgroundExecutionSnapshot | undefined,
  overrides: {
    cancelRequestedAt?: Date;
    cancellable?: boolean;
    completedAt?: Date;
    status?: BackgroundTaskInfoStatus;
  } = {},
): BackgroundTaskInfo {
  const result = snapshot?.result;
  const stdoutBytes = result?.stdout.bytes ?? snapshot?.stdoutBytes ?? existing?.stdoutBytes;
  const stderrBytes = result?.stderr.bytes ?? snapshot?.stderrBytes ?? existing?.stderrBytes;
  const stdoutTail = result?.stdout.text || snapshot?.stdoutTail || existing?.stdoutTail;
  const stderrTail = result?.stderr.text || snapshot?.stderrTail || existing?.stderrTail;
  const stdoutPersistedOutputPath =
    snapshot?.stdoutPersistedOutputPath ??
    result?.stdout.artifactPath ??
    existing?.stdoutPersistedOutputPath;
  const stderrPersistedOutputPath =
    snapshot?.stderrPersistedOutputPath ??
    result?.stderr.artifactPath ??
    existing?.stderrPersistedOutputPath;
  const outputBytes =
    stdoutBytes === undefined && stderrBytes === undefined
      ? existing?.outputBytes
      : (stdoutBytes ?? 0) + (stderrBytes ?? 0);
  const outputPath =
    snapshot?.outputPath ??
    stdoutPersistedOutputPath ??
    stderrPersistedOutputPath ??
    existing?.outputPath;
  const outputTruncated =
    result === undefined
      ? existing?.outputTruncated
      : result.stdout.truncated ||
        result.stderr.truncated ||
        result.stdout.artifactTruncated ||
        result.stderr.artifactTruncated;
  const status =
    overrides.status ??
    ((snapshot?.status ?? existing?.status ?? "lost") as BackgroundTaskInfoStatus);

  return {
    taskId,
    toolCallId: existing?.toolCallId,
    toolName: existing?.toolName,
    // 此构造器只服务 local Bash stop/update；Agent 终态由 subagent runner 产生。
    taskKind: "bash",
    blocked: existing?.blocked,
    blockedReason: existing?.blockedReason,
    cancellable: overrides.cancellable ?? (status === "running" && Boolean(snapshot)),
    cancelRequestedAt: overrides.cancelRequestedAt ?? existing?.cancelRequestedAt,
    command: existing?.command,
    description: existing?.description,
    status,
    pid: snapshot?.pid ?? result?.pid ?? existing?.pid,
    startedAt: snapshot?.startedAt ?? result?.startedAt ?? existing?.startedAt,
    completedAt: overrides.completedAt ?? snapshot?.completedAt ?? existing?.completedAt,
    outputPath,
    stderrPersistedOutputPath,
    stdoutPersistedOutputPath,
    outputBytes,
    outputTruncated,
    outputTail: stdoutTail ?? stderrTail ?? existing?.outputTail,
    stderrBytes,
    stderrTail,
    stdoutBytes,
    stdoutTail,
    terminalId: existing?.terminalId ?? taskId,
  };
}

export function backgroundInfoFromRuntimeTask(task: RuntimeTaskSnapshot): BackgroundTaskInfo {
  return {
    taskId: task.taskId,
    toolCallId: typeof task.parentToolCallId === "string" ? task.parentToolCallId : undefined,
    toolName: toolNameFromRuntimeTaskType(task.type),
    cancellable: task.status === "running",
    command: commandFromRuntimeTask(task, undefined),
    description: task.description,
    status: toBackgroundTaskInfoStatus(task.status) ?? "lost",
    pid: task.pid,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    outputPath: task.outputFile,
    terminalId: task.taskId,
  };
}

export function commandFromRuntimeTask(
  task: RuntimeTaskSnapshot | undefined,
  existing: BackgroundTaskInfo | undefined,
): string | undefined {
  // TaskStop 对 local_agent 返回短 description；旧 projection 的 command
  // 可能已保存为完整 prompt，因此运行时任务必须先于 existing.command 取值。
  if (task?.type === "local_agent") return task.description;
  if (!task && existing?.toolName === "Agent") return existing.description;
  if (existing?.command) return existing.command;
  if (task?.type === "local_bash") return task.description || task.prompt;
  return task?.prompt;
}

export function runtimeTaskTypeFromBackgroundInfo(
  task: BackgroundTaskInfo | undefined,
): RuntimeTaskType | undefined {
  switch (task?.toolName) {
    case "Bash":
      return "local_bash";
    case "Agent":
      return "local_agent";
    case "Workflow":
      return "local_workflow";
    case "CreateWorkflow":
    case "AmendWorkflow":
      return "local_dynamic_workflow";
    default:
      return undefined;
  }
}

function toolNameFromRuntimeTaskType(type: RuntimeTaskType): string {
  switch (type) {
    case "local_agent":
      return "Agent";
    case "local_bash":
      return "Bash";
    case "local_workflow":
      return "Workflow";
    case "local_dynamic_workflow":
      return "CreateWorkflow";
    case "monitor_mcp":
      return "Monitor";
  }
}

export function isTerminalBackgroundTaskInfoStatus(
  status: BackgroundTaskInfoStatus | undefined,
): boolean {
  return Boolean(status && status !== "running");
}

export function toBackgroundTaskInfoStatus(
  status: RuntimeBackgroundStopStatus | undefined,
): BackgroundTaskInfoStatus | undefined {
  switch (status) {
    case "cancelled":
    case "killed":
    case "stopped":
      return "cancelled";
    case "completed":
    case "failed":
    case "lost":
    case "running":
    case "spawn_error":
    case "timed_out":
      return status;
    default:
      return undefined;
  }
}
