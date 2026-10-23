import type { DatabaseSync } from "node:sqlite";

const USAGE_RETENTION_DAYS = 30;

const USAGE_RETENTION_MS = USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export async function pruneUsage(
  db: DatabaseSync,
  input: { beforeTime?: number } = {},
): Promise<void> {
  const beforeTime = input.beforeTime ?? Date.now() - USAGE_RETENTION_MS;
  db.exec("begin immediate");
  try {
    db.prepare("delete from model_usage where started_at < ?").run(beforeTime);
    db.prepare("delete from turn_usage where started_at < ?").run(beforeTime);
    db.prepare("delete from tool_usage where started_at < ?").run(beforeTime);
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}
