import type { DatabaseSync } from "node:sqlite";
import { resolveWorkspaceKey } from "@zcode/shared";
import { OWNERSHIP_DECIDED } from "#src/project-storage/app/legacy-tasks.js";
import type { ProjectTaskRef } from "#src/project-storage/domain/contract.js";
import {
  parseExecutionDirectories,
  readTask,
} from "#src/project-storage/project-repository-read.js";

interface ForkReservationInheritance {
  rootPath: string;
  executionDirectories: string | null;
  worktreeRoot?: string;
}

/**
 * fork 子任务首次预占：父任务必须存在、未删、同一 workspace。
 * 子任务沿用父 root/执行目录/worktree 归属，避免 ACK 先于 CLI 事实时丢失受管关系。
 */
export function resolveForkReservationInheritance(
  db: DatabaseSync,
  input: { task: ProjectTaskRef; forkedFromTaskId?: string },
): ForkReservationInheritance | undefined {
  if (input.forkedFromTaskId === undefined) return undefined;
  const parent = readTask(db, { ...input.task, taskId: input.forkedFromTaskId });
  if (
    !parent ||
    parent.deleted === 1 ||
    parent.cli_deleted === 1 ||
    input.forkedFromTaskId === input.task.taskId
  )
    throw new Error("project.task-not-found");
  const parentWorkspaceKey = resolveWorkspaceKey({
    workspacePath: String(parent.workspace_path),
    ...(typeof parent.workspace_identity === "string"
      ? { workspaceIdentity: parent.workspace_identity }
      : {}),
  });
  if (parentWorkspaceKey !== resolveWorkspaceKey(input.task))
    throw new Error("project.cwd-not-in-roots");
  return {
    rootPath: String(parent.root_path ?? parent.workspace_path),
    executionDirectories:
      typeof parent.execution_directories === "string" ? parent.execution_directories : null,
    ...(typeof parent.worktree_root === "string" ? { worktreeRoot: parent.worktree_root } : {}),
  };
}

/** 空事实的 fork/创建预占行；调用方与 receipt 写入共用同一事务。 */
export function insertReservedTaskRow(
  db: DatabaseSync,
  input: {
    workspaceKey: string;
    task: ProjectTaskRef;
    host: string;
    projectId: string | null;
    additionalDirectories?: string[];
    inherited?: ForkReservationInheritance;
    forkedFromTaskId?: string;
    worktreeRoot?: string;
  },
): void {
  const executionDirectories =
    input.additionalDirectories === undefined
      ? (input.inherited?.executionDirectories ?? null)
      : JSON.stringify(parseExecutionDirectories(input.additionalDirectories));
  db.prepare(
    `INSERT INTO tasks(workspace_key,workspace_path,workspace_identity,task_id,created_at,updated_at,host_id,root_path,project_id,handoff_pending,execution_directories,forked_from_task_id,worktree_root)
     VALUES(?,?,?,?,0,0,?,?,?,?,?,?,?)`,
  ).run(
    input.workspaceKey,
    input.task.workspacePath,
    input.task.workspaceIdentity ?? null,
    input.task.taskId,
    input.host,
    input.inherited?.rootPath ?? input.task.workspacePath,
    input.projectId,
    OWNERSHIP_DECIDED,
    executionDirectories,
    input.forkedFromTaskId ?? null,
    input.worktreeRoot ?? null,
  );
}

/** ACK 与 CLI 事实任一先到：已有行只补缺失的父归属，不覆盖已写入的值。 */
export function bindExistingForkReservation(
  db: DatabaseSync,
  input: { task: ProjectTaskRef; forkedFromTaskId?: string },
): void {
  if (input.forkedFromTaskId === undefined) return;
  const existing = readTask(db, input.task);
  if (
    existing?.forked_from_task_id &&
    String(existing.forked_from_task_id) !== input.forkedFromTaskId
  )
    throw new Error("project.host-mismatch");
  db.prepare(
    "UPDATE tasks SET forked_from_task_id=? WHERE workspace_key=? AND task_id=? AND forked_from_task_id IS NULL",
  ).run(input.forkedFromTaskId, resolveWorkspaceKey(input.task), input.task.taskId);
}
