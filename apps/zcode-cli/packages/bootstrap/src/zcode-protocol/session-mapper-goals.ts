import type {
  ZCodeSessionGoal,
  ZCodeSessionGoalVerification,
  ZCodeSessionGoalVerificationTimeline,
} from "@zcode/shared";
import { EventReducer, SessionEventType } from "@zcode/contracts";
import type {
  GoalCompletionVerificationOutput,
  MessageWithParts,
  SessionEvent,
  SessionGoal,
  SessionInfo,
  SessionProjection,
} from "@zcode/contracts";
import { compareMessagesByCreatedTime } from "./session-mapper-goal-stats.js";
import { normalizeTodoContent } from "./session-mapper-todos.js";
import { asRecord, stringValue } from "./session-mapper-values.js";

export function mapGoalVerifications(
  verifications: SessionProjection["targetCompletionVerifications"] | undefined,
): ZCodeSessionGoalVerification[] {
  return (verifications ?? []).map((verification) => ({
    nextAction: verification.nextAction ?? null,
    passed: verification.passed,
    reason: verification.reason,
  }));
}

export function mapGoalVerificationTimeline(
  timeline: SessionProjection["targetCompletionVerificationTimeline"] | undefined,
): ZCodeSessionGoalVerificationTimeline[] {
  return (timeline ?? []).map((item) => ({
    version: 1,
    kind: "synthetic",
    type: "goal_verification",
    display: "separator",
    targetId: item.targetId,
    verificationId: item.verificationId,
    status: item.status,
    ...(item.goalIteration ? { goalIteration: item.goalIteration } : {}),
    ...(item.anchorAssistantMessageId
      ? { anchorAssistantMessageId: item.anchorAssistantMessageId }
      : {}),
    ...(item.anchorTurnId ? { anchorTurnId: item.anchorTurnId } : {}),
    ...(item.verification
      ? {
          verification: {
            nextAction: item.verification.nextAction ?? null,
            passed: item.verification.passed,
            reason: item.verification.reason,
          },
        }
      : {}),
    ...(item.startedAt ? { startedAt: item.startedAt.getTime() } : {}),
    updatedAt: item.updatedAt.getTime(),
  }));
}

export function mergePersistedGoalVerificationEvents(
  projection: SessionProjection,
  events: readonly SessionEvent[],
  target?: SessionGoal | null,
): SessionProjection {
  if (events.length === 0) {
    return projection;
  }

  const baseProjection = {
    ...projection,
    targetCompletionVerifications: projection.targetCompletionVerifications ?? [],
    targetCompletionVerificationTimeline: projection.targetCompletionVerificationTimeline ?? [],
  };
  const targetId = target?.targetID ?? projection.target?.targetID;
  const reducer = new EventReducer();
  const restored = [...events]
    .filter((event) => event.type === SessionEventType.TargetCompletionVerification)
    .filter((event) => {
      const payload = asRecord(event.payload);
      const eventTargetId = stringValue(payload.targetId);
      return !targetId || !eventTargetId || eventTargetId === targetId;
    })
    .sort(compareEventsByTimelineTime)
    .reduce((current, event) => reducer.apply(current, event), baseProjection);
  const timeline = getTargetGoalVerificationTimeline(restored, target).sort(
    compareGoalVerificationTimeline,
  );
  return {
    ...restored,
    targetCompletionVerificationTimeline: timeline,
    targetCompletionVerifications: mergeGoalVerificationSummaries(
      restored.targetCompletionVerifications,
      timeline,
    ),
  };
}

function compareEventsByTimelineTime(left: SessionEvent, right: SessionEvent): number {
  const byTime = left.timestamp.getTime() - right.timestamp.getTime();
  if (byTime !== 0) return byTime;
  return left.sequenceNumber - right.sequenceNumber;
}

function mergeGoalVerificationSummaries(
  verifications: readonly GoalCompletionVerificationOutput[],
  timeline: readonly SessionProjection["targetCompletionVerificationTimeline"][number][],
): GoalCompletionVerificationOutput[] {
  const result: GoalCompletionVerificationOutput[] = [];
  const seen = new Set<string>();
  for (const verification of [
    ...verifications,
    ...timeline
      .map((item) => item.verification)
      .filter((item): item is GoalCompletionVerificationOutput => item !== undefined),
  ]) {
    const key = goalVerificationSummaryKey(verification);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(verification);
  }
  return result;
}

function goalVerificationSummaryKey(verification: GoalCompletionVerificationOutput): string {
  return [
    verification.passed ? "1" : "0",
    normalizeTodoContent(verification.reason),
    normalizeTodoContent(verification.nextAction ?? ""),
  ].join("\u0000");
}

export function withGoalSummaryTitleFallback(
  projection: SessionProjection,
  session: SessionInfo | null | undefined,
  messages: readonly MessageWithParts[],
): SessionProjection {
  const target = projection.target;
  if (!target || target.summaryTitle || !session?.title) {
    return projection;
  }
  const firstUserMessage = messages
    .filter((message) => message.info.role === "user")
    .sort(compareMessagesByCreatedTime)[0];
  if (
    !firstUserMessage ||
    Math.abs(firstUserMessage.info.time.created - target.time.created) > 5_000
  ) {
    return projection;
  }
  if (normalizeText(readMessageText(firstUserMessage)) !== normalizeText(target.objective)) {
    return projection;
  }
  return {
    ...projection,
    target: {
      ...target,
      // 首条用户请求就是 goal 时，session 标题才是第一轮标题的持久来源；
      // 老数据可能没有写 target.summaryTitle，恢复后需要用 session.title 补齐首轮标题。
      summaryTitle: session.title,
    },
  };
}

function readMessageText(message: MessageWithParts): string {
  return message.parts
    .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("\n");
}

export function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export function mapSessionGoal(
  goal: SessionGoal | null | undefined,
): ZCodeSessionGoal | null | undefined {
  if (goal === undefined) return undefined;
  if (goal === null) return null;
  return {
    createdAt: goal.time.created,
    objective: goal.objective,
    sessionId: String(goal.sessionID),
    status: goal.status,
    summaryTitle: goal.summaryTitle,
    targetId: goal.targetID,
    timeUsedSeconds: goal.timeUsedSeconds ?? 0,
    tokenBudget: goal.tokenBudget ?? null,
    tokensUsed: goal.tokensUsed ?? 0,
    activeInputId: goal.activeInputId ?? null,
    activeRunStartedAtMs: goal.activeRunStartedAtMs ?? null,
    activeRunLastSeenAtMs: goal.activeRunLastSeenAtMs ?? null,
    updatedAt: goal.time.updated,
  };
}

export function getTargetGoalVerificationTimeline(
  projection: SessionProjection,
  target?: SessionGoal | null,
): SessionProjection["targetCompletionVerificationTimeline"] {
  const targetId = target?.targetID;
  return (projection.targetCompletionVerificationTimeline ?? [])
    .filter((item) => !targetId || item.targetId === targetId)
    .sort(compareGoalVerificationTimeline);
}

export function compareGoalVerificationTimeline(
  left: SessionProjection["targetCompletionVerificationTimeline"][number],
  right: SessionProjection["targetCompletionVerificationTimeline"][number],
): number {
  const leftIteration = left.goalIteration ?? 0;
  const rightIteration = right.goalIteration ?? 0;
  if (leftIteration !== rightIteration && leftIteration > 0 && rightIteration > 0) {
    return leftIteration - rightIteration;
  }
  const byTime = goalVerificationTimelineTime(left) - goalVerificationTimelineTime(right);
  if (byTime !== 0) return byTime;
  return left.verificationId.localeCompare(right.verificationId);
}

function goalVerificationTimelineTime(
  item: SessionProjection["targetCompletionVerificationTimeline"][number],
): number {
  return (item.startedAt ?? item.updatedAt).getTime();
}

export function isPassingGoalVerification(
  item: SessionProjection["targetCompletionVerificationTimeline"][number],
): boolean {
  return item.status === "completed" && item.verification?.passed === true;
}
