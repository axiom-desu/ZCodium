import type { DatabaseSync } from "node:sqlite";
import type { SessionId, SessionGoal, GoalStatus } from "@zcode/contracts";
import {
  mustReadTarget,
  readSessionTarget,
  touchSessionForTarget,
} from "./session-target-access.js";
import { elapsedSecondsBetween } from "./session-target-row.js";

export function startSessionTargetRun(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    startedAtMs: number;
  },
): SessionGoal | null {
  const startedAt = Math.max(0, input.startedAtMs);
  // goal live 计时必须跟随 agent 运行边界落库，不能再由 UI 从 assistant
  // message timestamp 反推；恢复 snapshot 时该 timestamp 可能是旧轮次，导致切回后异常增长。
  const result = db
    .prepare(
      `
      update session_target
      set
        active_input_id = ?,
        active_run_started_at = ?,
        active_run_last_seen_at = ?,
        time_updated = max(time_updated, ?)
      where session_id = ?
        and target_id = ?
        and status = 'active'
      `,
    )
    .run(input.inputID, startedAt, startedAt, startedAt, input.sessionID, input.targetID);
  if (result.changes === 0) return readSessionTarget(db, { sessionID: input.sessionID });
  touchSessionForTarget(db, input.sessionID, startedAt);
  return mustReadTarget(db, input.sessionID);
}

export function heartbeatSessionTargetRun(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    seenAtMs: number;
  },
): SessionGoal | null {
  const seenAt = Math.max(0, input.seenAtMs);
  const result = db
    .prepare(
      `
      update session_target
      set
        active_run_last_seen_at = max(coalesce(active_run_last_seen_at, 0), ?),
        time_updated = max(time_updated, ?)
      where session_id = ?
        and target_id = ?
        and active_input_id = ?
        and active_run_started_at is not null
      `,
    )
    .run(seenAt, seenAt, input.sessionID, input.targetID, input.inputID);
  if (result.changes === 0) return readSessionTarget(db, { sessionID: input.sessionID });
  touchSessionForTarget(db, input.sessionID, seenAt);
  return mustReadTarget(db, input.sessionID);
}

export function finishSessionTargetRun(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    endedAtMs: number;
    status?: GoalStatus;
    tokensUsedDelta?: number;
  },
): SessionGoal | null {
  const current = readSessionTarget(db, { sessionID: input.sessionID });
  if (
    !current ||
    current.targetID !== input.targetID ||
    current.activeInputId !== input.inputID ||
    current.activeRunStartedAtMs == null
  ) {
    return current;
  }

  const endedAt = Math.max(0, input.endedAtMs);
  const tokenDelta = Math.max(0, input.tokensUsedDelta ?? 0);
  const timeDelta = elapsedSecondsBetween(current.activeRunStartedAtMs, endedAt);
  const result = db
    .prepare(
      `
      update session_target
      set
        tokens_used = tokens_used + ?,
        time_used_seconds = time_used_seconds + ?,
        status = case
          when ? is not null then ?
          when status = 'active' and token_budget is not null and tokens_used + ? >= token_budget then 'budget_limited'
          else status
        end,
        active_input_id = null,
        active_run_started_at = null,
        active_run_last_seen_at = null,
        time_updated = max(time_updated, ?)
      where session_id = ?
        and target_id = ?
        and active_input_id = ?
        and active_run_started_at = ?
      `,
    )
    .run(
      tokenDelta,
      timeDelta,
      input.status ?? null,
      input.status ?? null,
      tokenDelta,
      endedAt,
      input.sessionID,
      input.targetID,
      input.inputID,
      current.activeRunStartedAtMs,
    );
  if (result.changes === 0) return readSessionTarget(db, { sessionID: input.sessionID });
  touchSessionForTarget(db, input.sessionID, endedAt);
  return mustReadTarget(db, input.sessionID);
}

export function recoverInterruptedSessionTargetRun(
  db: DatabaseSync,
  input: { sessionID: SessionId },
): SessionGoal | null {
  const current = readSessionTarget(db, { sessionID: input.sessionID });
  if (!current || !current.activeInputId || current.activeRunStartedAtMs == null) {
    return current;
  }

  // 进程崩溃/退出后，active_run_started_at 只能说明上次没有正常收口。
  // 恢复时不能用 Date.now() 结算，否则 app 离线时间会被计入 goal 运行时长。
  const endedAt = current.activeRunLastSeenAtMs ?? current.activeRunStartedAtMs;
  const timeDelta = elapsedSecondsBetween(current.activeRunStartedAtMs, endedAt);
  const nextStatus: GoalStatus = current.status === "active" ? "paused" : current.status;
  const result = db
    .prepare(
      `
      update session_target
      set
        time_used_seconds = time_used_seconds + ?,
        status = ?,
        active_input_id = null,
        active_run_started_at = null,
        active_run_last_seen_at = null,
        time_updated = max(time_updated, ?)
      where session_id = ?
        and target_id = ?
        and active_input_id = ?
        and active_run_started_at = ?
      `,
    )
    .run(
      timeDelta,
      nextStatus,
      endedAt,
      input.sessionID,
      current.targetID,
      current.activeInputId,
      current.activeRunStartedAtMs,
    );
  if (result.changes === 0) return readSessionTarget(db, { sessionID: input.sessionID });
  touchSessionForTarget(db, input.sessionID, endedAt);
  return mustReadTarget(db, input.sessionID);
}

export function accountSessionTargetUsage(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    targetID: string;
    tokensUsedDelta?: number;
    timeUsedSecondsDelta?: number;
  },
): SessionGoal | null {
  const now = Date.now();
  const tokenDelta = Math.max(0, input.tokensUsedDelta ?? 0);
  const timeDelta = Math.max(0, input.timeUsedSecondsDelta ?? 0);
  if (tokenDelta === 0 && timeDelta === 0) {
    return readSessionTarget(db, { sessionID: input.sessionID });
  }

  const result = db
    .prepare(
      `
      update session_target
      set
        tokens_used = tokens_used + ?,
        time_used_seconds = time_used_seconds + ?,
        status = case
          when status = 'active' and token_budget is not null and tokens_used + ? >= token_budget then 'budget_limited'
          else status
        end,
        time_updated = ?
      where session_id = ? and target_id = ?
      `,
    )
    .run(tokenDelta, timeDelta, tokenDelta, now, input.sessionID, input.targetID);
  if (result.changes === 0) return readSessionTarget(db, { sessionID: input.sessionID });
  touchSessionForTarget(db, input.sessionID, now);
  return mustReadTarget(db, input.sessionID);
}
