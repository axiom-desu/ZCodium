import type { SessionId, SessionGoal, GoalStatus } from "@zcode/contracts";
import { randomUUID } from "node:crypto";

export interface TargetRow {
  session_id: string;
  target_id: string;
  objective: string;
  summary_title: string | null;
  status: string;
  token_budget: number | null;
  tokens_used: number;
  time_used_seconds: number;
  active_input_id: string | null;
  active_run_started_at: number | null;
  active_run_last_seen_at: number | null;
  time_created: number;
  time_updated: number;
}

export function decodeTargetRow(row: TargetRow): SessionGoal {
  return {
    sessionID: row.session_id as SessionId,
    targetID: row.target_id,
    objective: row.objective,
    summaryTitle: row.summary_title,
    status: row.status as GoalStatus,
    tokenBudget: row.token_budget,
    tokensUsed: row.tokens_used,
    timeUsedSeconds: row.time_used_seconds,
    activeInputId: row.active_input_id,
    activeRunStartedAtMs: row.active_run_started_at,
    activeRunLastSeenAtMs: row.active_run_last_seen_at,
    time: {
      created: row.time_created,
      updated: row.time_updated,
    },
  };
}

export function createStorageTargetId(): string {
  return `target_${Date.now().toString(36)}_${randomUUID()}`;
}

export function elapsedSecondsBetween(startedAtMs: number, endedAtMs: number): number {
  return Math.max(0, Math.ceil((endedAtMs - startedAtMs) / 1000));
}
