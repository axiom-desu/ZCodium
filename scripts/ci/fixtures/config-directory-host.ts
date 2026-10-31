import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TaskIndexRepo } from "../../../packages/services/src/session/taskIndexRepo.js";
import {
  createProjectService,
  createLegacySingleRootProjectService,
} from "../../../packages/services/src/project/index.js";
import { createPluginManagementService } from "../../../packages/services/src/plugins/pluginManagementService.js";
import {
  buildRemoteHostWorkspaceIdentity,
  buildServerRemoteWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
} from "@zcode/shared";

export const sourceA = "11111111-1111-4111-8111-111111111111";
export const sourceB = "22222222-2222-4222-8222-222222222222";
export const sourceOffline = "33333333-3333-4333-8333-333333333333";
export const sourceLegacy = "44444444-4444-4444-8444-444444444444";

/** 生产 Source 路由 hostId：remote:server:<id>（与 Host resolveProjectHostService 一致）。 */
// 只在本 fixture 内部把 Source id 变成生产 hostId；对外通过返回对象的 hostId 暴露。
function canonicalHostId(sourceServerId: string): string {
  const hostId = remoteHostIdFromWorkspaceIdentity(
    buildServerRemoteWorkspaceIdentity({ serverId: sourceServerId, workspacePath: "/" }),
  );
  if (!hostId) throw new Error("Invalid Source Server workspace identity");
  return hostId;
}

/**
 * 生产 Host 的 hostId 解析：只接受 canonical remote host identity。
 * `server:<id>` 这类旧形态必须像生产一样 typed 失败，不能在 fixture 里接受假别名。
 */
function resolveSourceServerId(hostId: string): string {
  const serverId = parseRemoteWorkspaceIdentity(
    buildRemoteHostWorkspaceIdentity(hostId, "/"),
  )?.sourceServerId;
  if (!serverId) throw new Error("project.host-offline");
  return serverId;
}

/** 生产 ProjectService + 临时 SQLite；插件薄服务仅替换 Agent IO 为隔离的文件配置端口。 */
export async function createConfigDirectoryHost(root: string) {
  const samePath = join(root, "same");
  const localRoot = join(root, "unopened");
  const extraRoot = join(root, "extra");
  await Promise.all(
    [samePath, localRoot, extraRoot].map((path) => mkdir(path, { recursive: true })),
  );
  const calls: Array<{ scope: string; method: string; params: Record<string, unknown> }> = [];
  const repos: TaskIndexRepo[] = [];
  const hosts = new Map();
  for (const hostId of [
    "local",
    "empty-local",
    canonicalHostId(sourceA),
    canonicalHostId(sourceB),
  ]) {
    const repo = new TaskIndexRepo(join(root, `${hostId.replaceAll(":", "-")}.sqlite`), 5000, {
      settings: { lastWorkspaceSession: [], recentProjects: [] },
      hostId: "local",
    });
    repos.push(repo);
    await repo.ensureReady();
    const service = createProjectService({
      repository: () => repo.getProjectRepository(),
      workspaceDirectory: join(root, "must-not-create"),
      // 真实远端服务返回的是「从自己看 local」；控制端必须以请求路由定 Source。
      ownerHostId: "local",
      resolveHost: async (id) => {
        const remote = hosts.get(id);
        if (!remote) throw new Error("offline");
        return remote;
      },
      directories: { home: async () => root, read: async () => [] },
    });
    hosts.set(hostId, service);
    if (hostId !== "empty-local")
      await service.saveProject({
        name: hostId === "local" ? "Unopened" : hostId,
        roots: hostId === "local" ? [localRoot, extraRoot] : [samePath],
      });
  }
  hosts.set(
    canonicalHostId(sourceLegacy),
    createLegacySingleRootProjectService({
      hostId: canonicalHostId(sourceLegacy),
      directories: {
        info: async () => ({ homedir: root, platform: "linux" }),
        read: async () => [],
      },
      readSettings: async () => ({
        lastWorkspaceSession: [{ kind: "local", workspacePath: samePath }],
        recentProjects: [],
      }),
      readKnownWorkspaces: async () => [{ workspacePath: samePath }],
      readTasks: async () => {
        throw new Error("catalog must not read legacy tasks");
      },
      ensureConversation: async () => {
        throw new Error("catalog must not create conversation");
      },
    }),
  );
  let onlineA = true;
  let generation = 1;
  let failMutation = false;
  const gates = new Map<string, { promise: Promise<void>; release(): void }>();
  const hold = (key: string) => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    gates.set(key, { promise, release });
  };
  const release = (key: string) => {
    gates.get(key)?.release();
    gates.delete(key);
  };
  const snapshot = () => ({
    generation,
    profiles: [],
    workspaceHistory: [],
    migrationCounts: [],
    failedPathCount: 0,
    abandonedPathCount: 0,
    servers: [sourceA, sourceB, sourceOffline, sourceLegacy].map((sourceServerId) => ({
      sourceServerId,
      displayName: sourceServerId,
      installState: "installed",
      declaredWorkspaces: [
        {
          workspacePath: samePath,
          workspaceIdentity: buildServerRemoteWorkspaceIdentity({
            serverId: sourceServerId,
            workspacePath: samePath,
          }),
        },
      ],
    })),
    states: [sourceA, sourceB, sourceOffline, sourceLegacy].map((sourceServerId) => ({
      profileId: sourceServerId,
      sourceServerId,
      state:
        sourceServerId === sourceOffline || (sourceServerId === sourceA && !onlineA)
          ? "offline"
          : "online",
      updatedAt: generation,
    })),
  });
  const configFile = (scope: string) => join(root, `plugin-config-${scope}.json`);
  const config = async (scope: string): Promise<Record<string, boolean>> => {
    try {
      return JSON.parse(await readFile(configFile(scope), "utf8"));
    } catch {
      return {};
    }
  };
  const plugins = new Map();
  for (const scope of ["local", sourceA, sourceB]) {
    const agent = new Proxy(
      {},
      {
        get: (_, method: string) => async (params: Record<string, unknown>) => {
          calls.push({ scope, method, params });
          await gates.get(`plugin:${scope}`)?.promise;
          const key = String(params.workspaceIdentity || params.workspacePath);
          const state = await config(scope);
          const plugin = {
            id: "fixture@fixture",
            name: `Plugin ${scope}`,
            enabled: state[key] ?? true,
            enabledSource: "workspace",
            source: "personal",
            rootPath: join(root, "fixture-plugin"),
            scope: "workspace",
            skills: [],
            mcpServers: [],
            commands: [],
            agents: [],
            hooks: [],
          };
          if (method === "listPlugins") return { plugins: [plugin], diagnostics: [] };
          if (method === "getPluginsOverview")
            return {
              marketplaces: [],
              availablePlugins: [
                {
                  id: plugin.id,
                  name: plugin.name,
                  marketplace: "fixture",
                  installed: true,
                  listing: { examplePrompts: ["Fixture example prompt"] },
                },
              ],
              installedPlugins: [],
              restorableBuiltins: [],
              diagnostics: [],
            };
          if (method === "setPluginEnabled") {
            if (failMutation) throw new Error("fixture configuration rejected");
            await writeFile(
              configFile(scope),
              JSON.stringify({ ...state, [key]: Boolean(params.enabled) }),
            );
            return { diagnostics: [] };
          }
          throw new Error(`Unexpected plugin operation: ${method}`);
        },
      },
    );
    plugins.set(
      scope,
      createPluginManagementService({
        zcodeAgentService: agent as Parameters<
          typeof createPluginManagementService
        >[0]["zcodeAgentService"],
      }),
    );
  }
  /** 生产 Host readProjects 路由：非法 hostId 由真实合同拒绝，不会落到假别名。 */
  const readProjectsFrom = async (
    scope: string,
    hostId: string | undefined,
    params: Record<string, unknown>,
  ) => {
    if (!hostId || hostId === "local") {
      const local = hosts.get(scope === "empty-local" ? "empty-local" : "local");
      if (!local) throw new Error("project.host-offline");
      return local.readProjects({ includeDeleted: params.includeDeleted as boolean | undefined });
    }
    const sourceServerId = resolveSourceServerId(hostId);
    const routeHostId = canonicalHostId(sourceServerId);
    const remote = hosts.get(routeHostId);
    if (!remote || (sourceServerId === sourceA && !onlineA))
      throw new Error("project.host-offline");
    const projects = await remote.readProjects({
      includeDeleted: params.includeDeleted as boolean | undefined,
    });
    if (sourceServerId === sourceA) await gates.get("catalog")?.promise;
    // 远端 Host 从自己看是 local；控制端归属由 RPC 调用方按可信路由覆盖。
    return projects.map((project: { hostId: string }) => ({ ...project, hostId: "local" }));
  };
  return {
    paths: { samePath, localRoot, extraRoot },
    calls,
    snapshot,
    hold,
    release,
    hostId: canonicalHostId,
    /** C1：真实 Host 路由合同——canonical 可读，server:<id> 必须被拒绝。 */
    async verifyHostRouting() {
      const projects = await readProjectsFrom("local", canonicalHostId(sourceA), {});
      if (!projects.some((project) => project.roots.some((root) => root.rootPath === samePath)))
        throw new Error("canonical hostId did not read remote roots");
      try {
        await readProjectsFrom("local", `server:${sourceA}`, {});
      } catch (error) {
        if (/Invalid remote host identity/.test(String(error?.message))) return;
        throw error;
      }
      throw new Error("server:<id> must be rejected by the real Host routing contract");
    },
    async call(scope: string, method: string, params: Record<string, unknown>) {
      if (method === "readProjects") {
        calls.push({ scope, method, params });
        return readProjectsFrom(scope, params.hostId as string | undefined, params);
      }
      const service = plugins.get(scope);
      if (!service || typeof service[method] !== "function")
        throw new Error("Unknown scope/service");
      return service[method](params);
    },
    setOnlineA(online: boolean) {
      onlineA = online;
      generation++;
    },
    failMutation(value: boolean) {
      failMutation = value;
    },
    config,
    async facts() {
      const trees = await Promise.all(
        [...hosts.entries()]
          .filter(([id]) => id !== canonicalHostId(sourceLegacy))
          .map(([, host]) => host.readTree()),
      );
      return {
        tasks: trees.reduce((count, tree) => count + tree.tasks.length, 0),
        files: await readdir(root),
      };
    },
    close() {
      for (const gate of gates.values()) gate.release();
      for (const repo of repos) repo.close();
    },
  };
}
