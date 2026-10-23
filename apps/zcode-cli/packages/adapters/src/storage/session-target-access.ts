import type { DatabaseSync } from "node:sqlite";
import type { SessionId, SessionGoal } from "@zcode/contracts";
import { decodeTargetRow, type TargetRow } from "./session-target-row.js";

export function readSessionTarget(
  db: DatabaseSync,
  input: { sessionID: SessionId },
): SessionGoal | null {
  const row = db
    .prepare("select * from session_target where session_id = ?")
    .get(input.sessionID) as TargetRow | undefined;
  return row ? decodeTargetRow(row) : null;
}

export function mustReadTarget(db: DatabaseSync, sessionID: SessionId): SessionGoal {
  const target = readSessionTarget(db, { sessionID });
  if (!target) {
    throw new Error(`Session target not found after write: ${sessionID}`);
  }
  return target;
}

export function touchSessionForTarget(
  db: DatabaseSync,
  sessionID: SessionId,
  timeUpdated: number,
): void {
  db.prepare("update session set time_updated = max(time_updated, ?) where id = ?").run(
    timeUpdated,
    sessionID,
  );
}
