import type { AppSettings, DatabaseMigrationFacts } from "@zcode/shared";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createRequire } from "node:module";
// 与既有 Repo 一致：避免构建器把 node:sqlite 改写成不存在的 npm sqlite 包。
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import { AutomationRepo } from "#src/session/automationRepo.js";
import {
  runTasksDatabaseMigrations,
  inspectTasksMigrationKind,
} from "#src/session/tasksDatabase/migrations.js";
import {
  markTasksStorageMigrated,
  markTasksStoragePrepared,
} from "#src/session/tasksDatabase/prepared.js";

type TasksStoragePhase =
  | "checking"
  | "waiting_for_lock"
  | "migrating"
  | "maintaining"
  | "committing"
  | "ready";
const LOCK_WAIT_MS = 60 * 60_000;

/** 真实准备结果；迁移与迁移后修复与旧 Repo 共用，只有获取写锁异步等待。 */
interface TasksStoragePreparationResult {
  /** tasks 原始迁移与项目迁移两阶段合并的真实结果。 */
  backupSkipped: boolean;
  /** 只写阶段名，不写路径/用户信息。 */
  backupSkippedPhases: string[];
}

/** 由 Host Worker 调用；真实返回备份跳过结果，调用方必须提示而不是静默。 */
export async function prepareTasksIndexStorage(
  path: string,
  onProgress: (phase: TasksStoragePhase, migration?: DatabaseMigrationFacts) => void,
  settings: Pick<AppSettings, "lastWorkspaceSession" | "recentProjects">,
  hostId?: string,
): Promise<TasksStoragePreparationResult> {
  // 回调拿到的是当时事实，不共享后续执行会继续递增的内部对象。
  const report = (phase: TasksStoragePhase, migration?: DatabaseMigrationFacts) =>
    onProgress(phase, migration ? { ...migration } : undefined);
  report("checking");
  await mkdir(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // 数据库关闭失败不能覆盖迁移首因；用显式标记记录清理异常，等 finally 结束再传播。
  let cleanupFailed = false;
  let cleanupError: unknown;
  let prepCleanupFailed = false;
  let prepCleanupError: unknown;
  let migration: DatabaseMigrationFacts | undefined;
  let tasksBackupSkipped = false;
  try {
    db.exec("PRAGMA busy_timeout = 25");
    db.exec("PRAGMA foreign_keys = ON");
    const deadline = Date.now() + LOCK_WAIT_MS;
    const acquire = async (operation: string | (() => void)) => {
      // 预检前后可分别遇锁；确认迁移后的等待需要重新发布可见状态。
      let waiting = false;
      for (;;) {
        try {
          if (typeof operation === "string") db.exec(operation);
          else operation();
          return;
        } catch (error) {
          const code = (error as { errcode?: number }).errcode;
          if (typeof code !== "number" || (code & 0xff) !== 5) throw error;
          if (Date.now() >= deadline)
            throw Object.assign(new Error("Task storage lock wait expired", { cause: error }), {
              kind: "lock_timeout",
            });
          if (!waiting) {
            waiting = true;
            report("waiting_for_lock", migration);
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
      }
    };
    await acquire("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    await acquire(() => {
      migration = { kind: inspectTasksMigrationKind(db), executedCount: 0, committedCount: 0 };
    });
    report("checking", migration);
    await acquire("BEGIN IMMEDIATE");
    const tasksMigration = await runTasksDatabaseMigrations(db, {
      transactionOpen: true,
      migration,
      onProgress: report,
      dbPath: path,
    });
    tasksBackupSkipped = tasksMigration.backupSkipped;
    // COMMIT 已成功，先发布事实；后续 close 失败不能把已提交误报为未提交。
    report("maintaining", migration);
  } catch (error) {
    // 失败事实随原异常交给 Worker，不倒退发布 checking/migrating，也不覆盖首因。
    if (migration && error && typeof error === "object") {
      try {
        Object.assign(error, { startupMigration: { ...migration } });
      } catch {
        /* 不可扩展异常仍保留原错误。 */
      }
    }
    throw error;
  } finally {
    try {
      db.close();
    } catch (error) {
      cleanupFailed = true;
      cleanupError = error;
    }
  }
  if (cleanupFailed) throw cleanupError;
  markTasksStorageMigrated(path);
  const taskIndexRepo = new TaskIndexRepo(path, LOCK_WAIT_MS, {
    settings,
    ...(hostId ? { hostId } : {}),
  });
  const repos = [taskIndexRepo, new AutomationRepo(path, LOCK_WAIT_MS)];
  try {
    // 这些是原本就在初始化时执行的修复，不创建新的迁移或改变已有事务边界。
    for (const repo of repos) await repo.ensureReady();
  } finally {
    // 原准备异常天然优先（finally 内不再抛）；repo 关闭失败只在准备成功时才是首因，
    // 否则 throw null/0/"" 这类 falsy 首因会被旧的真值判断丢掉。
    for (const repo of repos) {
      try {
        repo.close({ throwOnError: true });
      } catch (error) {
        prepCleanupFailed = true;
        prepCleanupError ??= error;
      }
    }
  }
  if (prepCleanupFailed) throw prepCleanupError;
  markTasksStoragePrepared(path);
  report("ready", migration);
  const backupSkippedPhases: string[] = [];
  if (tasksBackupSkipped) backupSkippedPhases.push("tasks_schema");
  if (taskIndexRepo.migrationBackupSkipped) backupSkippedPhases.push("projects");
  return { backupSkipped: backupSkippedPhases.length > 0, backupSkippedPhases };
}
