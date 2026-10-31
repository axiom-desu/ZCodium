import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveWorkspaceKey } from "@zcode/shared";
import type {
  AutoArchiveInput,
  ProjectDirectories,
  ProjectRepositoryContract,
  ProjectTaskGroupMoveInput,
  ProjectTaskRef,
  ProjectTaskReservationSettlement,
  ProjectTree,
  SaveProjectInput,
  VirtualProject,
} from "#src/project-storage/domain/contract.js";
import { ensureHost, OWNERSHIP_DECIDED } from "#src/project-storage/app/legacy-tasks.js";
import {
  parseExecutionDirectories,
  readProjects,
  readTask,
  readTasks,
  readTaskGroupStructure,
  requireProject,
  resolveDirectories,
  transaction,
} from "#src/project-storage/project-repository-read.js";
import {
  assertRemoteProjectRoots,
  assertRemoteTaskDirectories,
} from "#src/project-storage/domain/remote-policy.js";
import { moveTaskGroupNode as applyTaskGroupMove } from "#src/project-storage/app/task-group-move.js";
import {
  insertTaskReservationReceipt,
  settleTaskReservation,
} from "#src/project-storage/app/task-reservations.js";

export class ProjectRepository implements ProjectRepositoryContract {
  constructor(
    private readonly db: DatabaseSync,
    private readonly ownerHostId?: string,
  ) {}

  private get owner(): string {
    return this.ownerHostId ?? "local";
  }

  readTree(options?: {
    includeDeleted?: boolean;
    includeDeletedTasks?: boolean;
    includeTasks?: boolean;
  }): ProjectTree {
    const read = () => {
      const projects = readProjects(this.db, options?.includeDeleted ?? false).filter(
        (project) => project.hostId === this.owner,
      );
      const tasks =
        options?.includeTasks === false
          ? []
          : readTasks(this.db).filter((task) => task.hostId === this.owner);
      // 分组 bootstrap 只对所属 Host 的可见 workspace 生效；同库的其它 Host 组不能串树。
      const visibleWorkspaceKeys = new Set([
        ...projects.flatMap((project) => project.roots.map((root) => root.rootPath)),
        ...tasks.map((task) => task.workspaceIdentity?.trim() || task.workspacePath),
      ]);
      return {
        projects,
        ...(options?.includeDeletedTasks
          ? {
              deletedTasks: this.db
                .prepare(`
        SELECT task_id AS taskId,workspace_path AS workspacePath,workspace_identity AS workspaceIdentity,host_id AS hostId
        FROM tasks WHERE host_id=? AND (deleted=1 OR coalesce(cli_deleted,0)=1)`)
                .all(this.owner)
                .map((row) => ({
                  taskId: String(row.taskId),
                  workspacePath: String(row.workspacePath),
                  hostId: String(row.hostId),
                  ...(typeof row.workspaceIdentity === "string"
                    ? { workspaceIdentity: row.workspaceIdentity }
                    : {}),
                })),
            }
          : {}),
        tasks,
        ...(options?.includeTasks === false
          ? {}
          : { taskGroups: readTaskGroupStructure(this.db, visibleWorkspaceKeys) }),
      };
    };
    return this.db.isTransaction ? read() : transaction(this.db, read, false);
  }

  saveProject(input: SaveProjectInput): VirtualProject {
    return transaction(this.db, () => {
      const old =
        input.id || input.restoreProjectId
          ? requireProject(this.db, input.id ?? input.restoreProjectId!)
          : undefined;
      if (input.id && old?.deleted) throw new Error("project.deleted");
      const hostId = this.owner;
      if (old && old.hostId !== hostId) throw new Error("project.cross-host-move");
      if (input.hostId && input.hostId !== hostId) throw new Error("project.host-immutable");
      const roots = [...new Set(input.roots ?? old?.roots.map((root) => root.rootPath) ?? [])];
      assertRemoteProjectRoots(this.ownerHostId, roots, old);
      if (
        input.restoreProjectId &&
        (!old?.deleted ||
          roots.length !== old.roots.length ||
          roots.some((root) => !old.roots.some((entry) => entry.rootPath === root)))
      )
        throw new Error("project.restore-roots-mismatch");
      const primary =
        input.primaryRoot ??
        old?.roots.find((root) => root.isPrimary && roots.includes(root.rootPath))?.rootPath ??
        roots[0];
      if (primary !== undefined && !roots.includes(primary))
        throw new Error("project.invalid-primary-root");
      const id = old?.id ?? randomUUID();
      const overridden =
        input.name !== undefined ? input.name.trim().length > 0 : (old?.nameOverridden ?? false);
      const baseName =
        input.name?.trim() ||
        (overridden ? old?.name : undefined) ||
        (roots[0] ? basename(roots[0]) : input.defaultName?.trim() || old?.name || "New project");
      let name = baseName;
      for (
        let suffix = 2;
        this.db
          .prepare(
            "SELECT 1 FROM projects WHERE host_id=? AND name=? AND deleted=0 AND project_id<>?",
          )
          .get(hostId, name, id);
        suffix++
      )
        name = `${baseName} (${suffix})`;
      const now = Date.now();
      // 新建项目在同一 Host 写事务内取最小值减一，排在已有项目之前；编辑/恢复不改 position。
      this.db
        .prepare(`INSERT INTO projects(project_id,host_id,name,name_overridden,position,pinned,pinned_at,created_at,updated_at)
        VALUES(?,?,?,?,(SELECT coalesce(min(position),1)-1 FROM projects WHERE host_id=?),?,?,?,?)
        ON CONFLICT(project_id) DO UPDATE SET name=excluded.name,name_overridden=excluded.name_overridden,
        pinned=excluded.pinned,pinned_at=excluded.pinned_at,deleted=0,deleted_at=NULL,updated_at=excluded.updated_at`)
        .run(
          id,
          hostId,
          name,
          overridden ? 1 : 0,
          hostId,
          (input.pinned ?? old?.pinned) ? 1 : 0,
          (input.pinned ?? old?.pinned) ? now : null,
          now,
          now,
        );
      this.db.prepare("DELETE FROM project_roots WHERE project_id=?").run(id);
      roots.forEach((root, position) =>
        this.db
          .prepare(
            "INSERT INTO project_roots(project_id,root_path,position,is_primary) VALUES(?,?,?,?)",
          )
          .run(id, root, position, root === primary ? 1 : 0),
      );
      return requireProject(this.db, id);
    });
  }

  initializeProjectRoot(id: string, path: string): VirtualProject {
    return transaction(this.db, () => {
      const project = requireProject(this.db, id);
      if (project.hostId !== this.owner) throw new Error("project.cross-host-move");
      if (project.deleted) throw new Error("project.deleted");
      assertRemoteProjectRoots(this.ownerHostId, [path], project);
      if (!project.roots.length) {
        this.db
          .prepare(
            "INSERT INTO project_roots(project_id,root_path,position,is_primary) VALUES(?,?,0,1)",
          )
          .run(id, path);
        this.db.prepare("UPDATE projects SET updated_at=? WHERE project_id=?").run(Date.now(), id);
      }
      return requireProject(this.db, id);
    });
  }

  deleteProject(id: string): void {
    this.db
      .prepare(
        "UPDATE projects SET deleted=1,deleted_at=?,updated_at=? WHERE project_id=? AND deleted=0 AND host_id=?",
      )
      .run(Date.now(), Date.now(), id, this.owner);
  }

  moveTask(input: { task: ProjectTaskRef; projectId: string; addMissingRoot?: boolean }): void {
    transaction(this.db, () => {
      const project = requireProject(this.db, input.projectId);
      if (project.deleted) throw new Error("project.deleted");
      const task = readTask(this.db, input.task);
      if (!task) throw new Error("project.task-not-found");
      if (project.hostId !== this.owner || task.host_id !== project.hostId)
        throw new Error("project.cross-host-move");
      assertRemoteTaskDirectories(this.ownerHostId, project, String(task.root_path));
      if (!project.roots.some((root) => root.rootPath === task.root_path)) {
        if (!input.addMissingRoot) throw new Error("project.root-confirmation-required");
        this.db
          .prepare(
            "INSERT INTO project_roots(project_id,root_path,position,is_primary) VALUES(?,?,?,?)",
          )
          .run(
            project.id,
            String(task.root_path),
            project.roots.length,
            project.roots.length === 0 ? 1 : 0,
          );
      }
      this.db
        .prepare(
          "UPDATE tasks SET project_id=?,handoff_pending=handoff_pending | ? WHERE workspace_key=? AND task_id=?",
        )
        .run(project.id, OWNERSHIP_DECIDED, resolveWorkspaceKey(input.task), input.task.taskId);
    });
  }

  moveTaskGroupNode(input: ProjectTaskGroupMoveInput): void {
    // 分组移动与 readTree 共用同一 tasks-index 连接和事务；不新建 group store。
    transaction(this.db, () => applyTaskGroupMove(this.db, input, this.owner));
  }

  archiveInactive(input: AutoArchiveInput): ProjectTaskRef[] {
    return transaction(this.db, () => {
      const activeKeys = new Set(
        input.activeTasks.map((task) => JSON.stringify([resolveWorkspaceKey(task), task.taskId])),
      );
      const rows = this.db
        .prepare(
          `SELECT workspace_key,workspace_path,workspace_identity,task_id FROM tasks
           WHERE host_id=? AND archived=0 AND pinned=0 AND deleted=0
             AND coalesce(cli_deleted,0)=0 AND cli_created_at IS NOT NULL
             AND coalesce(cli_updated_at,0) < ?`,
        )
        .all(this.owner, input.cutoff) as Array<{
        workspace_key: string;
        workspace_path: string;
        workspace_identity: string | null;
        task_id: string;
      }>;
      const archive = this.db.prepare(
        "UPDATE tasks SET archived=1 WHERE workspace_key=? AND task_id=?",
      );
      const archived: ProjectTaskRef[] = [];
      for (const row of rows) {
        const ref: ProjectTaskRef = {
          workspacePath: String(row.workspace_path),
          ...(typeof row.workspace_identity === "string" && row.workspace_identity.length > 0
            ? { workspaceIdentity: row.workspace_identity }
            : {}),
          taskId: String(row.task_id),
        };
        if (activeKeys.has(JSON.stringify([String(row.workspace_key), String(row.task_id)])))
          continue;
        archive.run(row.workspace_key, row.task_id);
        archived.push(ref);
      }
      return archived;
    });
  }

  reorderProjects(ids: string[]): void {
    transaction(this.db, () => {
      if (new Set(ids).size !== ids.length) throw new Error("project.duplicate-order");
      ids.forEach((id, position) => {
        if (requireProject(this.db, id).hostId !== this.owner)
          throw new Error("project.cross-host-move");
        this.db.prepare("UPDATE projects SET position=? WHERE project_id=?").run(position, id);
      });
    });
  }

  resolveSessionDirectories(task: ProjectTaskRef): ProjectDirectories {
    return transaction(this.db, () => resolveDirectories(this.db, task, this.owner), false);
  }

  reserveCreatedTask(input: {
    task: ProjectTaskRef;
    projectId: string | null;
    additionalDirectories?: string[];
    freezeAdditionalDirectories?: true;
  }): ProjectDirectories {
    return transaction(this.db, () => {
      const key = resolveWorkspaceKey(input.task);
      const host = ensureHost(this.db, key, this.ownerHostId);
      // 身份无法证明时不回落到 local；拒绝写入而不是伪造归属。
      if (!host) throw new Error("project.host-authority-unknown");
      if (host !== this.owner) throw new Error("project.cross-host-move");
      if (!readTask(this.db, input.task)) {
        const project = input.projectId ? requireProject(this.db, input.projectId) : null;
        assertRemoteTaskDirectories(
          this.ownerHostId,
          project,
          input.task.workspacePath,
          input.additionalDirectories,
        );
        if (project) {
          if (project.deleted && input.additionalDirectories === undefined)
            throw new Error("project.deleted");
          if (project.hostId !== host) throw new Error("project.cross-host-move");
          if (
            input.additionalDirectories === undefined &&
            !project.roots.some((root) => root.rootPath === input.task.workspacePath)
          )
            throw new Error("project.cwd-not-in-roots");
        }
        // 创建归属必须先于 CLI 首发；空事实不是假会话，列表只读取已有 CLI 事实的行。
        this.db
          .prepare(`INSERT INTO tasks(workspace_key,workspace_path,workspace_identity,task_id,created_at,updated_at,host_id,root_path,project_id,handoff_pending,execution_directories)
          VALUES(?,?,?,?,0,0,?,?,?,?,?)`)
          .run(
            key,
            input.task.workspacePath,
            input.task.workspaceIdentity ?? null,
            input.task.taskId,
            host,
            input.task.workspacePath,
            input.projectId,
            OWNERSHIP_DECIDED,
            input.additionalDirectories === undefined
              ? null
              : JSON.stringify(parseExecutionDirectories(input.additionalDirectories)),
          );
        // 创建前的预占必须把“本次派生目录”固化成快照：roots 之后的编辑只影响新任务，
        // 不能改写已创建会话的冷恢复目录。普通预占（非创建路径）仍保留 NULL 语义。
        if (input.additionalDirectories === undefined && input.freezeAdditionalDirectories) {
          const derived = resolveDirectories(this.db, input.task, this.owner).additionalDirectories;
          this.db
            .prepare("UPDATE tasks SET execution_directories=? WHERE workspace_key=? AND task_id=?")
            .run(JSON.stringify(parseExecutionDirectories(derived)), key, input.task.taskId);
        }
        // receipt 与空行同事务：之后只有本次预占能被释放（见 app/task-reservations.ts）。
        insertTaskReservationReceipt(this.db, {
          workspaceKey: key,
          taskId: input.task.taskId,
          hostId: host,
          now: Date.now(),
        });
      }
      return resolveDirectories(this.db, input.task, this.owner);
    });
  }

  settleCreatedTaskReservation(input: {
    task: ProjectTaskRef;
    outcome: "cli-closed" | "input-forwarded";
  }): ProjectTaskReservationSettlement {
    // 与预占用同一个仓储事务；跨 Host 目标不会命中 receipt，因此只能释放本 Host 的预占。
    return transaction(this.db, () =>
      settleTaskReservation(this.db, input.task, this.owner, input.outcome),
    );
  }
}
