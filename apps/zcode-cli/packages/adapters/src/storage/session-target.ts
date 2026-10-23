// ============================================================
// SQLite session target helpers
// ============================================================

import type { DatabaseSync } from "node:sqlite";
import type { SessionId, SessionGoal, GoalStatus } from "@zcode/contracts";
import {
  mustReadTarget,
  readSessionTarget,
  touchSessionForTarget,
} from "./session-target-access.js";
import { createStorageTargetId } from "./session-target-row.js";

export { readSessionTarget } from "./session-target-access.js";
export {
  accountSessionTargetUsage,
  finishSessionTargetRun,
  heartbeatSessionTargetRun,
  recoverInterruptedSessionTargetRun,
  startSessionTargetRun,
} from "./session-target-runs.js";

export function setSessionTarget(
  db: DatabaseSync,
  input: {
    objective: string;
    sessionID: SessionId;
    status: GoalStatus;
    tokenBudget?: number | null;
  },
): SessionGoal {
  const now = Date.now();
  const targetID = createStorageTargetId();
  db.prepare(
    `
    insert into session_target (
      session_id, target_id, objective, summary_title, status, token_budget, tokens_used, time_used_seconds, time_created, time_updated
    ) values (?, ?, ?, null, ?, ?, 0, 0, ?, ?)
    on conflict(session_id) do update set
      target_id = excluded.target_id,
      objective = excluded.objective,
      summary_title = excluded.summary_title,
      status = excluded.status,
      token_budget = excluded.token_budget,
      tokens_used = excluded.tokens_used,
      time_used_seconds = excluded.time_used_seconds,
      active_input_id = null,
      active_run_started_at = null,
      active_run_last_seen_at = null,
      time_created = excluded.time_created,
      time_updated = excluded.time_updated
    `,
  ).run(
    input.sessionID,
    targetID,
    input.objective,
    input.status,
    input.tokenBudget ?? null,
    now,
    now,
  );
  touchSessionForTarget(db, input.sessionID, now);
  return mustReadTarget(db, input.sessionID);
}

export function cloneSessionTargetForFork(
  db: DatabaseSync,
  input: {
    source: SessionGoal;
    sessionID: SessionId;
    status: GoalStatus;
  },
): SessionGoal {
  const now = Date.now();
  const source = input.source;
  // fork 是 session state branch，不是新建 goal。必须保留 target_id 和
  // 原始 created time，让已复制的 goal-continuation / verifier metadata 能继续对齐。
  // active run 字段属于父 session 当前运行态，child 不能继承，否则会显示幽灵运行中。
  db.prepare(
    `
    insert into session_target (
      session_id,
      target_id,
      objective,
      summary_title,
      status,
      token_budget,
      tokens_used,
      time_used_seconds,
      active_input_id,
      active_run_started_at,
      active_run_last_seen_at,
      time_created,
      time_updated
    ) values (?, ?, ?, ?, ?, ?, ?, ?, null, null, null, ?, ?)
    on conflict(session_id) do update set
      target_id = excluded.target_id,
      objective = excluded.objective,
      summary_title = excluded.summary_title,
      status = excluded.status,
      token_budget = excluded.token_budget,
      tokens_used = excluded.tokens_used,
      time_used_seconds = excluded.time_used_seconds,
      active_input_id = null,
      active_run_started_at = null,
      active_run_last_seen_at = null,
      time_created = excluded.time_created,
      time_updated = excluded.time_updated
    `,
  ).run(
    input.sessionID,
    source.targetID,
    source.objective,
    source.summaryTitle,
    input.status,
    source.tokenBudget,
    source.tokensUsed,
    source.timeUsedSeconds,
    source.time.created,
    source.time.updated,
  );
  touchSessionForTarget(db, input.sessionID, now);
  return mustReadTarget(db, input.sessionID);
}

export function createSessionTarget(
  db: DatabaseSync,
  input: { objective: string; sessionID: SessionId; tokenBudget?: number | null },
): SessionGoal | null {
  const now = Date.now();
  const targetID = createStorageTargetId();
  db.prepare(
    `
    insert or ignore into session_target (
      session_id, target_id, objective, summary_title, status, token_budget, tokens_used, time_used_seconds, time_created, time_updated
    ) values (?, ?, ?, null, 'active', ?, 0, 0, ?, ?)
    `,
  ).run(input.sessionID, targetID, input.objective, input.tokenBudget ?? null, now, now);

  const target = readSessionTarget(db, { sessionID: input.sessionID });
  if (target?.targetID !== targetID) return null;
  touchSessionForTarget(db, input.sessionID, now);
  return target;
}

export function updateSessionTargetStatus(
  db: DatabaseSync,
  input: { sessionID: SessionId; status: GoalStatus },
): SessionGoal | null {
  const now = Date.now();
  const result = db
    .prepare(
      `
      update session_target
      set status = ?, time_updated = ?
      where session_id = ?
      `,
    )
    .run(input.status, now, input.sessionID);
  if (result.changes === 0) return null;
  touchSessionForTarget(db, input.sessionID, now);
  return mustReadTarget(db, input.sessionID);
}

export function updateSessionTargetSummaryTitle(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    targetID: string;
    summaryTitle: string;
  },
): SessionGoal | null {
  const now = Date.now();
  // goal 概要由异步 title sidecar 生成；用户可能在模型返回前 replace/clear goal。
  // 必须带 target_id 条件写回，避免旧 objective 的概要覆盖新目标。
  const result = db
    .prepare(
      `
      update session_target
      set summary_title = ?, time_updated = ?
      where session_id = ? and target_id = ?
      `,
    )
    .run(input.summaryTitle, now, input.sessionID, input.targetID);
  if (result.changes === 0) return readSessionTarget(db, { sessionID: input.sessionID });
  touchSessionForTarget(db, input.sessionID, now);
  return mustReadTarget(db, input.sessionID);
}

export function clearSessionTarget(db: DatabaseSync, input: { sessionID: SessionId }): boolean {
  const now = Date.now();
  const result = db.prepare("delete from session_target where session_id = ?").run(input.sessionID);
  if (result.changes === 0) return false;
  touchSessionForTarget(db, input.sessionID, now);
  return true;
}
