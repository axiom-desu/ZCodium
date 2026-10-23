import { getZCodeGoalActiveIterationCount } from "@zcode/shared";
import type { ZCodeSessionGoalStats } from "@zcode/shared";
import type { MessageWithParts, SessionGoal, SessionProjection } from "@zcode/contracts";
import {
  compareGoalVerificationTimeline,
  getTargetGoalVerificationTimeline,
  isPassingGoalVerification,
} from "./session-mapper-goals.js";

interface GoalIterationBucket {
  goalIteration: number;
  id: string;
  messageIds: Set<string>;
  startedAt?: number;
  targetId?: string;
  toolCallCount: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  updatedAt?: number;
}

export function buildGoalStats(
  projection: SessionProjection,
  messages: readonly MessageWithParts[],
): ZCodeSessionGoalStats | undefined {
  const target = projection.target;
  if (!target) {
    return undefined;
  }
  const goalIterations = collectGoalIterationBuckets(messages, {
    projection,
    target,
  });
  const activeIterationCount = getGoalActiveIterationCount(projection, target);
  const derivedTokensUsed = goalIterations.reduce(
    (sum, iteration) => sum + iteration.tokensUsed,
    0,
  );
  const derivedTimeUsedSeconds = goalIterations.reduce(
    (sum, iteration) => sum + iteration.timeUsedSeconds,
    0,
  );
  return {
    contextUsed: projection.contextUsed,
    contextWindow: projection.contextWindow,
    // goal 轮次只能由 verifier 生命周期边界推进；用户消息、TodoWrite
    // 或手动继续都只是落入当前打开轮次，不能单独开新轮。
    iterationCount: activeIterationCount,
    // active goal run 已由 session_target.active_run_started_at 表达。
    // 运行中不能再用 assistant 消息推导出的时间当已结算 base，否则 UI 会再叠加 live run 导致切换恢复后双算。
    timeUsedSeconds:
      target.timeUsedSeconds > 0 || target.activeRunStartedAtMs != null
        ? target.timeUsedSeconds
        : derivedTimeUsedSeconds,
    // 旧 session_target 行可能没有 tokenBudget；协议 schema 需要稳定 JSON 值，
    // 与 mapSessionGoal 保持一致用 null 表示未设置预算。
    tokenBudget: target.tokenBudget ?? null,
    tokensUsed: target.tokensUsed > 0 ? target.tokensUsed : derivedTokensUsed,
    toolCallCount: goalIterations.reduce((sum, iteration) => sum + iteration.toolCallCount, 0),
  };
}

function getGoalActiveIterationCount(
  projection: SessionProjection,
  target?: SessionGoal | null,
): number {
  const timeline = getTargetGoalVerificationTimeline(projection, target);
  return getZCodeGoalActiveIterationCount({
    targetStatus: target?.status ?? null,
    timeline,
  });
}

function collectGoalIterationBuckets(
  messages: readonly MessageWithParts[],
  options: { projection: SessionProjection; target?: SessionGoal | null },
): GoalIterationBucket[] {
  const target = options.target ?? null;
  const timeline = getTargetGoalVerificationTimeline(options.projection, target);
  const buckets: GoalIterationBucket[] = [];
  const byIteration = new Map<number, GoalIterationBucket>();
  const sortedMessages = [...messages].sort(compareMessagesByCreatedTime);

  for (const message of sortedMessages) {
    if (message.info.role !== "assistant") {
      continue;
    }
    const goalIteration = getGoalIterationForMessageTime(
      message.info.time.created,
      target,
      timeline,
    );
    if (!goalIteration) {
      continue;
    }
    const bucket =
      byIteration.get(goalIteration) ??
      createGoalIterationBucket(goalIteration, target, timeline, message.info.time.created);
    if (!byIteration.has(goalIteration)) {
      byIteration.set(goalIteration, bucket);
      buckets.push(bucket);
    }
    const messageId = String(message.info.id);
    bucket.messageIds.add(messageId);
    const completedAt = message.info.time.completed ?? message.info.time.created;
    bucket.toolCallCount += message.parts.filter((part) => part.type === "tool").length;
    bucket.tokensUsed += tokenTotal(message.info.tokens);
    bucket.timeUsedSeconds += Math.max(
      0,
      Math.ceil((completedAt - message.info.time.created) / 1000),
    );
    bucket.updatedAt = Math.max(bucket.updatedAt ?? 0, completedAt);
  }

  return buckets;
}

function createGoalIterationBucket(
  goalIteration: number,
  target: SessionGoal | null,
  timeline: readonly SessionProjection["targetCompletionVerificationTimeline"][number][],
  fallbackStartedAt: number,
): GoalIterationBucket {
  return {
    goalIteration,
    id: `goal-iteration-${goalIteration}`,
    messageIds: new Set(),
    startedAt: getGoalIterationStartedAt(goalIteration, target, timeline, fallbackStartedAt),
    targetId: target?.targetID,
    toolCallCount: 0,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    updatedAt: fallbackStartedAt,
  };
}

export function getGoalIterationForMessageTime(
  messageCreatedAt: number,
  target: SessionGoal | null | undefined,
  timeline: readonly SessionProjection["targetCompletionVerificationTimeline"][number][],
): number | undefined {
  if (!target || messageCreatedAt < target.time.created) {
    return undefined;
  }
  let activeIteration = 1;
  for (const item of timeline) {
    const itemIteration = item.goalIteration ?? activeIteration;
    const boundaryTime = item.updatedAt.getTime();
    if (messageCreatedAt <= boundaryTime) {
      return itemIteration;
    }
    if (item.status === "started") {
      activeIteration = itemIteration;
      continue;
    }
    if (isPassingGoalVerification(item)) {
      return undefined;
    }
    activeIteration = itemIteration + 1;
  }
  return activeIteration;
}

export function getGoalIterationStartedAt(
  goalIteration: number,
  target: SessionGoal | null | undefined,
  timeline: readonly SessionProjection["targetCompletionVerificationTimeline"][number][],
  fallbackStartedAt: number,
): number {
  if (!target || goalIteration <= 1) {
    return target?.time.created ?? fallbackStartedAt;
  }
  const previousBoundary = [...timeline]
    .filter((item) => (item.goalIteration ?? 0) === goalIteration - 1)
    .filter((item) => item.status !== "started")
    .sort(compareGoalVerificationTimeline)
    .at(-1);
  return previousBoundary?.updatedAt.getTime() ?? fallbackStartedAt;
}

function tokenTotal(tokens: {
  cache: { read: number; write: number };
  input: number;
  output: number;
  reasoning: number;
  total?: number;
}): number {
  return (
    tokens.total ??
    tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
  );
}

export function compareMessagesByCreatedTime(
  left: MessageWithParts,
  right: MessageWithParts,
): number {
  const byTime = left.info.time.created - right.info.time.created;
  if (byTime !== 0) return byTime;
  return String(left.info.id).localeCompare(String(right.info.id));
}
