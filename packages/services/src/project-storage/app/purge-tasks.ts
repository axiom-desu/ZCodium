import type { DatabaseSync } from "node:sqlite";
import { resolveWorkspaceKey } from "@zcode/shared";
import type { ProjectTaskRef } from "#src/project-storage/domain/contract.js";
import {
  readProjects,
  readTask,
  transaction,
} from "#src/project-storage/project-repository-read.js";
import { tableExists } from "#src/project-storage/app/schema.js";

/**
 * 彻底删除项目数据的行操作（ProjectDataRepositoryContract 的执行面）。
 * 与 ProjectRepository 同一实例、同一 sqlite 连接与事务；只删本 Host 自有的行。
 */

export function readProjectTaskRefs(
  db: DatabaseSync,
  owner: string,
  id: string,
): Array<ProjectTaskRef & { cwd: string }> {
  return transaction(
    db,
    () =>
      db
        .prepare("SELECT * FROM tasks WHERE project_id=? AND host_id=? ORDER BY task_id")
        .all(id, owner)
        .map((row) => ({
          taskId: String(row.task_id),
          workspacePath: String(row.workspace_path),
          ...(row.workspace_identity == null
            ? {}
            : { workspaceIdentity: String(row.workspace_identity) }),
          cwd: String(row.root_path ?? row.workspace_path),
        })),
    false,
  );
}

export function readTaskDirectories(
  db: DatabaseSync,
  owner: string,
): Array<{ projectId: string | null; cwd: string }> {
  return transaction(
    db,
    () =>
      db
        .prepare(
          "SELECT DISTINCT project_id, coalesce(root_path, workspace_path) AS cwd FROM tasks WHERE host_id=? AND deleted=0",
        )
        .all(owner)
        .map((row) => ({
          projectId: row.project_id == null ? null : String(row.project_id),
          cwd: String(row.cwd),
        })),
    false,
  );
}

export function purgeTasks(
  db: DatabaseSync,
  owner: string,
  tasks: readonly ProjectTaskRef[],
): void {
  // 分组准入表只在新版本库里存在；旧库或测试库缺表时没有可删的行。
  const admissions = tableExists(db, "task_group_admissions");
  transaction(db, () => {
    for (const task of tasks) {
      const key = resolveWorkspaceKey(task);
      const row = readTask(db, task);
      // 别的 Host 的行不属于本次命令的范围。
      if (row && row.host_id !== owner) continue;
      db.prepare("DELETE FROM tasks WHERE workspace_key=? AND task_id=?").run(key, task.taskId);
      db.prepare("DELETE FROM task_group_members WHERE workspace_key=? AND task_id=?").run(
        key,
        task.taskId,
      );
      if (admissions)
        db.prepare("DELETE FROM task_group_admissions WHERE workspace_key=? AND task_id=?").run(
          key,
          task.taskId,
        );
    }
  });
}

export function markTasksDeleted(
  db: DatabaseSync,
  owner: string,
  tasks: readonly ProjectTaskRef[],
): void {
  transaction(db, () => {
    for (const task of tasks)
      db.prepare(
        "UPDATE tasks SET deleted=1,cli_deleted=1,handoff_pending=handoff_pending & ~1 WHERE workspace_key=? AND task_id=? AND host_id=?",
      ).run(resolveWorkspaceKey(task), task.taskId, owner);
  });
}

export function purgeProjectIfUnreferenced(db: DatabaseSync, owner: string, id: string): boolean {
  return transaction(db, () => {
    const project = readProjects(db).find((entry) => entry.id === id);
    if (!project?.deleted || project.hostId !== owner) return false;
    // 被保留的运行中会话、定时与闲时定义仍指向它时保持软删除：删掉会让它们指向不存在的项目。
    const referenced = ["tasks", "automations", "off_peak_tasks"].some(
      (table) =>
        db.prepare(`SELECT 1 FROM ${table} WHERE project_id=? LIMIT 1`).get(id) !== undefined,
    );
    if (referenced) return false;
    db.prepare("DELETE FROM project_roots WHERE project_id=?").run(id);
    db.prepare("DELETE FROM projects WHERE project_id=?").run(id);
    return true;
  });
}
