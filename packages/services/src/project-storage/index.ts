import type { SqliteMigration } from "@zcode/shared/sqlite-migrations";
import { sqliteMigrations } from "@zcode/shared/sqlite-migrations";
import type { ProjectStorageContract } from "#src/project-storage/app/storageContract.js";
import {
  DEFAULT_WORKSPACE_CANDIDATES_SQL,
  migrateDefaultWorkspaceTasks,
} from "#src/project-storage/default-workspace/migration.js";
import { admitTaskIdentity, reconcileLegacy } from "#src/project-storage/app/legacy-tasks.js";
import { migrateProjects } from "#src/project-storage/app/migrate-projects.js";
import {
  INITIAL_WORKSPACE_ORDER_SQL,
  migrateInitialWorkspaceOrder,
} from "#src/project-storage/migration-order/migration.js";
import { ProjectRepository } from "#src/project-storage/project-repository.js";
import { RemoteProjectRepository } from "#src/project-storage/remote-repository.js";
export { ungroupTaskGroup } from "#src/project-storage/app/task-group-move.js";
import {
  PROJECT_MIGRATION_TABLES,
  PROJECT_SCHEMA_SQL,
  TASK_PROJECT_COLUMNS,
  TASK_RESERVATION_TABLES,
} from "#src/project-storage/app/schema.js";
import { TASK_RESERVATION_SCHEMA_SQL } from "#src/project-storage/app/task-reservations.js";

export const projectStorage: ProjectStorageContract = {
  migrate: async (db, context) => {
    let firstProjectMigration = false;
    const migrations: readonly SqliteMigration[] = [
      {
        id: "0005_projects",
        previousIds: ["0001_projects"],
        appVersion: "3.12.0",
        touchedTables: PROJECT_MIGRATION_TABLES,
        sql: `${PROJECT_SCHEMA_SQL}\n-- tasks columns: ${JSON.stringify(TASK_PROJECT_COLUMNS)}\n-- v3 workspace/group first assignment and CLI intent handoff`,
        apply: (database) => {
          migrateProjects(database, context);
          firstProjectMigration = true;
        },
      },
      {
        id: "0006_default_workspace_tasks",
        appVersion: "3.12.0",
        touchedTables: ["tasks", "projects"],
        sql: `${DEFAULT_WORKSPACE_CANDIDATES_SQL}\n-- v1 clear project ownership and soft-delete the unedited system container; preserve task facts`,
        apply: (database) => migrateDefaultWorkspaceTasks(database, context),
      },
      {
        id: "0007_initial_workspace_order",
        appVersion: "3.16.2",
        touchedTables: ["projects", "remote_project_entries"],
        sql: `${INITIAL_WORKSPACE_ORDER_SQL}\n-- seed mixed order only when 0005 runs in this transaction`,
        apply: (database) => {
          database.exec(INITIAL_WORKSPACE_ORDER_SQL);
          if (firstProjectMigration) migrateInitialWorkspaceOrder(database, context);
        },
      },
      {
        // draft 创建预留的 owner receipt（与 tasks 同库同事务）；不改变 0005 已发布的 checksum，
        // 也不进入 PROJECT_SCHEMA_SQL。旧库只追加这一张空表。
        id: "0008_task_creation_reservations",
        appVersion: "3.16.2",
        touchedTables: TASK_RESERVATION_TABLES,
        sql: TASK_RESERVATION_SCHEMA_SQL,
      },
      {
        // 缓存远端项目删除态是 UI 离线投影事实，不改变远端项目真实数据或连接事实。
        id: "0009_remote_project_deleted_cache",
        appVersion: "3.18.2",
        touchedTables: ["remote_project_entries"],
        sql: "ALTER TABLE remote_project_entries ADD COLUMN cached_deleted INTEGER NOT NULL DEFAULT 0",
        apply: (database) => {
          const columns = new Set(
            (
              database.prepare("PRAGMA table_info(remote_project_entries)").all() as {
                name: string;
              }[]
            ).map((column) => column.name),
          );
          if (!columns.has("cached_deleted"))
            database.exec(
              "ALTER TABLE remote_project_entries ADD COLUMN cached_deleted INTEGER NOT NULL DEFAULT 0",
            );
        },
      },
      {
        // 受管 worktree 的任务关系：只有 tasks-index 这一列是删除闸门读取的唯一事实。
        id: "0010_task_worktree_root",
        appVersion: "3.18.2",
        touchedTables: ["tasks"],
        sql: "ALTER TABLE tasks ADD COLUMN worktree_root TEXT; CREATE INDEX IF NOT EXISTS idx_tasks_host_worktree ON tasks(host_id,worktree_root)",
        apply: (database) => {
          const columns = new Set(
            (
              database.prepare("PRAGMA table_info(tasks)").all() as {
                name: string;
              }[]
            ).map((column) => column.name),
          );
          if (!columns.has("worktree_root"))
            database.exec("ALTER TABLE tasks ADD COLUMN worktree_root TEXT");
          database.exec(
            "CREATE INDEX IF NOT EXISTS idx_tasks_host_worktree ON tasks(host_id,worktree_root)",
          );
        },
      },
    ];
    const result = await sqliteMigrations.migrate(db, migrations, {
      database: "tasks_index",
      backupDirectories: context.backupDirectories,
      now: context.now,
      onBackupSkipped: () => context.warn?.("项目迁移备份因可写卷空间不足跳过"),
    });
    reconcileLegacy(db, context.hostId);
    return result;
  },
  admitTaskIdentity,
  repository: (db, hostId) => new ProjectRepository(db, hostId),
  remoteProjects: (db, hostId) => new RemoteProjectRepository(db, hostId),
};
