import type { DatabaseSync } from "node:sqlite";
import { isSamePath } from "@zcode/shared/managed-worktree";
import { parseExecutionDirectories } from "#src/project-storage/project-repository-read.js";
import type {
  ProjectDirectoryReference,
  ProjectWorktreeTask,
} from "#src/project-storage/domain/worktree-contract.js";
import type { ProjectTaskRef } from "#src/project-storage/domain/contract.js";

/** worktree 任务只允许本地 workspace，并必须同时给出项目与受管根；事务内先拒绝再写入。 */
export function assertWorktreeAdmission(input: {
  task: Pick<ProjectTaskRef, "workspacePath" | "workspaceIdentity">;
  projectId: string | null;
  worktreeRoot: string;
}): void {
  if (input.task.workspaceIdentity?.trim()) throw new Error("project.worktree-local-only");
  if (!input.projectId) throw new Error("project.worktree-requires-project");
  if (!isSamePath(input.worktreeRoot, input.task.workspacePath))
    throw new Error("project.worktree-workspace-mismatch");
}

/** 幂等补记：任务行已存在但还没有受管关系时只补这一列；永不覆盖已记录的其他根。 */
export function bindExistingWorktreeTask(
  db: DatabaseSync,
  input: { workspaceKey: string; taskId: string; worktreeRoot: string },
): void {
  db.prepare(
    "UPDATE tasks SET worktree_root=? WHERE workspace_key=? AND task_id=? AND worktree_root IS NULL",
  ).run(input.worktreeRoot, input.workspaceKey, input.taskId);
}

/** tasks-index 里受管 worktree 的只读任务事实；不写库、不缓存。 */
export function listTasksByWorktree(
  db: DatabaseSync,
  owner: string,
  input: { worktreeRoot: string },
): ProjectWorktreeTask[] {
  return (
    db
      .prepare(
        `SELECT task_id,workspace_path,workspace_identity,project_id,title,cli_title,title_overridden,archived
         FROM tasks WHERE host_id=? AND worktree_root=? AND deleted=0 AND coalesce(cli_deleted,0)=0
         ORDER BY updated_at DESC,task_id`,
      )
      .all(owner, input.worktreeRoot) as Array<Record<string, unknown>>
  ).map((row) => ({
    taskId: String(row.task_id),
    workspacePath: String(row.workspace_path),
    ...(typeof row.workspace_identity === "string"
      ? { workspaceIdentity: row.workspace_identity }
      : {}),
    projectId: typeof row.project_id === "string" ? row.project_id : null,
    title: String(row.title_overridden === 1 ? row.title : (row.cli_title ?? row.title)),
    archived: row.archived === 1,
  }));
}

/**
 * 候选查询允许额外命中（LIKE 只做粗过滤），精确路径包含由调用方用共享布局工具判断。
 * 只读本地 Host 行；不含 cli_deleted 行，与普通任务列表口径一致。
 */
export function listDirectoryReferencingTasks(
  db: DatabaseSync,
  owner: string,
  input: { directory: string },
): ProjectDirectoryReference[] {
  const prefix = `${input.directory}%`;
  return (
    db
      .prepare(
        `SELECT workspace_key,workspace_path,workspace_identity,task_id,root_path,worktree_root,execution_directories
         FROM tasks WHERE host_id=? AND deleted=0 AND (root_path=? OR root_path LIKE ? OR execution_directories LIKE ?)`,
      )
      .all(owner, input.directory, prefix, prefix) as Array<Record<string, unknown>>
  ).map((row) => {
    const cwd = String(row.root_path ?? row.workspace_path);
    const directories = [
      cwd,
      ...(typeof row.execution_directories === "string"
        ? parseExecutionDirectories(JSON.parse(row.execution_directories))
        : []),
    ];
    return {
      workspacePath: String(row.workspace_path),
      ...(typeof row.workspace_identity === "string"
        ? { workspaceIdentity: row.workspace_identity }
        : {}),
      taskId: String(row.task_id),
      cwd,
      directories,
      ...(typeof row.worktree_root === "string" ? { worktreeRoot: row.worktree_root } : {}),
    };
  });
}
