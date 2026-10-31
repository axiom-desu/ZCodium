import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import {
  generateTraceId,
  isRemoteWorkspaceIdentity,
  resolveWorkspaceKey,
  ZCODE_AGENT_PROVIDER,
} from "@zcode/shared";
import type {
  ProjectDirectories,
  ProjectTask,
  ProjectTaskGroupColor,
  ProjectTaskGroupStructure,
  ProjectTaskGroupTopOrder,
  ProjectTaskRef,
  VirtualProject,
} from "#src/project-storage/domain/contract.js";
import { tableExists } from "#src/project-storage/app/schema.js";
import { assertRemoteTaskDirectories } from "#src/project-storage/domain/remote-policy.js";

const executionDirectoriesSchema = z.array(z.string().min(1)).max(256);

export function transaction<T>(db: DatabaseSync, body: () => T, write = true): T {
  db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
  try {
    const result = body();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    // 回滚失败不能覆盖业务首因（磁盘满/EIO 会同时让写入和 ROLLBACK 失败）。
    rollbackQuietly(db);
    throw error;
  }
}

/** 仅用于保留原始异常；失败分类只供诊断，不替换首因。 */
function rollbackQuietly(db: DatabaseSync): string | null {
  if (!db.isTransaction) return null;
  try {
    db.exec("ROLLBACK");
    return null;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" && code.length > 0 ? code : "rollback_failed";
  }
}

export function readProjects(db: DatabaseSync, includeDeleted = true): VirtualProject[] {
  const roots = db
    .prepare(
      "SELECT project_id,root_path,position,is_primary FROM project_roots ORDER BY position,root_path",
    )
    .all();
  return db
    .prepare(
      `SELECT * FROM projects ${includeDeleted ? "" : "WHERE deleted=0"} ORDER BY position,project_id`,
    )
    .all()
    .map((row) => ({
      id: String(row.project_id),
      hostId: String(row.host_id),
      name: String(row.name),
      nameOverridden: row.name_overridden === 1,
      position: Number(row.position),
      pinned: row.pinned === 1,
      deleted: row.deleted === 1,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      roots: roots
        .filter((root) => root.project_id === row.project_id)
        .map((root) => ({
          rootPath: String(root.root_path),
          position: Number(root.position),
          isPrimary: root.is_primary === 1,
        })),
    }));
}

export function requireProject(db: DatabaseSync, id: string): VirtualProject {
  const project = readProjects(db).find((entry) => entry.id === id);
  if (!project) throw new Error("project.not-found");
  return project;
}

export function readTask(db: DatabaseSync, task: ProjectTaskRef) {
  return db
    .prepare("SELECT * FROM tasks WHERE workspace_key=? AND task_id=?")
    .get(resolveWorkspaceKey(task), task.taskId);
}

function readExecutionDirectories(row: { execution_directories?: unknown }): string[] {
  return typeof row.execution_directories === "string"
    ? parseExecutionDirectories(JSON.parse(row.execution_directories))
    : [];
}

/** 冻结执行快照在写入前校验；读回时仍校验，坏 JSON 直接报错而不降级成空目录。 */
export function parseExecutionDirectories(value: unknown): string[] {
  return executionDirectoriesSchema.parse(value);
}

export function resolveDirectories(
  db: DatabaseSync,
  task: ProjectTaskRef,
  ownerHostId = "local",
): ProjectDirectories {
  const row = readTask(db, task);
  // 旧远端影子行仍可能保留；行与项目一致不代表当前 Host 有权加载其目录。
  if (row && row.host_id !== ownerHostId) throw new Error("project.host-mismatch");
  const workspacePath = row ? String(row.root_path) : task.workspacePath;
  const project = row?.project_id ? requireProject(db, String(row.project_id)) : null;
  if (project && row?.host_id !== project.hostId) throw new Error("project.host-mismatch");
  const frozen = row ? readExecutionDirectories(row) : [];
  assertRemoteTaskDirectories(ownerHostId, project, workspacePath, frozen);
  return {
    workspacePath,
    projectId: project?.id ?? null,
    // 显式快照以写入值为准；普通 session（NULL）继续读取项目当前 roots。
    additionalDirectories:
      typeof row?.execution_directories === "string"
        ? frozen
        : (project?.roots.map((root) => root.rootPath).filter((path) => path !== workspacePath) ??
          []),
  };
}

export function readTasks(db: DatabaseSync): ProjectTask[] {
  // 迁移后的旧后端行也有 CLI 时间；沿用列表的 provider 边界，避免展示 Controller 无法操作的会话。
  return db
    .prepare(
      "SELECT * FROM tasks WHERE provider=? AND deleted=0 AND coalesce(cli_deleted,0)=0 AND cli_created_at IS NOT NULL ORDER BY cli_updated_at DESC,task_id",
    )
    .all(ZCODE_AGENT_PROVIDER)
    .map((row) => {
      const meta = typeof row.meta_json === "string" ? JSON.parse(row.meta_json) : {};
      return {
        ...meta,
        taskId: String(row.task_id),
        traceId: meta.traceId ?? generateTraceId(String(row.task_id)),
        workspacePath: String(row.root_path),
        workspaceIdentity:
          row.workspace_identity === row.workspace_key
            ? String(row.workspace_identity)
            : isRemoteWorkspaceIdentity(String(row.workspace_key))
              ? String(row.workspace_key)
              : undefined,
        title: String(row.title_overridden === 1 ? row.title : (row.cli_title ?? "")),
        titleOverridden: row.title_overridden === 1 || row.cli_title_source === "custom",
        createdAt: Number(row.cli_created_at),
        updatedAt: Number(row.cli_updated_at),
        status:
          row.cli_last_outcome === "error"
            ? "error"
            : row.cli_last_outcome
              ? "completed"
              : undefined,
        mode: meta.mode ?? "default",
        pinned: row.pinned === 1,
        archived: row.archived === 1,
        unreadAt: row.unread_at == null ? undefined : Number(row.unread_at),
        projectId: row.project_id == null ? null : String(row.project_id),
        hostId: String(row.host_id),
      } as ProjectTask;
    });
}

const TASK_GROUP_COLORS = new Set<ProjectTaskGroupColor>([
  "gray",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
]);

/**
 * 只读 taskIndexRepo 已拥有的分组三张表；不建表、不补序、不写回。
 * 旧库或只跑过项目迁移的库缺表时返回 undefined，UI 保持无分组行。
 */
export function readTaskGroupStructure(
  db: DatabaseSync,
  visibleWorkspaceKeys?: ReadonlySet<string>,
): ProjectTaskGroupStructure | undefined {
  const required = [
    "task_groups",
    "task_group_members",
    "task_group_view_node_orders",
    "task_group_workspace_bootstraps",
  ];
  if (required.some((table) => !tableExists(db, table))) return undefined;

  const bootstrapWorkspaceKeyByGroup = new Map(
    (
      db
        .prepare(
          "SELECT workspace_key AS workspaceKey,group_id AS groupId FROM task_group_workspace_bootstraps WHERE group_id IS NOT NULL",
        )
        .all() as Array<{ workspaceKey: string; groupId: string }>
    ).map((row) => [String(row.groupId), String(row.workspaceKey)]),
  );
  const groups = (
    db
      .prepare(
        "SELECT group_id AS id,title,color,created_at AS createdAt,updated_at AS updatedAt FROM task_groups ORDER BY created_at,group_id",
      )
      .all() as Array<{
      id: string;
      title: string;
      color: string;
      createdAt: number;
      updatedAt: number;
    }>
  )
    .filter((row) => {
      const bootstrapWorkspaceKey = bootstrapWorkspaceKeyByGroup.get(String(row.id));
      return (
        !bootstrapWorkspaceKey ||
        !visibleWorkspaceKeys ||
        visibleWorkspaceKeys.has(bootstrapWorkspaceKey)
      );
    })
    .map((row) => ({
      id: String(row.id),
      title: String(row.title),
      color: TASK_GROUP_COLORS.has(row.color as ProjectTaskGroupColor)
        ? (row.color as ProjectTaskGroupColor)
        : ("gray" as const),
      createdAt: Number(row.createdAt),
      updatedAt: Number(row.updatedAt),
    }));

  const members = (
    db
      .prepare(
        `SELECT group_id AS groupId,workspace_key AS workspaceKey,workspace_path AS workspacePath,
          workspace_identity AS workspaceIdentity,task_id AS taskId,
          coalesce(sort_order,-added_at) AS sortOrder,added_at AS addedAt
         FROM task_group_members ORDER BY sortOrder,workspace_key,task_id`,
      )
      .all() as Array<{
      groupId: string;
      workspaceKey: string;
      workspacePath: string;
      workspaceIdentity: string | null;
      taskId: string;
      sortOrder: number;
      addedAt: number;
    }>
  ).map((row) => ({
    groupId: String(row.groupId),
    workspaceKey: String(row.workspaceKey),
    workspacePath: String(row.workspacePath),
    ...(row.workspaceIdentity ? { workspaceIdentity: String(row.workspaceIdentity) } : {}),
    taskId: String(row.taskId),
    sortOrder: row.sortOrder == null ? null : Number(row.sortOrder),
    addedAt: Number(row.addedAt),
  }));

  const topLevelOrders: ProjectTaskGroupTopOrder[] = [];
  for (const row of db
    .prepare(
      "SELECT node_type AS type,node_key AS key,sort_order AS sortOrder FROM task_group_view_node_orders ORDER BY sort_order,node_type,node_key",
    )
    .all() as Array<{ type: string; key: string; sortOrder: number }>) {
    if (row.type === "group") {
      topLevelOrders.push({
        type: "group",
        groupId: String(row.key),
        sortOrder: Number(row.sortOrder),
      });
      continue;
    }
    // 与 taskIndexRepo 相同：node_key = JSON.stringify([workspaceKey, taskId])。
    try {
      const parsed = JSON.parse(row.key) as unknown;
      if (Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
        topLevelOrders.push({
          type: "task",
          workspaceKey: parsed[0],
          taskId: parsed[1],
          sortOrder: Number(row.sortOrder),
        });
      }
    } catch {
      // 历史脏 node_key 跳过；客户端仍按任务事实补行，不让读取整体失败。
    }
  }

  return { groups, members, topLevelOrders };
}
