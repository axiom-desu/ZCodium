import type { AppSettings, ZCodeTaskMeta } from "@zcode/shared";
import type {
  IFileService,
  IProjectService,
  ISettingService,
  ISystemService,
  IZCodeTaskService,
} from "@zcode/services";
import { describe, expect, it } from "vitest";
import { resolveServerProjectService } from "./remoteWorkspaceServiceCollection.js";

const HOST_ID = "remote:server:source-1";

interface TaskQuery {
  workspacePath: string;
  kind: "active" | "pinned" | "archived";
}

function createProjectSources(
  overrides: {
    recentProjects?: string[];
    conversationWorkspaces?: string[];
  } = {},
) {
  const taskQueries: TaskQuery[] = [];
  const directoryReads: string[] = [];
  const task = (workspacePath: string, taskId: string): ZCodeTaskMeta =>
    ({
      taskId,
      workspacePath,
      title: taskId,
      status: "completed",
      createdAt: 1,
      updatedAt: 1,
    }) as unknown as ZCodeTaskMeta;

  const system = {
    info: async () => ({ homedir: "/home/dev", platform: "linux" }),
  } as unknown as ISystemService;
  const file = {
    readdir: async (params: { path: string }) => {
      directoryReads.push(params.path);
      return [{ name: "child", path: `${params.path}/child`, isDirectory: true }];
    },
    ensureConversationWorkspace: async () => ({
      path: "/home/dev/.zcodium/conversations/draft",
      created: true,
      workspacePurpose: "conversation",
    }),
  } as unknown as IFileService;
  const settings = {
    get: async () =>
      ({
        recentProjects: overrides.recentProjects ?? ["/work-a", "/work-b"],
        lastWorkspaceSession: (overrides.conversationWorkspaces ?? []).map((workspacePath) => ({
          kind: "local" as const,
          workspacePath,
          workspacePurpose: "conversation" as const,
        })),
      }) as unknown as AppSettings,
  } as unknown as ISettingService;
  const tasks = {
    listTasks: async ({ workspacePath }: { workspacePath: string }) => {
      taskQueries.push({ workspacePath, kind: "active" });
      return [task(workspacePath, `active-${workspacePath}`)];
    },
    listPinnedTasks: async ({ workspacePath }: { workspacePath: string }) => {
      taskQueries.push({ workspacePath, kind: "pinned" });
      return [];
    },
    listArchivedTasks: async ({ workspacePath }: { workspacePath: string }) => {
      taskQueries.push({ workspacePath, kind: "archived" });
      return [task(workspacePath, `archived-${workspacePath}`)];
    },
  } as unknown as IZCodeTaskService;

  return { sources: { system, file, settings, tasks }, taskQueries, directoryReads };
}

describe("resolveServerProjectService", () => {
  it("uses the remote Project channel proxy only when the handshake declared virtualProjects", async () => {
    const project = {
      readTree: async () => ({ projects: [], tasks: [] }),
    } as unknown as IProjectService;
    const { sources } = createProjectSources();

    expect(
      resolveServerProjectService({
        serverId: "source-1",
        virtualProjects: true,
        services: { ...sources, project },
      }),
    ).toBe(project);

    expect(() =>
      resolveServerProjectService({
        serverId: "source-1",
        virtualProjects: true,
        services: sources,
      }),
    ).toThrow(/virtual-project RPC registration incomplete/u);
  });

  it("builds a real legacy single-root read adapter for Sources without virtualProjects", async () => {
    const { sources, taskQueries } = createProjectSources();
    const service = resolveServerProjectService({ serverId: "source-1", services: sources });

    const tree = await service.readTree();
    expect(tree.legacySingleRoot).toBe(true);
    expect(tree.projects.map((entry) => entry.hostId)).toEqual([HOST_ID, HOST_ID]);
    expect(tree.projects.map((entry) => entry.roots[0]?.rootPath)).toEqual(["/work-a", "/work-b"]);
    expect(tree.projects.every((entry) => entry.legacySingleRoot === true)).toBe(true);
    // 任务行来自远端既有 tasks-index 读取；树查询不启动 Agent（没有注入 agent 端口）。
    expect(tree.tasks.map((task) => task.hostId)).toEqual([HOST_ID, HOST_ID, HOST_ID, HOST_ID]);
    expect(tree.tasks.map((task) => task.projectId)).toEqual([
      tree.projects[0]!.id,
      tree.projects[0]!.id,
      tree.projects[1]!.id,
      tree.projects[1]!.id,
    ]);
    expect(new Set(taskQueries.map((query) => query.workspacePath))).toEqual(
      new Set(["/work-a", "/work-b"]),
    );
  });

  it("keeps conversation workspaces out of the synthetic project list", async () => {
    const { sources } = createProjectSources({
      recentProjects: ["/work-a", "/chat"],
      conversationWorkspaces: ["/chat"],
    });
    const service = resolveServerProjectService({ serverId: "source-1", services: sources });

    const projects = await service.readProjects();
    expect(projects.map((project) => project.roots[0]?.rootPath)).toEqual(["/work-a"]);
  });

  it("stays read-only and uses the remote conversation workspace for project-less sessions", async () => {
    const { sources } = createProjectSources();
    const service = resolveServerProjectService({ serverId: "source-1", services: sources });
    const project = (await service.readProjects())[0]!;

    await expect(service.saveProject({ name: "x" })).rejects.toThrow(/project.legacy-read-only/u);
    await expect(service.deleteProject(project.id)).rejects.toThrow(/project.legacy-read-only/u);
    await expect(service.reorderProjects([])).rejects.toThrow(/project.legacy-read-only/u);

    const directories = await service.prepareSession();
    expect(directories).toEqual({
      workspacePath: "/home/dev/.zcodium/conversations/draft",
      projectId: null,
      additionalDirectories: [],
    });

    const projectDirectories = await service.prepareSession({ projectId: project.id });
    expect(projectDirectories.workspacePath).toBe("/work-a");

    // 跨 Host 请求必须拒绝，不能把别的 Source 的项目挂到这个身份下。
    await expect(service.readTree({ hostId: "remote:server:other" })).rejects.toThrow(
      /project.cross-host-move/u,
    );
  });

  it("reads directories with the remote platform path rules", async () => {
    const { sources, directoryReads } = createProjectSources();
    const service = resolveServerProjectService({ serverId: "source-1", services: sources });

    await expect(service.readDirectory({ path: "/work-a" })).resolves.toMatchObject({
      path: "/work-a",
    });
    expect(directoryReads).toEqual(["/work-a"]);
    await expect(service.readDirectory({ path: "relative/path" })).rejects.toThrow(
      /project.absolute-path-required/u,
    );
  });
});
