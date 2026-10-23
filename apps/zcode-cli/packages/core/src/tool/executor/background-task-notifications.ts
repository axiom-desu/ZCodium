// 后台任务完成通知的内容投影：把 task 终态快照拼成用户/模型可见的通知文本。
// registry 状态仍由 background-task-registry.ts 与 BackgroundTaskTracker 唯一持有。

import {
  traceContextToLogContext,
  type DynamicWorkflowRunStopReason,
  type TraceContext,
} from "@zcode/contracts";
import type { ExecutableToolCall } from "../types.js";
import type { ToolExecutorDeps } from "./types.js";
import { isRecord } from "./utils.js";
import { formatTaskNotification } from "../../runtime-task/notification.js";
import { describeWorkflowScriptPath } from "../handlers/workflow-script-path.js";
import {
  claimRuntimeBackgroundTaskNotification,
  isDynamicWorkflowRunDispatchToolName,
  releaseRuntimeBackgroundTaskNotification,
} from "./background-task-registry.js";
import { backgroundTaskOutputMetadata } from "./background-task-output.js";
import {
  buildWorkflowReportsNotificationSection,
  serializeWorkflowArtifact,
} from "./workflow-artifact.js";
import {
  buildWorkflowArtifactsNotificationSection,
  WORKFLOW_ARTIFACTS_NOTIFICATION_MAX_LINES,
} from "./workflow-published-artifacts.js";
import type { BackgroundTaskSnapshot } from "./background-task-providers.js";
import {
  workflowSnapshotArtifacts,
  workflowSnapshotReports,
  workflowSnapshotScriptPath,
  workflowSnapshotTerminal,
  workflowTaskSubject,
} from "./background-task-workflow-projection.js";
import {
  buildWorkflowNotificationOriginMeta,
  runtimeString,
  stringField,
  type WorkflowTerminalRunStatus,
} from "./background-task-workflow-projection.js";

export function maybeEnqueueBackgroundTaskNotification(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  taskId: string,
  status: string,
  snapshot: BackgroundTaskSnapshot | undefined,
  traceContext: TraceContext,
  output?: Record<string, unknown>,
): void {
  if (!deps.enqueueBackgroundTaskNotification) {
    deps.logger?.debug?.("Background task notification queue unavailable", {
      ...traceContextToLogContext(traceContext),
      event: "background_task.notification.queue_unavailable",
      module: "core.tool.executor",
      taskId,
      taskStatus: status,
      toolName: toolCall.name,
    });
    return;
  }

  // 被修订替代的 run 不发终态通知：
  // 停下它的那次 AmendWorkflow 的工具结果就是模型对这次停止的
  // 全部所知，再来一条「你停了 run A，现在去修订它」会把模型送进循环。仍然 claim：让稍后的
  // TaskOutput 读取不把它当成一条没送达的通知。
  if (workflowSnapshotTerminal(status, snapshot)?.stopReason === "superseded") {
    claimRuntimeBackgroundTaskNotification(deps, toolCall, taskId);
    deps.logger?.info?.("Background task notification suppressed: run superseded", {
      ...traceContextToLogContext(traceContext),
      event: "background_task.notification.suppressed",
      module: "core.tool.executor",
      reason: "workflow_run_superseded",
      taskId,
      taskStatus: status,
      toolName: toolCall.name,
    });
    return;
  }

  if (
    deps.shouldEnqueueBackgroundTaskNotification?.({
      runtimeScope: deps.runtimeScope,
      status,
      taskId,
      toolName: toolCall.name,
      traceContext,
    }) === false
  ) {
    deps.logger?.info?.("Background task notification suppressed by runtime policy", {
      ...traceContextToLogContext(traceContext),
      event: "background_task.notification.suppressed",
      module: "core.tool.executor",
      taskId,
      taskStatus: status,
      toolName: toolCall.name,
    });
    return;
  }

  const text = formatBackgroundTaskNotification(deps, toolCall, taskId, status, snapshot, output);
  if (!text) {
    deps.logger?.debug?.("Background task notification skipped without formatted message", {
      ...traceContextToLogContext(traceContext),
      event: "background_task.notification.skipped",
      module: "core.tool.executor",
      reason: "empty_message",
      taskId,
      taskStatus: status,
      toolName: toolCall.name,
    });
    return;
  }
  // TaskOutput 读取终态会先把同一 registry task 标成 notified；
  // completion 只有成功 claim 后才能入队，避免模型同时收到 tool result 和重复通知。
  if (!claimRuntimeBackgroundTaskNotification(deps, toolCall, taskId)) {
    deps.logger?.debug?.("Background task notification already claimed", {
      ...traceContextToLogContext(traceContext),
      event: "background_task.tracking.notification_already_handled",
      module: "core.tool.executor",
      taskId,
      taskStatus: status,
      toolName: toolCall.name,
    });
    return;
  }
  try {
    deps.enqueueBackgroundTaskNotification({
      ...(toolCall.name === "Bash"
        ? {
            originMeta: {
              backgroundSource: "bash" as const,
              title: resolveBashBackgroundResultTitle(toolCall, taskId),
              workId: taskId,
            },
          }
        : {}),
      // workflow run 的终态回合要渲染成后台结果头，而不是退化成一条裸 model-only 消息，
      // 所以 originMeta 必须带上（workId ≡ runId）。CreateWorkflow 与 ResumeWorkflowRun
      // 两个入口同构（分派见 isDynamicWorkflowRunDispatchToolName）。manifest 载荷
      // （workflowNotification）在此处发射侧铸造：GUI 渲染的唯一数据源，随 originMeta 走全管线。
      ...(isDynamicWorkflowRunDispatchToolName(toolCall.name)
        ? {
            originMeta: buildWorkflowNotificationOriginMeta(
              toolCall,
              taskId,
              status,
              snapshot,
              output,
            ),
          }
        : {}),
      taskId,
      text,
      toolName: toolCall.name,
      traceContext,
    });
  } catch (error) {
    releaseRuntimeBackgroundTaskNotification(deps, toolCall, taskId);
    deps.logger?.warn("Background task notification enqueue failed", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      module: "core.tool.executor",
      taskId,
    });
    return;
  }
  deps.logger?.info?.("Background task notification enqueued", {
    ...traceContextToLogContext(traceContext),
    event: "background_task.notification.enqueued",
    module: "core.tool.executor",
    taskId,
    taskStatus: status,
    toolName: toolCall.name,
  });
}

export function formatBackgroundTaskNotification(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  taskId: string,
  status: string,
  snapshot: BackgroundTaskSnapshot | undefined,
  output?: Record<string, unknown>,
): string | undefined {
  // workflow run 复用 legacy Workflow 的通知格式（复用 formatWorkflowTaskNotification）。
  // legacy "Workflow" 保持独立并列：它没有 dwf 的产物/reports 语义，只在共享格式器里
  // 走自己的 output.response 回退分支。
  if (toolCall.name === "Workflow" || isDynamicWorkflowRunDispatchToolName(toolCall.name)) {
    return formatWorkflowTaskNotification(deps, toolCall, taskId, status, snapshot, output);
  }
  if (toolCall.name !== "Bash") return undefined;

  const input = isRecord(toolCall.input) ? toolCall.input : {};
  const command = typeof input.command === "string" ? input.command : undefined;
  const description = typeof input.description === "string" ? input.description : undefined;
  const result = snapshot && "result" in snapshot ? snapshot.result : undefined;
  const outputMetadata = backgroundTaskOutputMetadata(snapshot, output);
  const notificationStatus = normalizeBashTaskNotificationStatus(status);
  const summary = buildBackgroundTaskSummary({
    command,
    description,
    exitCode: result?.exitCode,
    lost: status === "lost",
    status: notificationStatus,
  });
  return formatTaskNotification({
    description,
    outputFile: outputMetadata.outputFile,
    status: notificationStatus,
    summary,
    taskId,
    taskType: "local_bash",
    toolUseId: toolCall.id,
  });
}

function formatWorkflowTaskNotification(
  deps: ToolExecutorDeps,
  toolCall: ExecutableToolCall,
  taskId: string,
  status: string,
  snapshot: BackgroundTaskSnapshot | undefined,
  launchOutput?: Record<string, unknown>,
): string {
  const output =
    snapshot && "output" in snapshot && isRecord(snapshot.output) ? snapshot.output : launchOutput;
  const subject = workflowTaskSubject(toolCall, taskId, snapshot, output);
  const notificationStatus = normalizeBackgroundTaskNotificationStatus(status);
  // dwf 的三终态词与停止原因从快照读：run service 把
  // journal 里的 `stopReason` 投影到 `snapshot.stopReason`，所以「谁停的」不再只活在 registry。
  // registry 的 stopInitiator 只作兼容兜底（老端口 / stub 不发 stopReason 时）。
  const terminal = workflowSnapshotTerminal(status, snapshot);
  const stopReason =
    terminal?.stopReason ??
    (status === "cancelled" ? deps.runtimeTaskRegistry?.get(taskId)?.stopInitiator : undefined);
  const summary = buildWorkflowTaskSummary({
    lost: status === "lost",
    status: notificationStatus,
    runStatus: terminal?.runStatus,
    stopReason,
    subject,
  });
  // dwf 与 legacy `Workflow` 在**结果**这一项上分道：
  //   - dwf 的产物是脚本的任意顶层返回值，取 `snapshot.output` 原值并统一序列化，且**绝不**
  //     回退到 launch output——后者的 `response` 是「run 已在后台启动」的陈旧散文，
  //     回退过去比缺席更糟（桌面实测 bug 的第二种表现）。
  //   - legacy `Workflow` 的 `output.response` 真实存在，launchOutput 回退是它自己的契约，
  //     逐字节保留。
  // subject 仍走上面那个 record 门控的 output（展示名不涉及产物形状）。
  // dwf 分派名扩到 ResumeWorkflowRun：恢复的 run 与新启动的 run 在通知形状上同构。
  const result = isDynamicWorkflowRunDispatchToolName(toolCall.name)
    ? serializeWorkflowArtifact(snapshot && "output" in snapshot ? snapshot.output : undefined)
    : stringField(output, "response");
  // 渐进产物（`report(item)`）只属于 dwf：legacy `Workflow` 没有这个概念，它的通知逐字节不变。
  // **三个终态一律携带**（completed / failed / cancelled）：一个死在第 12 个 ask 上的 run
  // 仍然做完了 11 个 ask 的活，只报一句「失败」等于把它全扔了——那正是 report 存在的理由。
  // 条目来自 journal 的 kind="report" 行（run service 放在快照上），不是 memory-only 的投影。
  const isDynamicWorkflow = isDynamicWorkflowRunDispatchToolName(toolCall.name);
  const reports = isDynamicWorkflow
    ? buildWorkflowReportsNotificationSection(workflowSnapshotReports(snapshot))
    : undefined;
  // 用户面产物同样只属于 dwf（legacy `Workflow` 没有这个概念，通知逐字节不变）。三个终态
  // 一律携带：一个失败的 run 已经发布的产物仍然摆在用户面前，通知不提它，模型就会重述一遍。
  const artifacts = isDynamicWorkflow
    ? buildWorkflowArtifactsNotificationSection(
        workflowSnapshotArtifacts(snapshot),
        WORKFLOW_ARTIFACTS_NOTIFICATION_MAX_LINES,
      )
    : undefined;
  // 脚本文件同样只属于 dwf：呈现指引据它把
  // 下一步说成「就地编辑那个文件」。journal 存的是绝对路径，模型面给工作区相对写法——
  // 它接下来要 Edit 这个文件，而那正是它在别处读写文件时用的那一种路径。
  const scriptPath = isDynamicWorkflow ? workflowSnapshotScriptPath(snapshot) : undefined;
  return formatTaskNotification({
    description: subject,
    // 交付物呈现指引同样只属于 dwf。
    ...(isDynamicWorkflow ? { deliveryGuidance: true } : {}),
    ...(scriptPath === undefined
      ? {}
      : { scriptPath: describeWorkflowScriptPath(scriptPath, deps.getWorkingDirectory()) }),
    error: snapshot && "error" in snapshot ? runtimeString(snapshot.error) : undefined,
    ...(reports === undefined ? {} : { reports }),
    ...(artifacts === undefined ? {} : { artifacts }),
    result,
    status: notificationStatus,
    ...(terminal?.runStatus === undefined ? {} : { runStatus: terminal.runStatus }),
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(terminal?.failure === undefined ? {} : { failure: terminal.failure }),
    summary,
    taskId,
    taskType: "local_workflow",
    toolUseId: toolCall.id,
  });
}

type BashTaskNotificationStatus = "completed" | "failed" | "killed";

function normalizeBashTaskNotificationStatus(status: string): BashTaskNotificationStatus {
  return normalizeBackgroundTaskNotificationStatus(status);
}

function normalizeBackgroundTaskNotificationStatus(status: string): BashTaskNotificationStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "cancelled":
    case "timed_out":
    case "killed":
    case "stopped":
      return "killed";
    default:
      return "failed";
  }
}

function resolveBashBackgroundResultTitle(toolCall: ExecutableToolCall, taskId: string): string {
  const input = isRecord(toolCall.input) ? toolCall.input : {};
  const description = stringField(input, "description")?.trim();
  const command = stringField(input, "command")?.trim();
  return description || command || toolCall.name || taskId;
}

function buildBackgroundTaskSummary(input: {
  command?: string;
  description?: string;
  exitCode?: number;
  lost?: boolean;
  status: BashTaskNotificationStatus;
}): string {
  const subject = input.description ?? input.command ?? "Bash background command";
  const prefix = `Background command "${subject}"`;
  // Provider-visible summary 保持简洁；完整输出路径由 task-notification 的 output-file 字段承载。
  if (input.lost) return `${prefix} failed because its in-process state was lost`;
  switch (input.status) {
    case "completed":
      return `${prefix} completed${input.exitCode !== undefined ? ` (exit code ${input.exitCode})` : ""}`;
    case "failed":
      return `${prefix} failed${input.exitCode !== undefined ? ` with exit code ${input.exitCode}` : ""}`;
    case "killed":
      return `${prefix} was stopped`;
  }
}

function buildWorkflowTaskSummary(input: {
  lost?: boolean;
  status: BashTaskNotificationStatus;
  runStatus?: WorkflowTerminalRunStatus;
  stopReason?: DynamicWorkflowRunStopReason | undefined;
  subject: string;
}): string {
  const prefix = `Workflow "${input.subject}"`;
  if (input.lost) return `${prefix} failed because its in-process state was lost.`;
  // 一句话就要把「怎么结束的」说清：模型读 summary 比读 XML 字段更早。dwf 的三终态词优先；
  // legacy `Workflow` 不带 runStatus，落回追踪器的通用词。
  if (input.runStatus === "errored") return `${prefix} errored: the script failed.`;
  if (input.runStatus === "stopped" || input.status === "killed") {
    switch (input.stopReason) {
      case "user":
        return `${prefix} was stopped by the user.`;
      case "model":
        return `${prefix} was stopped by you (TaskStop).`;
      case "provider":
        return `${prefix} was stopped on a provider error.`;
      case "interrupted":
        return `${prefix} was stopped: the process that owned it exited.`;
      case "superseded":
        return `${prefix} was stopped and superseded by an amended run.`;
      default:
        return `${prefix} was stopped.`;
    }
  }
  return input.status === "completed" ? `${prefix} completed.` : `${prefix} failed.`;
}
