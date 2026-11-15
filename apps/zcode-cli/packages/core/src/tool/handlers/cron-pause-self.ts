// ============================================================
// CronPauseSelf：暂停"触发本轮的那条 automation"
// ============================================================
// 目标身份只来自 executor 注入的本轮 automationId（Host 准入），不接受任何模型输入：
// 空严格输入 schema 让模型塞不进 id，也不能改定义。与 CronCreate/Update/Delete 的
// 「执行轮隐藏」不同，本工具是「非执行轮隐藏」（runtime 的 turn-tool-visibility）。

import {
  CoreErrorType,
  CronPauseSelfInputJsonSchema,
  CronPauseSelfInputSchema,
  CronPauseSelfOutputJsonSchema,
  CronPauseSelfOutputSchema,
  createCoreError,
  type CronPauseSelfOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import {
  assertAutomationPort,
  CRON_MODEL_BYTES,
  CRON_TOOL_TIMEOUT_MS,
  cronPermission,
  cronResultBudget,
  cronTimeout,
} from "./cron.js";

const cronPauseSelfHandler: ToolHandler = async (input, context) => {
  // 先校验身份再解析输入：普通用户轮、只有 denylist / queryId 兜底信号的轮都落在这里，
  // 任何路径都不会用模型输入或任务元数据反推目标。
  const automationId = context.automationId?.trim();
  if (!automationId) {
    throw createCoreError(
      CoreErrorType.PermissionDenied,
      "CronPauseSelf is only available while running a scheduled automation.",
      {
        context: { toolCallId: context.toolCallId, toolName: "CronPauseSelf" },
        recoverable: false,
        retryable: false,
      },
    );
  }
  CronPauseSelfInputSchema.parse(input);
  assertAutomationPort(context, "CronPauseSelf");
  // 宿主能力可缺失（旧 Host 没有 automation/pause）：明确报能力不支持，不返回假成功。
  const pause = context.automationPort.pause;
  if (!pause) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "AutomationPort does not support pause for CronPauseSelf",
      {
        context: { toolCallId: context.toolCallId, toolName: "CronPauseSelf" },
        recoverable: false,
        retryable: false,
      },
    );
  }

  const paused = await pause({ id: automationId });
  return {
    paused,
    id: automationId,
    message: paused
      ? `Paused automation ${automationId}. It will not run on schedule until the user resumes it.`
      : `Automation ${automationId} is not active (already paused, completed, failed, or deleted), so nothing changed.`,
  } satisfies CronPauseSelfOutput;
};

export const cronPauseSelfToolEntry: ToolEntry = {
  capability: "Pause the scheduled automation that triggered the current run",
  metadata: {
    shouldDefer: true,
    name: "CronPauseSelf",
    searchHint: "pause the automation that triggered this run",
    description:
      "Pause the scheduled automation that triggered the current run so it stops running on schedule until the user resumes it. It only targets the automation of this run, takes no input, and cannot change the automation definition.",
    modelInstructions: [
      "Call this only when the stop condition written in the automation prompt is met.",
      "Do not call it to skip a single run; finish the run normally instead.",
      "After pausing, briefly tell the user the automation was paused and why.",
    ],
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    timeoutMs: CRON_TOOL_TIMEOUT_MS,
    maxOutputBytes: CRON_MODEL_BYTES,
    sideEffectScope: "workspace",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: cronPauseSelfHandler,
  inputSchema: CronPauseSelfInputJsonSchema,
  outputSchema: CronPauseSelfOutputJsonSchema,
  runtimeInputSchema: CronPauseSelfInputSchema,
  runtimeOutputSchema: CronPauseSelfOutputSchema,
  permission: cronPermission(
    "automation.pause",
    "CronPauseSelf only pauses the automation that triggered the current run",
    false,
  ),
  resultBudget: cronResultBudget,
  timeout: cronTimeout,
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "CronPauseSelf was cancelled before the automation was paused",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
