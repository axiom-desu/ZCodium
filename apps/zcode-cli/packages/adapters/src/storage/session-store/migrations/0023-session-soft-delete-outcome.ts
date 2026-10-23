import type { DatabaseSync } from "node:sqlite";
import type { SqliteMigration } from "./types.js";

// 会话软删除与上次结果。历史 `time_archived` 列保留为只读兼容，不回填删除时间（与上游一致）。
// SQL 是账本 checksum 的真值，Rust `crates/state/src/node/migrations/0023_*.sql` 逐字节镜像。
const sql =
  `
      alter table session add column time_deleted integer;
      alter table session add column last_outcome text;
    `.trimEnd() + "\n";

export const SESSION_SOFT_DELETE_OUTCOME_MIGRATION: SqliteMigration = {
  appVersion: "0.16.9",
  id: "0023_session_soft_delete_outcome",
  sql,
  // 原因：另一分支/上游 ZCode 可能已按同一 id 写过这两列（包含手写迁移或未来的列预置），
  // 此时重复执行 alter 会以 "duplicate column name" 中断整个库启动。这里按列存在性守卫 DDL，
  // 仍以 `sql` 写账本行，保证 checksum 与其它实现互认。
  apply: (db: DatabaseSync) => {
    const columns = new Set(
      (db.prepare("pragma table_info(session)").all() as { name: string }[]).map((row) => row.name),
    );
    if (!columns.has("time_deleted"))
      db.exec("alter table session add column time_deleted integer");
    if (!columns.has("last_outcome")) db.exec("alter table session add column last_outcome text");
  },
};
