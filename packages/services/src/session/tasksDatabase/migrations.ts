import { createHash } from "node:crypto";
import { dirname, join, basename } from "node:path";
import { tmpdir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { databaseMigrationIdSchema, type DatabaseMigrationFacts } from "@zcode/shared";
import { sqliteMigrations, type SqliteMigration } from "@zcode/shared/sqlite-migrations";
import {
  AUTOMATION_SCHEMA,
  OFF_PEAK_SCHEMA,
  TASK_INDEX_SCHEMA,
} from "#src/session/tasksDatabase/schema-v1.js";
import { importLegacyAutomationSelections } from "#src/session/tasksDatabase/provider-selection-v2.js";
import { OFFICIAL_GLM_SELECTION_MIGRATION_SQL } from "#src/session/tasksDatabase/official-glm-selection-v3.js";
import { TASK_GROUP_ADMISSIONS_SQL } from "#src/session/tasksDatabase/task-group-admissions-v6.js";

// 冻结历史列声明，不能以实时 Repo/schema 代替，否则新版构建会改变已应用 checksum。
const columns = [
  ["tasks", "title_overridden", "INTEGER NOT NULL DEFAULT 0"],
  ["tasks", "last_unread_at", "INTEGER NOT NULL DEFAULT 0"],
  ["tasks", "searchable_text", "TEXT NOT NULL DEFAULT ''"],
  ["tasks", "cron_automation_id", "TEXT"],
  ["tasks", "off_peak_task_id", "TEXT"],
  ["automations", "target_task_id", "TEXT"],
  ["automations", "bot_delivery_target", "TEXT"],
  ["automations", "mode", "TEXT"],
  ["automations", "end_at", "INTEGER"],
  ["automations", "schedule_rule", "TEXT"],
  ["automations", "schedule_edited_by_user", "INTEGER NOT NULL DEFAULT 0"],
  ["automations", "thought_level", "TEXT"],
  ["automations", "model_selection", "TEXT"],
  ["automations", "scheduled_run_count", "INTEGER NOT NULL DEFAULT 0"],
  ["automation_runs", "model_selection", "TEXT"],
  ["off_peak_tasks", "thought_level", "TEXT"],
  ["off_peak_tasks", "model_selection", "TEXT"],
  ["off_peak_tasks", "history_deleted_at", "INTEGER"],
] as const;
const indexes = `
  CREATE INDEX IF NOT EXISTS idx_tasks_cron_automation ON tasks(cron_automation_id, updated_at DESC)
    WHERE cron_automation_id IS NOT NULL AND deleted=0;
  CREATE INDEX IF NOT EXISTS idx_tasks_off_peak_task ON tasks(off_peak_task_id, updated_at DESC)
    WHERE off_peak_task_id IS NOT NULL AND deleted=0;
  CREATE INDEX IF NOT EXISTS idx_automations_target_task ON automations(target_task_id) WHERE target_task_id IS NOT NULL;
`;
const terminalStatuses = "'completed','failed','cancelled'";
const activePredicate = `session_id IS NOT NULL AND status NOT IN (${terminalStatuses})`;
const boundIndex = `CREATE UNIQUE INDEX IF NOT EXISTS idx_off_peak_bound_active ON off_peak_tasks(workspace_key,session_id) WHERE ${activePredicate}`;
const executionColumns = [
  ["automations", "project_id"],
  ["automations", "host_id"],
  ["automations", "additional_directories"],
  ["off_peak_tasks", "project_id"],
  ["off_peak_tasks", "host_id"],
  ["off_peak_tasks", "additional_directories"],
] as const;

// checksum 输入是语义版本的 JSON；历史条目 0001–0003 保持不变，新增条目只能追加。
// 用 sqlite-migrations 的 sql 字段承载同一 JSON，历史 checksum（sha256(sql.trim())）逐字节相同。
const definitions = [
  {
    id: "0001_adopt_task_schema",
    touchedTables: [
      "tasks",
      "task_groups",
      "task_group_members",
      "task_group_view_node_orders",
      "task_group_workspace_bootstraps",
      "automations",
      "automation_runs",
      "off_peak_tasks",
    ],
    apply: adoptSchema,
    checksumInput: [
      TASK_INDEX_SCHEMA,
      AUTOMATION_SCHEMA,
      OFF_PEAK_SCHEMA,
      columns,
      indexes,
      boundIndex,
      "scheduled-count-backfill-v1",
    ],
  },
  {
    id: "0002_provider_selection",
    touchedTables: ["automations"],
    apply: importLegacyAutomationSelections,
    checksumInput: ["legacy-automation-selection-v1", "no-provider-for-legacy-off-peak-v1"],
  },
  {
    id: "0003_official_glm_selection",
    touchedTables: ["automations"],
    apply: (db: DatabaseSync) => db.exec(OFFICIAL_GLM_SELECTION_MIGRATION_SQL),
    checksumInput: [OFFICIAL_GLM_SELECTION_MIGRATION_SQL],
  },
  {
    id: "0004_project_execution_scopes",
    touchedTables: ["automations", "off_peak_tasks"],
    checksumInput: [executionColumns, "nullable-text-v1"],
    apply: (db: DatabaseSync) => {
      // 原因：调度器可独立打开 Repo，不能等待项目归属转换，也不能把新列写进上游冻结 schema。
      for (const [table, column] of executionColumns) {
        if (
          !db
            .prepare(`PRAGMA table_info(${table})`)
            .all()
            .some((entry) => entry.name === column)
        )
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
      }
    },
  },
  {
    id: "0006_task_group_admissions",
    touchedTables: ["task_group_admissions"],
    checksumInput: [TASK_GROUP_ADMISSIONS_SQL],
    apply: (db: DatabaseSync) => db.exec(TASK_GROUP_ADMISSIONS_SQL),
  },
] as const;

function prepareMigrations(): SqliteMigration[] {
  return definitions.map((migration) => ({
    id: migration.id,
    appVersion: "3.12.0",
    sql: JSON.stringify(migration.checksumInput),
    touchedTables: migration.touchedTables,
    apply: migration.apply,
  }));
}

interface TasksDatabaseMigrationOptions {
  dbPath?: string;
  transactionOpen?: boolean;
  migration?: DatabaseMigrationFacts;
  onProgress?: (phase: "migrating" | "committing", migration: DatabaseMigrationFacts) => void;
}

function appliedChecksum(id: string): string {
  const definition = definitions.find((migration) => migration.id === id)!;
  return createHash("sha256").update(JSON.stringify(definition.checksumInput)).digest("hex");
}

/** 备份目录与 Host 数据根一致；同路径库共用，不写进业务表目录。 */
export function tasksBackupDirectories(dbPath: string): string[] {
  if (dbPath === ":memory:" || !dbPath) return [join(tmpdir(), "zcode-tasks-index-backup")];
  const directory = dirname(dbPath);
  const dataRoot = basename(directory) === "v2" ? dirname(directory) : directory;
  return [join(dataRoot, "backup")];
}

function databasePath(db: DatabaseSync, fallback?: string): string {
  if (fallback) return fallback;
  const file = db
    .prepare("pragma database_list")
    .all()
    .find((row) => row.name === "main")?.file;
  return typeof file === "string" && file ? file : ":memory:";
}

export async function runTasksDatabaseMigrations(
  db: DatabaseSync,
  options: TasksDatabaseMigrationOptions = {},
) {
  const migrations = prepareMigrations();
  if (!options.transactionOpen && areTasksDatabaseMigrationsApplied(db))
    return { applied: [], backupSkipped: false };
  const facts = options.migration ?? {
    kind: inspectTasksMigrationKind(db),
    executedCount: 0,
    committedCount: 0,
  };
  const path = databasePath(db, options.dbPath);
  let currentMigrationId: string | undefined;
  try {
    const result = await sqliteMigrations.migrate(db, migrations, {
      database: "tasks_schema",
      journalTable: "tasks_schema_migration",
      backupDirectories: tasksBackupDirectories(path),
      transactionOpen: options.transactionOpen,
      onBeforeApply: (id) => {
        currentMigrationId = id;
        if (facts.kind === "none") facts.kind = "upgrade";
        facts.lastAppliedMigrationId ??= lastAppliedMigrationId(db);
        options.onProgress?.("migrating", { ...facts });
      },
      onApplied: () => {
        facts.executedCount++;
      },
      onCommitting: () => {
        facts.lastAppliedMigrationId ??= lastAppliedMigrationId(db);
        options.onProgress?.("committing", { ...facts });
      },
    });
    facts.committedCount = facts.executedCount;
    return result;
  } catch (error) {
    if (error && typeof error === "object" && currentMigrationId)
      Object.assign(error, { migrationId: currentMigrationId });
    throw error;
  }
}

function lastAppliedMigrationId(
  db: DatabaseSync,
): DatabaseMigrationFacts["lastAppliedMigrationId"] {
  const baseline = db
    .prepare("SELECT id FROM tasks_schema_migration ORDER BY id DESC LIMIT 1")
    .get();
  return baseline ? databaseMigrationIdSchema.safeParse(baseline.id).data : null;
}

/** 交接只复用已完成初始化；每个新连接按冻结账本确认，替换/清空文件不能假 ready。 */
export function areTasksDatabaseMigrationsApplied(db: DatabaseSync): boolean {
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks_schema_migration'")
      .get()
  )
    return false;
  for (const definition of definitions) {
    const row = db
      .prepare("SELECT checksum FROM tasks_schema_migration WHERE id=?")
      .get(definition.id);
    if (!row) return false;
    if (row.checksum !== appliedChecksum(definition.id))
      throw Object.assign(
        new Error(`Task database migration checksum mismatch: ${definition.id}`),
        { kind: "checksum_mismatch", migrationId: definition.id },
      );
  }
  return true;
}

/** 只读账本的展示预检，不授权执行；runner 拿锁后仍复查每一项。 */
export function inspectTasksMigrationKind(db: DatabaseSync): DatabaseMigrationFacts["kind"] {
  const hasLedger = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks_schema_migration'")
    .get();
  let pending = false;
  for (const definition of definitions) {
    const row = hasLedger
      ? db.prepare("SELECT checksum FROM tasks_schema_migration WHERE id=?").get(definition.id)
      : undefined;
    if (!row) pending = true;
    else if (row.checksum !== appliedChecksum(definition.id))
      throw Object.assign(
        new Error(`Task database migration checksum mismatch: ${definition.id}`),
        { kind: "checksum_mismatch", migrationId: definition.id },
      );
  }
  if (!pending) return "none";
  return db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT IN ('tasks_schema_migration', 'sqlite_sequence') LIMIT 1",
    )
    .get()
    ? "upgrade"
    : "initialize";
}

function adoptSchema(db: DatabaseSync): void {
  db.exec(TASK_INDEX_SCHEMA + AUTOMATION_SCHEMA + OFF_PEAK_SCHEMA);
  for (const [table, column, definition] of columns) {
    const existing = db.prepare(`PRAGMA table_info(${table})`).all();
    if (existing.some((entry) => entry.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    if (table === "automations" && column === "scheduled_run_count") {
      db.exec("UPDATE automations SET scheduled_run_count=run_count");
    }
  }
  db.exec(indexes);
  // 沿用已裁决的旧重复绑定保留策略，但不吞掉权限/语法/磁盘等真实 SQL 错误。
  const duplicate = db
    .prepare(`SELECT 1 FROM off_peak_tasks WHERE ${activePredicate}
    GROUP BY workspace_key, session_id HAVING count(*)>1 LIMIT 1`)
    .get();
  if (!duplicate) db.exec(boundIndex);
}
