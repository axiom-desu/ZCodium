import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AppSettings, ZCodeTaskMeta } from "@zcode/shared";
import { TaskIndexRepo } from "../../../packages/services/src/session/taskIndexRepo.js";
import { createProjectService } from "../../../packages/services/src/project/app/index.js";
import { createProjectSessionCreationPort } from "../../../packages/services/src/project/app/sessionCreation.js";
import { reserveV4CreateSession } from "../../../packages/services/src/zcode-agent/v4CreateReservation.js";
import { createLegacySingleRootProjectService } from "../../../packages/services/src/project/adapters/legacy-single-root.js";
import type { IProjectService } from "../../../packages/services/src/project/domain/contract.js";

interface ProjectSidebarHostFixture {
  readonly service: IProjectService;
  readonly legacyService: IProjectService;
  readonly settings: AppSettings;
  readonly paths: {
    root: string;
    home: string;
    xdgConfig: string;
    xdgData: string;
    workspaceA: string;
    workspaceA2: string;
    workspaceB: string;
    workspaceC: string;
    unassignedRoot: string;
    legacyRoot: string;
  };
  saveProject(input: Parameters<IProjectService["saveProject"]>[0]): Promise<unknown>;
  deleteProject(id: string, hostId?: string): Promise<void>;
  reorderProjects(ids: string[]): Promise<void>;
  moveTask(input: Parameters<IProjectService["moveTask"]>[0]): Promise<void>;
  moveTaskGroupNode(input: Parameters<IProjectService["moveTaskGroupNode"]>[0]): Promise<void>;
  /** 模拟另一窗口已提交但广播尚未到达的外部编辑；只走同一 Repo 事务。 */
  moveTaskGroupNodeSilently(
    input: Parameters<IProjectService["moveTaskGroupNode"]>[0],
  ): Promise<void>;
  prepareSession(projectId?: string): ReturnType<IProjectService["prepareSession"]>;
  reserve(input: {
    task: Parameters<IProjectService["resolveSessionDirectories"]>[0];
    projectId: string | null;
    additionalDirectories?: string[];
  }): Promise<void>;
  /**
   * 生产 Host 的 v4 createSession 预占入口（同一 createProjectSessionCreationPort +
   * reserveV4CreateSession），供 E2E 验证 UI 传来的 projectId 冻结了哪些目录。
   */
  reserveV4Create(input: { projectId: string | null; commandId: string }): Promise<{
    sessionId: string;
    additionalDirectories: string[];
  }>;
  applyCliFacts(input: {
    taskId: string;
    title: string;
    workspacePath: string;
    workspaceIdentity?: string;
    createdAt: number;
    updatedAt: number;
    titleSource?: string;
    lastOutcome?: "completed" | "interrupted" | "error";
    deleted?: boolean;
  }): Promise<ZCodeTaskMeta>;
  updateTask(input: {
    op: "rename" | "pin" | "archive" | "unarchive" | "delete" | "unread";
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    title?: string;
    pinned?: boolean;
    unread?: boolean;
  }): Promise<ZCodeTaskMeta>;
  createTaskGroup(title: string): Promise<{ id: string; title: string }>;
  groupTask(
    groupId: string,
    taskRefs: Array<{ workspacePath: string; taskId: string }>,
  ): Promise<void>;
  readTree(): ReturnType<IProjectService["readTree"]>;
  close(): Promise<void>;
}

function taskMeta(input: {
  taskId: string;
  title: string;
  workspacePath: string;
  workspaceIdentity?: string;
  createdAt: number;
  updatedAt: number;
  lastOutcome?: "completed" | "interrupted" | "error";
}): ZCodeTaskMeta {
  return {
    taskId: input.taskId,
    traceId: `zcode-${input.taskId}`,
    title: input.title,
    workspacePath: input.workspacePath,
    ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    mode: "build",
    provider: "glm",
    ...(input.lastOutcome ? { status: input.lastOutcome === "error" ? "error" : "completed" } : {}),
  };
}

/**
 * 真实生产 ProjectService + TaskIndexRepo（临时 SQLite）；只把 Host 事件转发给浏览器测试夹具。
 * 不复制项目/任务业务逻辑，也不写第二份数据库。
 */
export async function createProjectSidebarHostFixture(options: {
  root: string;
  onProjectChange?: () => void;
  onWorkspaceTaskChanged?: (event: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    reason: string;
  }) => void;
}): Promise<ProjectSidebarHostFixture> {
  const home = join(options.root, "home");
  const xdgConfig = join(options.root, "xdg-config");
  const xdgData = join(options.root, "xdg-data");
  const workspaceA = join(options.root, "workspace-a");
  const workspaceA2 = join(options.root, "workspace-a2");
  const workspaceB = join(options.root, "workspace-b");
  const workspaceC = join(options.root, "workspace-c");
  const unassignedRoot = join(options.root, "unassigned-root");
  const legacyRoot = join(options.root, "legacy-root");
  await Promise.all(
    [
      home,
      xdgConfig,
      xdgData,
      workspaceA,
      workspaceA2,
      workspaceB,
      workspaceC,
      unassignedRoot,
      legacyRoot,
    ].map((path) => mkdir(path, { recursive: true })),
  );
  const settings: AppSettings = {
    lastWorkspaceSession: [],
    recentProjects: [],
    lastActiveTabIndex: 0,
  } as AppSettings;
  const repo = new TaskIndexRepo(join(xdgData, "tasks-index.sqlite"), 5000, {
    settings: { lastWorkspaceSession: [], recentProjects: [] },
    hostId: "local",
  });
  await repo.ensureReady();
  const service = createProjectService({
    repository: () => repo.getProjectRepository(),
    workspaceDirectory: join(xdgData, "workspace"),
    ownerHostId: "local",
    directories: {
      home: async () => home,
      read: async (params) => {
        const entries = await readdir(params.path, { withFileTypes: true });
        return entries.map((entry) => ({
          name: entry.name,
          path: join(params.path, entry.name),
          type: entry.isDirectory() ? ("directory" as const) : ("file" as const),
        }));
      },
    },
    afterChange: async () => {
      options.onProjectChange?.();
    },
  });
  const sessionCreationPort = createProjectSessionCreationPort({
    repository: () => repo.getProjectRepository(),
  });
  const legacyService = createLegacySingleRootProjectService({
    hostId: "legacy-remote",
    directories: {
      info: async () => ({ homedir: home, platform: "linux" }),
      read: async () => [],
    },
    readSettings: async () => ({
      lastWorkspaceSession: [{ kind: "local", workspacePath: legacyRoot }],
      recentProjects: [legacyRoot],
    }),
    readTasks: async () => [],
    ensureConversation: async () => "conversation",
    readKnownWorkspaces: async () => [{ workspacePath: legacyRoot }],
  });

  const emitTaskChanged = (input: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    reason: string;
  }) => {
    options.onWorkspaceTaskChanged?.({
      workspacePath: input.workspacePath,
      ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
      taskId: input.taskId,
      reason: input.reason,
    });
  };

  return {
    service,
    legacyService,
    settings,
    paths: {
      root: options.root,
      home,
      xdgConfig,
      xdgData,
      workspaceA,
      workspaceA2,
      workspaceB,
      workspaceC,
      unassignedRoot,
      legacyRoot,
    },
    saveProject: (input) => service.saveProject(input),
    deleteProject: (id, hostId) => service.deleteProject(id, hostId),
    reorderProjects: (ids) => service.reorderProjects(ids),
    moveTask: (input) => service.moveTask(input),
    moveTaskGroupNode: (input) => service.moveTaskGroupNode(input),
    moveTaskGroupNodeSilently: async (input) => {
      (await repo.getProjectRepository()).moveTaskGroupNode(input);
    },
    prepareSession: (projectId) => service.prepareSession(projectId ? { projectId } : {}),
    reserve: async (input) => {
      await (await repo.getProjectRepository()).reserveCreatedTask(input);
    },
    reserveV4Create: async (input) => {
      const repository = await repo.getProjectRepository();
      const project = repository
        .readTree({ includeTasks: false })
        .projects.find((candidate) => candidate.id === input.projectId);
      const workspacePath = project?.roots.find((root) => root.isPrimary)?.rootPath ?? workspaceA;
      return reserveV4CreateSession({
        workspace: { workspacePath },
        envelope: { clientId: "project-sidebar-smoke", commandId: input.commandId },
        payload: {},
        projectId: input.projectId,
        prepareSessionCreation: sessionCreationPort.prepareSessionCreation,
      });
    },
    applyCliFacts: async (input) => {
      const meta = await repo.applyCliFacts({
        meta: taskMeta(input),
        ...(input.titleSource ? { titleSource: input.titleSource } : {}),
        ...(input.lastOutcome ? { lastOutcome: input.lastOutcome } : {}),
        ...(input.deleted !== undefined ? { deleted: input.deleted } : {}),
      });
      emitTaskChanged({
        taskId: input.taskId,
        workspacePath: input.workspacePath,
        ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
        reason: input.deleted ? "task_deleted" : "task_created",
      });
      return meta;
    },
    updateTask: async (input) => {
      if (input.op === "delete") {
        await repo.deleteTask({
          workspacePath: input.workspacePath,
          ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
          taskId: input.taskId,
        });
        emitTaskChanged({
          taskId: input.taskId,
          workspacePath: input.workspacePath,
          ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
          reason: "task_deleted",
        });
        return taskMeta({
          taskId: input.taskId,
          title: "",
          workspacePath: input.workspacePath,
          createdAt: 0,
          updatedAt: 0,
        });
      }
      const patch =
        input.op === "rename"
          ? { title: input.title ?? "", titleOverridden: true }
          : input.op === "pin"
            ? { pinned: Boolean(input.pinned) }
            : input.op === "archive"
              ? { archived: true }
              : input.op === "unarchive"
                ? { archived: false }
                : { unreadAt: input.unread ? Date.now() : undefined };
      const meta = await repo.updateTaskState({
        workspacePath: input.workspacePath,
        ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
        taskId: input.taskId,
        patch,
      });
      emitTaskChanged({
        taskId: input.taskId,
        workspacePath: input.workspacePath,
        ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
        reason: input.op === "archive" ? "task_archived" : "task_title_changed",
      });
      return meta;
    },
    createTaskGroup: async (title) => {
      const group = await repo.createTaskGroup({ title });
      return { id: group.id, title: group.title };
    },
    groupTask: async (groupId, taskRefs) => {
      const tree = (await repo.getProjectRepository()).readTree();
      const scopes = [
        ...new Set([
          ...tree.projects.flatMap((project) => project.roots.map((root) => root.rootPath)),
          ...tree.tasks.map((task) => task.workspacePath),
        ]),
      ].map((workspacePath) => ({ workspacePath }));
      await repo.applyGroupedTaskViewOrder({
        workspaceScopes: scopes,
        topLevelNodes: [{ type: "group", groupId }],
        groups: [{ groupId, taskRefs }],
      });
    },
    readTree: () => service.readTree({ includeDeleted: true }),
    close: async () => {
      repo.close();
      await rm(options.root, { recursive: true, force: true });
    },
  };
}
