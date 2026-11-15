import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createAppControlService,
  createExtensionsService,
  createLegacySingleRootProjectService,
  createSettingService,
} from "@zcode/services/node";
import { createExtensionHostSupervisor } from "../src/main/extensionHost/supervisor.js";

/**
 * 真实链路：已同意插件 → 独立子进程（stdio + loopback）→ 窗口 Host 扩展服务 → 现有服务。
 * 只用临时 HOME/工作区与回环地址，不读用户数据、不连远端。
 */
const WORKSPACE = "ext-integration-ws";

describe("extension host end-to-end", () => {
  let root = "";
  let pluginDir = "";
  let pluginOutput = "";
  let previousHome: string | undefined;
  let previousXdg: string | undefined;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "zcode-ext-e2e-"));
    pluginDir = join(root, "extensions");
    pluginOutput = join(pluginDir, "demo", "result.json");
    previousHome = process.env.HOME;
    previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.HOME = join(root, "home");
    process.env.XDG_CONFIG_HOME = join(root, "xdg-config");
    await mkdir(join(root, "home"), { recursive: true });
    await mkdir(join(root, "workspace", WORKSPACE), { recursive: true });
    await mkdir(join(pluginDir, "demo"), { recursive: true });
    await writeFile(
      join(pluginDir, "demo", "extension.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "demo",
        name: "Demo Extension",
        version: "1.0.0",
        main: "extension.mjs",
        capabilities: ["settings.get", "projects.list", "context.get"],
        grants: ["projects.read"],
        protocols: { projects: 1 },
        slots: [
          { id: "status-projects", slot: "status.composer", title: "Projects", icon: "list" },
        ],
      }),
    );
    await writeFile(
      join(pluginDir, "demo", "extension.mjs"),
      `import { writeFile } from "node:fs/promises";
const output = new URL("./result.json", import.meta.url);
export async function activate(ctx) {
  const record = { envToken: process.env.ZCODE_EXTENSION_HOST_TOKEN ?? null };
  try { record.settings = await ctx.settings.get(); } catch (error) { record.settingsError = error.code; }
  try { record.projects = await ctx.projects.list(); } catch (error) { record.projectsError = error.code; }
  await ctx.slots.contribute([{ id: "status-projects", slot: "status.composer", title: "Projects", icon: "list" }]);
  await writeFile(output, JSON.stringify(record));
  return () => {};
}
`,
    );
  });

  afterAll(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
  });

  it("only activates an approved plugin, serves existing services, revokes and fences the old token", async () => {
    const settingService = createSettingService();
    const workspacePath = join(root, "workspace", WORKSPACE);
    await settingService.update({ recentProjects: [workspacePath] });
    const projectService = createLegacySingleRootProjectService({
      hostId: "local",
      readSettings: () => settingService.get(),
      directories: {
        info: async () => ({ homedir: join(root, "home"), platform: process.platform }),
        read: async () => [],
      },
      readTasks: async () => [],
      ensureConversation: async () => workspacePath,
    });

    const supervisor = createExtensionHostSupervisor({
      workerPath: new URL("../src/main/extensionHost/worker.ts", import.meta.url).pathname,
      spawnArgs: [
        "--import",
        "tsx",
        new URL("../src/main/extensionHost/worker.ts", import.meta.url).pathname,
      ],
      startupTimeoutMs: 15_000,
      shutdownTimeoutMs: 3_000,
    });
    const seen: Array<{ endpoint: string; token: string; generation: number; pluginId: string }> =
      [];
    const service = createExtensionsService({
      grantsFilePath: join(root, "extensions", "grants.json"),
      pluginDir,
      workspaceIdentity: () => `local:${workspacePath}`,
      processSupervisor: {
        async start(input) {
          seen.push({
            endpoint: input.endpoint,
            token: input.token,
            generation: input.generation,
            pluginId: input.pluginId,
          });
          return supervisor.start(42, input);
        },
        stop: (generation) => supervisor.stop(42, generation).then(() => undefined),
        stopPlugin: (generation, pluginId) =>
          supervisor.stopPlugin(42, generation, pluginId).then(() => undefined),
      },
      readSettings: async () => ({ locale: (await settingService.get()).locale }),
      readProjects: async () =>
        (await projectService.readProjects()).map((project) => ({
          id: project.id,
          name: project.name,
        })),
    });

    try {
      // 发现不等于激活：同意前不启动任何插件进程。
      const discovered = await service.getSnapshot();
      expect(discovered.plugins[0]?.status).toBe("needs-consent");
      expect(seen).toEqual([]);

      await service.grant({ pluginId: "demo", grants: ["projects.read"] });
      const started = await service.start();
      expect(started.phase, started.error ?? "").toBe("ready");
      expect(started.generation).toBe(1);
      expect(seen).toHaveLength(1);
      expect(supervisor.hasPlugin(42, "demo")).toBe(true);

      const output = await waitForOutput(
        pluginOutput,
        (value) => Array.isArray(value.projects) && value.settings !== undefined,
      );
      expect(output.envToken).toBeNull();
      expect(seen[0]?.token.length).toBeGreaterThan(0);
      expect(output.projects?.[0]?.name).toBe(WORKSPACE);
      expect(output.settings?.locale).toBeTruthy();
      expect(started.slots.map((slot) => slot.id)).toEqual(["status-projects"]);

      // 非 token 与带 Origin（浏览器/手机 Web）的请求被拒绝。
      const { endpoint, token } = seen[0]!;
      const requestBody = {
        v: 1,
        generation: 1,
        workspaceIdentity: `local:${workspacePath}`,
        pluginId: "demo",
        capabilityId: "settings.get",
      };
      const unauthorized = await fetch(`${endpoint}/capability`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      expect(unauthorized.status).toBe(401);
      const originDenied = await fetch(`${endpoint}/capability`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          origin: "http://127.0.0.1:3000",
        },
        body: JSON.stringify(requestBody),
      });
      expect(originDenied.status).toBe(401);

      // 撤销：该插件进程停止、槽位消失，旧 token 立刻失效。
      const revoked = await service.revoke("demo");
      expect(revoked.slots).toEqual([]);
      expect(revoked.plugins[0]?.status).toBe("needs-consent");
      expect(supervisor.hasPlugin(42, "demo")).toBe(false);
      const stale = await fetch(`${endpoint}/capability`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(requestBody),
      });
      expect(stale.status).toBe(401);

      await service.stop();
      await expect(fetch(`${endpoint}/capability`, { method: "POST" })).rejects.toThrow();
      expect(supervisor.has(42)).toBe(false);
    } finally {
      await service.dispose();
      await supervisor.disposeAll();
    }
  }, 60_000);

  it("serves session read/mutation to a real child through App control", async () => {
    const now = Date.now();
    const workspacePath = join(root, "workspace", WORKSPACE);
    const sessionPluginDir = join(pluginDir, "sessions");
    const outputPath = join(sessionPluginDir, "result.json");
    await mkdir(sessionPluginDir, { recursive: true });
    await writeFile(
      join(sessionPluginDir, "extension.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "sessions",
        name: "Sessions Extension",
        version: "1.0.0",
        main: "extension.mjs",
        capabilities: ["sessions.listSessions", "sessions.readSession", "sessions.renameSession"],
        grants: ["sessions.write"],
        protocols: { sessions: 1 },
        slots: [],
      }),
    );
    await writeFile(
      join(sessionPluginDir, "extension.mjs"),
      `import { writeFile } from "node:fs/promises";
const output = new URL("./result.json", import.meta.url);
export async function activate(ctx) {
  const record = {};
  try { record.list = await ctx.sessions.listSessions({}); } catch (error) { record.listError = error.code; }
  try { record.read = await ctx.sessions.readSession({ sessionId: "sess_a", view: "messages" }); } catch (error) { record.readError = error.code; }
  try { record.rename = await ctx.sessions.renameSession({ sessionId: "sess_a", title: "Renamed by child", requestId: "req-child" }); } catch (error) { record.renameError = error.code; }
  await writeFile(output, JSON.stringify(record));
  return () => {};
}
`,
    );
    const settingService = createSettingService();
    await settingService.update({ recentProjects: [workspacePath] });
    const projectService = createLegacySingleRootProjectService({
      hostId: "local",
      readSettings: () => settingService.get(),
      directories: {
        info: async () => ({ homedir: join(root, "home"), platform: process.platform }),
        read: async () => [],
      },
      // 会话行由“远端索引”的 active 分区提供；置顶/归档分区为空，避免同一行被覆盖成 archived。
      readTasks: async (input) =>
        input.kind === "active"
          ? ([
              {
                taskId: "sess_a",
                workspacePath,
                title: "Integration Session",
                status: "completed",
                updatedAt: now,
              },
            ] as never)
          : ([] as never),
      ensureConversation: async () => workspacePath,
    });
    const renamed: string[] = [];
    const appControl = createAppControlService({
      sourceServerId: "local",
      projects: {
        readTree: () => projectService.readTree(),
        readProjects: () => projectService.readProjects(),
        prepareSession: (options) => projectService.prepareSession(options),
      },
      tasks: {
        async getTaskMeta(params) {
          return {
            taskId: params.taskId,
            title: "Integration Session",
            status: "completed",
            updatedAt: now,
          };
        },
        async createTask() {
          return { taskId: "sess_new", workspacePath };
        },
        async sendPrompt() {},
        async stopGeneration() {
          return { applied: true };
        },
        async renameTask(params) {
          renamed.push(params.title);
        },
        async setTaskPinned() {},
        async archiveTask() {},
        async unarchiveTask() {},
      },
      agent: {
        async readSessionMessages() {
          return [{ id: "m1", role: "assistant", text: "hello from child" }];
        },
        async readLiveSession() {
          return { status: "idle" as const };
        },
      },
    });
    const supervisor = createExtensionHostSupervisor({
      workerPath: new URL("../src/main/extensionHost/worker.ts", import.meta.url).pathname,
      spawnArgs: [
        "--import",
        "tsx",
        new URL("../src/main/extensionHost/worker.ts", import.meta.url).pathname,
      ],
      startupTimeoutMs: 15_000,
      shutdownTimeoutMs: 3_000,
    });
    const seen: Array<{ endpoint: string; token: string; generation: number }> = [];
    const service = createExtensionsService({
      grantsFilePath: join(root, "sessions-grants.json"),
      // 发现根仍是 extensions/；只有被同意的 sessions 插件会启动，demo 保持未加载。
      pluginDir,
      workspaceIdentity: () => `local:${workspacePath}`,
      processSupervisor: {
        async start(input) {
          seen.push({ endpoint: input.endpoint, token: input.token, generation: input.generation });
          return supervisor.start(43, input);
        },
        stop: (generation) => supervisor.stop(43, generation).then(() => undefined),
        stopPlugin: (generation, pluginId) =>
          supervisor.stopPlugin(43, generation, pluginId).then(() => undefined),
      },
      readSettings: async () => ({ locale: (await settingService.get()).locale }),
      readProjects: async () =>
        (await projectService.readProjects()).map((project) => ({
          id: project.id,
          name: project.name,
        })),
      appControl: { service: appControl, sourceServerId: "local" },
    });
    try {
      await service.grant({ pluginId: "sessions", grants: ["sessions.write"] });
      const started = await service.start();
      expect(started.phase, started.error ?? "").toBe("ready");
      const output = await waitForJson<SessionOutput>(
        outputPath,
        (value) => value.rename !== undefined || value.renameError !== undefined,
      );
      expect(output.listError).toBeUndefined();
      expect(output.list?.sessions[0]?.title).toBe("Integration Session");
      expect(output.read?.messages.map((message) => message.text)).toEqual(["hello from child"]);
      expect(output.rename).toEqual({ status: "applied", requestId: "req-child" });
      expect(renamed).toEqual(["Renamed by child"]);

      // 撤销会话写权限后，子进程停止、旧 token 立刻失效。
      const revoked = await service.revoke("sessions");
      expect(revoked.plugins[0]?.status).toBe("needs-consent");
      expect(supervisor.hasPlugin(43, "sessions")).toBe(false);
      const stale = await fetch(`${seen[0]!.endpoint}/capability`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${seen[0]!.token}`,
        },
        body: JSON.stringify({
          v: 1,
          generation: seen[0]!.generation,
          workspaceIdentity: `local:${workspacePath}`,
          pluginId: "sessions",
          capabilityId: "sessions.listSessions",
          input: {},
        }),
      });
      expect(stale.status).toBe(401);
    } finally {
      await service.dispose();
      await supervisor.disposeAll();
    }
  }, 60_000);
});

async function waitForJson<T>(path: string, predicate: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const raw = await readFile(path, "utf8").catch(() => null);
    if (raw) {
      const parsed = JSON.parse(raw) as T;
      if (predicate(parsed)) return parsed;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("extension did not publish its result in time");
}

interface SessionOutput {
  listError?: string;
  readError?: string;
  renameError?: string;
  list?: { sessions: Array<{ title?: string }> };
  read?: { messages: Array<{ text?: string }> };
  rename?: { status: string; requestId: string };
}

async function waitForOutput(
  path: string,
  predicate: (value: DemoOutput) => boolean,
): Promise<DemoOutput> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const raw = await readFile(path, "utf8").catch(() => null);
    if (raw) {
      const parsed = JSON.parse(raw) as DemoOutput;
      if (predicate(parsed)) return parsed;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("extension did not publish its result in time");
}

interface DemoOutput {
  envToken?: string | null;
  settings?: { locale?: string };
  settingsError?: string;
  projects?: Array<{ id?: string; name?: string }>;
  projectsError?: string;
}
