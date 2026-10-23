// 后台任务生命周期提供者解析：按工具名决定快照/等待/取消分别由哪个端口承担。
// 缺省语义与泛化前逐字一致（无 provider → 无轮询、无直接等待、cancellable 恒 false）。

import type {
  DynamicWorkflowRunSnapshot,
  ExecutionPort,
  SubagentTaskSnapshot,
  WorkflowTaskSnapshot,
} from "@zcode/contracts";
import { isSubagentDispatchToolName } from "../compat.js";
import { isDynamicWorkflowRunDispatchToolName } from "./background-task-registry.js";
import type { ExecutableToolCall } from "../types.js";
import type { ToolExecutorDeps } from "./types.js";
import {
  getBackgroundTaskWaiter,
  getWorkflowTaskWaiter,
} from "./background-task-workflow-projection.js";

export type BackgroundTaskSnapshot =
  | NonNullable<Awaited<ReturnType<NonNullable<ExecutionPort["getBackgroundTask"]>>>>
  | SubagentTaskSnapshot
  | WorkflowTaskSnapshot
  // workflow run 的快照沿用 WorkflowTaskSnapshot 的形状但把 output 放宽成 unknown（产物由脚本
  // 的顶层返回值决定），所以它不是 WorkflowTaskSnapshot 的子类型，必须单列一支。
  | DynamicWorkflowRunSnapshot;

export type BackgroundTaskWaiter = {
  waitForBackgroundTask(
    taskId: string,
    options?: { signal?: AbortSignal },
  ): Promise<BackgroundTaskSnapshot | undefined>;
};

export type WorkflowTaskWaiter = {
  waitForTask(
    taskId: string,
    options?: { signal?: AbortSignal },
  ): Promise<BackgroundTaskSnapshot | undefined>;
};

/**
 * 一个工具的后台生命周期提供者。这五件事若按工具名散在五处 `if (toolCall.name === …)`，
 * 每接一个后台工具就要记得同时改齐五处——`canCancelBackgroundTask` 对 legacy `Workflow`
 * 硬返回 false 就会是漏改的现场：它让 started payload 的 cancellable 恒假，取消入口直接死掉。
 * 按工具名查一次表拿到这个结构，五处分派退化成读它的字段。
 *
 * 缺省语义（字段缺席）与泛化前逐字一致：无 getSnapshot → 无快照提供者（不起 1s 轮询）；
 * 无 waitForTerminal → 无直接等待者；cancellable 缺省 false。
 */
interface BackgroundTaskLifecycleProvider {
  /** 1s 轮询的快照源。 */
  getSnapshot?: (taskId: string) => Promise<BackgroundTaskSnapshot | undefined>;
  /** 终态直接等待者（比轮询更及时，且轮询源缺席时是唯一终态来源）。 */
  waitForTerminal?: (taskId: string) => Promise<BackgroundTaskSnapshot | undefined>;
  /** 运行中的任务是否可被用户取消；决定 started/updated payload 的 `cancellable`。 */
  cancellable?: boolean;
}

export function backgroundSnapshotSignature(snapshot: BackgroundTaskSnapshot): string {
  return JSON.stringify({
    pid: snapshot && "pid" in snapshot ? snapshot.pid : undefined,
    stderrBytes: snapshot && "stderrBytes" in snapshot ? snapshot.stderrBytes : undefined,
    stderrTail: snapshot && "stderrTail" in snapshot ? snapshot.stderrTail : undefined,
    stdoutBytes: snapshot && "stdoutBytes" in snapshot ? snapshot.stdoutBytes : undefined,
    stdoutTail: snapshot && "stdoutTail" in snapshot ? snapshot.stdoutTail : undefined,
  });
}

export function canCancelBackgroundTask(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
): boolean {
  return lifecycleProvider(deps, toolCall).cancellable === true;
}

export function isNotifiedLocalAgentSnapshot(
  toolCall: ExecutableToolCall,
  snapshot: BackgroundTaskSnapshot,
): boolean {
  const record = snapshot as unknown as Record<string, unknown>;
  return (
    isSubagentDispatchToolName(toolCall.name) &&
    record.type === "local_agent" &&
    record.notified === true
  );
}

export function hasBackgroundTaskSnapshotProvider(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
): boolean {
  return lifecycleProvider(deps, toolCall).getSnapshot !== undefined;
}

export function hasDirectBackgroundTaskWaiter(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
): boolean {
  return lifecycleProvider(deps, toolCall).waitForTerminal !== undefined;
}

export async function waitForBackgroundTaskSnapshot(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  taskId: string,
): Promise<BackgroundTaskSnapshot | undefined> {
  return lifecycleProvider(deps, toolCall).waitForTerminal?.(taskId);
}

export async function getBackgroundTaskSnapshot(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  taskId: string,
): Promise<BackgroundTaskSnapshot | undefined> {
  return lifecycleProvider(deps, toolCall).getSnapshot?.(taskId);
}

/**
 * 按工具名解析后台生命周期提供者。每个分支只描述"这个工具的四件事分别由哪个端口承担"，
 * 与泛化前的五处 if 一一对应，语义逐字保持。
 */
export function lifecycleProvider(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
): BackgroundTaskLifecycleProvider {
  if (isSubagentDispatchToolName(toolCall.name)) {
    const getTask = deps.subagentPort?.getTask;
    return {
      ...(getTask
        ? { getSnapshot: (taskId: string) => getTask.call(deps.subagentPort, taskId) }
        : {}),
      // background Agent 的停止入口在 subagentPort.stopTask；
      // started payload 不能沿用 Bash 的 executionPort 能力判断。
      cancellable: Boolean(deps.subagentPort?.stopTask),
    };
  }

  if (isDynamicWorkflowRunDispatchToolName(toolCall.name)) {
    // workflow run：快照/等待/取消全部来自窄端口 DynamicWorkflowRunPort（runId ≡ taskId ≡ workId）。
    // 取消能力以 cancel 方法存在为准，而不是硬编码——端口在场即可取消，这正是详情页
    // Cancel 按钮与后台面板停止共用的那条唯一路径的前提。CreateWorkflow（新启动）与
    // ResumeWorkflowRun（恢复）共用同一 provider：registry 条目重臂时经 existing 合并
    // 语义沿用原始工具行的 parentToolCallId，两条入口对 tracker 完全同构。
    const port = deps.dynamicWorkflowRunPort;
    if (port === undefined) return {};
    return {
      getSnapshot: (taskId: string) => port.getTask(taskId),
      ...(typeof port.waitForTask === "function"
        ? { waitForTerminal: (taskId: string) => port.waitForTask(taskId) }
        : {}),
      cancellable: typeof port.cancel === "function",
    };
  }

  if (toolCall.name === "Workflow") {
    // legacy Workflow：只有快照与等待，没有取消——停止入口从未接过（保持泛化前的 false）。
    const getTask = deps.workflowPort?.getTask;
    const waiter = getWorkflowTaskWaiter(deps.workflowPort);
    return {
      ...(getTask
        ? { getSnapshot: (taskId: string) => getTask.call(deps.workflowPort, taskId) }
        : {}),
      ...(waiter ? { waitForTerminal: (taskId: string) => waiter.waitForTask(taskId) } : {}),
      cancellable: false,
    };
  }

  if (toolCall.name === "Bash") {
    const waiter = getBackgroundTaskWaiter(deps.executionPort);
    const getBackgroundTask = deps.executionPort?.getBackgroundTask;
    return {
      ...(getBackgroundTask
        ? { getSnapshot: (taskId: string) => getBackgroundTask.call(deps.executionPort, taskId) }
        : {}),
      ...(waiter
        ? { waitForTerminal: (taskId: string) => waiter.waitForBackgroundTask(taskId) }
        : {}),
      cancellable: Boolean(deps.executionPort?.cancelBackgroundTask),
    };
  }

  // 其余工具沿用 executionPort 的通用后台面（无直接等待者），与泛化前一致。
  const getBackgroundTask = deps.executionPort?.getBackgroundTask;
  return {
    ...(getBackgroundTask
      ? { getSnapshot: (taskId: string) => getBackgroundTask.call(deps.executionPort, taskId) }
      : {}),
    cancellable: Boolean(deps.executionPort?.cancelBackgroundTask),
  };
}

export function isBackgroundTaskLaunch(
  toolCall: ExecutableToolCall,
  output: Record<string, unknown>,
): boolean {
  if (output.status === "backgrounded") return true;
  return isSubagentDispatchToolName(toolCall.name) && output.status === "async_launched";
}
