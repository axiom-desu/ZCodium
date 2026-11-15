// 后台 subagent 停滞提醒的正文与轮标题。规格：.agents/specs/upstream-3.18-context-projection.md §2.3。
//
// 刻意不用 `<task-notification>`：App 把带 tool-use-id 的该标签读成 Agent 终态，
// 不认识的 status 会落成「已完成」。措辞要让模型能判断、且不引导它草率停掉合理的长任务。
import { escapeXml, truncateTaskNotification } from "../runtime-task/notification.js";
import type { BackgroundSubagentStallReminder } from "./background-stall.js";

const TOOL_SUMMARY_MAX_CHARS = 200;
/** 提醒里的任务描述（XML、正文、轮标题共用）：Agent 入参的 description 没有硬上限。 */
const DESCRIPTION_MAX_CHARS = 200;
/** 提醒里列出的在途工具个数；其余只给个数，避免并行工具很多时提醒无限变长。 */
const RUNNING_TOOLS_MAX = 5;

const SYSTEM_NOTIFICATION_BANNER = [
  "[SYSTEM NOTIFICATION - NOT USER INPUT]",
  "This is an automated status report about a background agent, NOT a message from the user.",
  "Do NOT interpret this as user acknowledgement, confirmation, or response to any pending question.",
  "",
] as const;

/** 提醒与轮标题里使用的任务描述：单行、有上限。 */
export function backgroundSubagentStallDescription(description: string): string {
  return singleLine(description, DESCRIPTION_MAX_CHARS) || "Subagent";
}

function singleLine(value: string, maxChars: number): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line;
}

export function toolInputSummary(input: unknown): string | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const value = ["command", "description", "file_path", "path", "pattern", "url", "prompt"]
    .map((key) => record[key])
    .find(
      (candidate): candidate is string => typeof candidate === "string" && candidate.trim() !== "",
    );
  if (!value) return undefined;
  return singleLine(value, TOOL_SUMMARY_MAX_CHARS);
}

/** 给模型的报告正文。 */
export function formatBackgroundSubagentStallNotification(
  reminder: BackgroundSubagentStallReminder,
): string {
  // description、工具名与摘要来自 Agent 入参和 child 模型生成的工具入参：XML 块和正文里都转义，
  // 描述限长，整条再按标准通知上限截断。
  const description = escapeXml(backgroundSubagentStallDescription(reminder.description));
  const agentId = escapeXml(reminder.agentId);
  const tools = [...reminder.runningTools].sort((a, b) => b.runningForMs - a.runningForMs);
  const listed = tools.slice(0, RUNNING_TOOLS_MAX);
  const lines: string[] = [
    ...SYSTEM_NOTIFICATION_BANNER,
    "<background-agent-stall>",
    `  <task-id>${agentId}</task-id>`,
    `  <description>${description}</description>`,
    `  <running-for-ms>${Math.floor(reminder.runningForMs)}</running-for-ms>`,
    `  <no-progress-for-ms>${Math.floor(reminder.noProgressForMs)}</no-progress-for-ms>`,
    `  <last-progress-at>${new Date(reminder.lastProgressAt).toISOString()}</last-progress-at>`,
  ];
  for (const tool of listed) {
    lines.push(
      `  <running-tool name="${escapeXml(tool.toolName)}" running-for-ms="${Math.floor(tool.runningForMs)}">${escapeXml(tool.summary ?? "")}</running-tool>`,
    );
  }
  if (tools.length > listed.length) {
    lines.push(`  <more-running-tools>${tools.length - listed.length}</more-running-tools>`);
  }
  lines.push(
    `  <next-report-in-ms>${Math.floor(reminder.nextReportInMs)}</next-report-in-ms>`,
    "</background-agent-stall>",
    "",
    `Background agent "${description}" (${agentId}) has been running for ${minutes(reminder.runningForMs)} and has made no progress for ${minutes(reminder.noProgressForMs)}: no new model request and no tool call has finished.`,
  );
  const [longest] = tools;
  if (longest) {
    lines.push(
      `It is inside ${escapeXml(longest.toolName)}, which has been running for ${minutes(longest.runningForMs)}${longest.summary ? `: ${escapeXml(longest.summary)}` : ""}.`,
    );
  }
  lines.push(
    "This is a status report, not a failure. Test suites, builds, simulations and polling loops with sleep often run this long or longer.",
    `If that fits what the agent is doing, do nothing and end your turn; if it is still quiet, the next report comes in about ${minutes(reminder.nextReportInMs)}.`,
    "Stop it with TaskStop only if you have a concrete reason to think it is stuck (for example, it waits for input that will never arrive). TaskOutput with block=false shows its current activity. Tell the user if they are waiting on it.",
  );
  return truncateTaskNotification(lines.join("\n"));
}

function minutes(ms: number): string {
  const value = Math.max(1, Math.round(ms / 60_000));
  if (value < 120) return `${value} minute${value === 1 ? "" : "s"}`;
  const hours = Math.round((value / 60) * 10) / 10;
  return `${hours} hours`;
}
