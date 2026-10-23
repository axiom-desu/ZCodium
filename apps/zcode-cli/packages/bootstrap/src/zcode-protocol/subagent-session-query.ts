import { Buffer } from "node:buffer";
import {
  STREAM_RECOVERY_DISCARDED_ERROR_NAME,
  type BackgroundTaskInfo,
  type MessageWithParts,
  type SessionEvent,
  type SessionInfo,
  type SessionProjection,
} from "@zcode/contracts";
import type { ZCodeSessionEndedSubagent, ZCodeSessionRunningSubagent } from "@zcode/shared";
import { collectSubagentCandidates, type SubagentCandidate } from "./subagent-candidates.js";
import { asRecord, nonEmptyString, stringField } from "./record-values.js";

export { collectSubagentChildSessionIds } from "./subagent-candidates.js";

const CANCELLATION_PATTERN = /abort|cancel|interrupt|stop/i;

interface SessionSubagentProjection {
  revision: number;
  running: ZCodeSessionRunningSubagent[];
  ended: ZCodeSessionEndedSubagent[];
}

interface ProjectSessionSubagentsInput {
  revision: number;
  parentSession: SessionInfo;
  messages: readonly MessageWithParts[];
  childSessionsById: ReadonlyMap<string, SessionInfo>;
  childMessagesById: ReadonlyMap<string, readonly MessageWithParts[]>;
  childProjectionsById: ReadonlyMap<string, SessionProjection>;
  parentProjection?: SessionProjection;
  parentEvents?: readonly SessionEvent[];
}

function lastChildOutcome(messages: readonly MessageWithParts[] | undefined): {
  endedAt?: number;
  status?: "success" | "failed" | "cancelled";
  summary?: string;
} {
  if (!messages || messages.length === 0) return {};
  const assistantMessages = messages.filter((message) => message.info.role === "assistant");
  const last = assistantMessages.at(-1);
  if (!last || last.info.role !== "assistant") return {};
  // stream recovery 作废的半截 assistant 带 error 落盘，但子会话紧接着会从锚点
  // 重发；它是最后一条只说明恢复仍在进行或进程已退出，都不是「子会话失败」的终态。
  if (last.info.error && last.info.error.name === STREAM_RECOVERY_DISCARDED_ERROR_NAME) {
    return {};
  }
  const text = last.parts
    .flatMap((part) => (part.type === "text" && part.ignored !== true ? [part.text.trim()] : []))
    .filter(Boolean)
    .join("\n\n");
  const errorName = last.info.error?.name;
  const errorSummary = last.info.error
    ? (stringField(last.info.error.data ?? {}, "message", "error", "detail") ?? errorName)
    : undefined;
  const hasToolRound = last.parts.some((part) => part.type === "tool");
  return {
    ...(last.info.time.completed ? { endedAt: last.info.time.completed } : {}),
    ...(text || errorSummary ? { summary: text || errorSummary } : {}),
    ...(errorName
      ? { status: CANCELLATION_PATTERN.test(errorName) ? "cancelled" : "failed" }
      : // assistant 发出 tool call 后，该 model step 也会写 completed/finish；
        // 但 child session 仍在执行 Bash 等工具，不能把“本轮结束”当成“子会话终态”。
        // 只有不含 tool part 的最终 assistant message 才能提供成功 outcome。
        !hasToolRound && (last.info.time.completed || last.info.finish)
        ? { status: "success" }
        : {}),
  };
}

function findBackgroundTask(
  projection: SessionProjection | undefined,
  candidate: SubagentCandidate,
): BackgroundTaskInfo | undefined {
  return projection?.backgroundTasks.find(
    (task) =>
      task.taskKind === "subagent" &&
      (task.childSessionId === candidate.childSessionId ||
        task.toolCallId === candidate.part.callID ||
        task.taskId === candidate.agentId),
  );
}

function runningStatus(input: {
  background?: BackgroundTaskInfo;
  candidate: SubagentCandidate;
  childOutcome: ReturnType<typeof lastChildOutcome>;
  childProjection?: SessionProjection;
  parentProjection?: SessionProjection;
}): ZCodeSessionRunningSubagent["status"] | undefined {
  if (input.background?.status === "running") {
    return input.background.blocked ? "blocked" : "running";
  }
  if (input.childProjection?.status === "waiting") return "waiting";
  if (input.childProjection?.status === "running") return "running";
  // async Agent 的父 tool part 在 launch ACK 后立即标成 completed，
  // partial parent projection 又可能暂时不带仍运行的 background task。此时仅按
  // tool part 会把 child 误判为 ended，并在 cold seed 时清空 V4 running 行。
  // child 还没有终态输出、spawn relation 也没有 stop 时，background input 本身
  // 是可恢复的 running 事实；真实终态仍由 background/child projection/outcome 优先。
  if (
    input.candidate.runInBackground &&
    input.background === undefined &&
    input.childProjection === undefined &&
    input.candidate.stoppedStatus === undefined &&
    input.childOutcome.status === undefined
  ) {
    return "running";
  }
  if (
    input.parentProjection?.activeToolCalls.some(
      (tool) =>
        tool.toolCallId === input.candidate.part.callID &&
        (tool.status === "pending" || tool.status === "running"),
    )
  ) {
    return "running";
  }
  return input.parentProjection &&
    (input.candidate.part.state.status === "pending" ||
      input.candidate.part.state.status === "running")
    ? "running"
    : undefined;
}

function terminalBackgroundStatus(
  task: BackgroundTaskInfo | undefined,
): ZCodeSessionEndedSubagent["status"] | undefined {
  switch (task?.status) {
    case "completed":
      return "success";
    case "cancelled":
      return "cancelled";
    case "failed":
    case "timed_out":
    case "spawn_error":
      return "failed";
    case "lost":
      return "lost";
    default:
      return undefined;
  }
}

function endedStatus(input: {
  background?: BackgroundTaskInfo;
  candidate: SubagentCandidate;
  childOutcome: ReturnType<typeof lastChildOutcome>;
  childProjection?: SessionProjection;
}): ZCodeSessionEndedSubagent["status"] {
  const backgroundStatus = terminalBackgroundStatus(input.background);
  if (backgroundStatus) return backgroundStatus;
  if (input.childProjection?.status === "error") return "failed";
  if (input.childProjection?.status === "completed") return "success";
  if (input.candidate.part.state.status === "error") {
    return CANCELLATION_PATTERN.test(input.candidate.part.state.error) ? "cancelled" : "failed";
  }
  if (input.candidate.stoppedStatus) return input.candidate.stoppedStatus;
  const outputStatus = stringField(input.candidate.output ?? {}, "status");
  if (outputStatus === "cancelled" || outputStatus === "stopped") return "cancelled";
  if (outputStatus === "failed" || outputStatus === "error") return "failed";
  if (outputStatus === "async_launched") return input.childOutcome.status ?? "lost";
  if (input.candidate.part.state.status === "completed") return "success";
  return input.childOutcome.status ?? "lost";
}

function startedAt(
  candidate: SubagentCandidate,
  background?: BackgroundTaskInfo,
): number | undefined {
  if (background?.startedAt) return background.startedAt.getTime();
  if (candidate.startedAt !== undefined) return candidate.startedAt;
  return "time" in candidate.part.state ? candidate.part.state.time.start : undefined;
}

export function projectSessionSubagents(
  input: ProjectSessionSubagentsInput,
): SessionSubagentProjection {
  const running: ZCodeSessionRunningSubagent[] = [];
  const ended: ZCodeSessionEndedSubagent[] = [];
  for (const candidate of collectSubagentCandidates(
    input.parentSession,
    input.messages,
    input.parentEvents,
  )) {
    const childSession = input.childSessionsById.get(candidate.childSessionId);
    if (!childSession || childSession.taskType !== "subagent_child") continue;
    const childProjection = input.childProjectionsById.get(candidate.childSessionId);
    const background = findBackgroundTask(input.parentProjection, candidate);
    const childOutcome = lastChildOutcome(input.childMessagesById.get(candidate.childSessionId));
    const liveStatus = runningStatus({
      background,
      candidate,
      childOutcome,
      childProjection,
      parentProjection: input.parentProjection,
    });
    const common = {
      childSessionId: candidate.childSessionId,
      ...(candidate.agentId ? { agentId: candidate.agentId } : {}),
      toolCallId: candidate.part.callID,
      subagentType: candidate.subagentType,
      title: candidate.title,
      ...(startedAt(candidate, background) !== undefined
        ? { startedAt: startedAt(candidate, background) }
        : {}),
    };
    if (liveStatus) {
      running.push({ ...common, status: liveStatus });
      continue;
    }
    const stateEndedAt =
      "time" in candidate.part.state && "end" in candidate.part.state.time
        ? candidate.part.state.time.end
        : undefined;
    ended.push({
      ...common,
      status: endedStatus({ background, candidate, childOutcome, childProjection }),
      ...(candidate.summary || childOutcome.summary
        ? { summary: candidate.summary ?? childOutcome.summary }
        : {}),
      endedAt:
        background?.completedAt?.getTime() ??
        candidate.stoppedAt ??
        stateEndedAt ??
        childOutcome.endedAt ??
        childSession.time.updated,
    });
  }
  running.sort(
    (left, right) =>
      (right.startedAt ?? 0) - (left.startedAt ?? 0) ||
      right.childSessionId.localeCompare(left.childSessionId),
  );
  ended.sort(
    (left, right) =>
      (right.endedAt ?? 0) - (left.endedAt ?? 0) ||
      right.childSessionId.localeCompare(left.childSessionId),
  );
  return { revision: input.revision, running, ended };
}

function encodeCursor(item: ZCodeSessionEndedSubagent): string {
  return Buffer.from(
    JSON.stringify({ childSessionId: item.childSessionId, endedAt: item.endedAt ?? 0 }),
  ).toString("base64url");
}

function decodeCursor(cursor: string | undefined): {
  childSessionId: string;
  endedAt: number;
} | null {
  if (!cursor) return null;
  try {
    const value = asRecord(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown,
    );
    const childSessionId = nonEmptyString(value.childSessionId);
    const endedAt = value.endedAt;
    return childSessionId && typeof endedAt === "number" ? { childSessionId, endedAt } : null;
  } catch {
    return null;
  }
}

export function paginateEndedSubagents(
  ended: readonly ZCodeSessionEndedSubagent[],
  options: { cursor?: string; limit: number },
): { items: ZCodeSessionEndedSubagent[]; nextCursor?: string } {
  const cursor = decodeCursor(options.cursor);
  const start = cursor
    ? ended.findIndex(
        (item) =>
          (item.endedAt ?? 0) < cursor.endedAt ||
          ((item.endedAt ?? 0) === cursor.endedAt &&
            item.childSessionId.localeCompare(cursor.childSessionId) < 0),
      )
    : 0;
  if (start < 0) return { items: [] };
  const items = ended.slice(start, start + options.limit);
  const last = items.at(-1);
  return {
    items,
    ...(last && start + items.length < ended.length ? { nextCursor: encodeCursor(last) } : {}),
  };
}
