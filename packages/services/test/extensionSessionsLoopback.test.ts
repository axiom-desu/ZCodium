import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createExtensionHostClient,
  createExtensionContext,
} from "@zcode/shared/extension-host/sdk";
import { createAppControlService } from "#src/app-control/index.js";
import {
  createExtensionsService,
  type ExtensionsService,
} from "#src/extensions/adapters/service.js";
import { projectStorage } from "#src/project-storage/index.js";

/**
 * 扩展会话能力的真实纵向：扩展 SDK → 回环 HTTP → 能力网关 → extensions service →
 * 真实 `createAppControlService` → 临时 SQLite 项目仓储。
 *
 * 不使用 mock 网关：项目/任务事实来自 `project-storage` 的临时仓库；正文与 mutation
 * 端口仍由本 Host 的既有 owner 形态提供（临时库里可见改名结果）。两个插件验证幂等命名空间
 * 不能跨插件复用。只用临时目录与 127.0.0.1。
 */
const NOW = 1_700_000_000_000;

interface Fixture {
  root: string;
  workspacePath: string;
  db: DatabaseSync;
  repo: ReturnType<typeof projectStorage.repository>;
  service: ExtensionsService;
  starts: Array<{ pluginId: string; endpoint: string; token: string; generation: number }>;
  sent: Array<{ pluginId: string; traceId: string; content: string }>;
  running: { value: boolean };
  renameGate: { wait: Promise<void> | null; started: Promise<void> | null; release: () => void };
  contextFor(pluginId: string): ReturnType<typeof createExtensionContext>;
  cleanup(): Promise<void>;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "zcode-ext-sessions-repo-"));
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath, { recursive: true });
  const pluginDir = join(root, "extensions");
  for (const pluginId of ["alpha", "beta"]) {
    await mkdir(join(pluginDir, pluginId), { recursive: true });
    await writeFile(
      join(pluginDir, pluginId, "extension.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: pluginId,
        name: `${pluginId} sessions`,
        version: "1.0.0",
        main: "extension.mjs",
        capabilities: [
          "sessions.listProjects",
          "sessions.listSessions",
          "sessions.readSession",
          "sessions.waitSessions",
          "sessions.renameSession",
          "sessions.sendToSession",
        ],
        grants: ["sessions.write"],
        protocols: { sessions: 1 },
        slots: [],
      }),
    );
    await writeFile(join(pluginDir, pluginId, "extension.mjs"), "export function activate() {}\n");
  }

  const db = new DatabaseSync(join(root, "tasks-index.sqlite"));
  db.exec(`CREATE TABLE tasks (
    workspace_key TEXT NOT NULL, workspace_path TEXT NOT NULL, workspace_identity TEXT,
    task_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', task_status TEXT,
    provider TEXT DEFAULT 'glm', mode TEXT NOT NULL DEFAULT 'build', model TEXT,
    migration_source TEXT, forked_from_task_id TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, unread_at INTEGER,
    last_unread_at INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
    title_overridden INTEGER NOT NULL DEFAULT 0, meta_json TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY(workspace_key, task_id));`);
  await projectStorage.migrate(db, {
    backupDirectories: [join(root, "backup")],
    settings: { lastWorkspaceSession: [], recentProjects: [] },
  });
  const repo = projectStorage.repository(db);
  const project = repo.saveProject({ name: "Sessions Project" });
  repo.initializeProjectRoot(project.id, workspacePath);
  db.prepare(
    `INSERT INTO tasks(
      workspace_key, workspace_path, task_id, title, provider, mode, created_at, updated_at,
      host_id, root_path, project_id, cli_title, cli_created_at, cli_updated_at,
      cli_last_outcome, cli_deleted, sort_order)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    workspacePath,
    workspacePath,
    "sess_a",
    "Session A",
    "glm",
    "build",
    NOW,
    NOW,
    "local",
    workspacePath,
    project.id,
    "Session A",
    NOW,
    NOW,
    "completed",
    0,
    1,
  );

  const running = { value: false };
  const sent: Fixture["sent"] = [];
  const renameGate = { wait: null as Promise<void> | null, started: null, release: () => {} };
  const readTask = () => repo.readTree().tasks.find((task) => task.taskId === "sess_a");
  const appControl = createAppControlService({
    sourceServerId: "local",
    projects: {
      async readTree(options) {
        return repo.readTree(options);
      },
      async readProjects() {
        return repo.readTree().projects.map((entry) => ({
          id: entry.id,
          hostId: "local",
          name: entry.name,
          deleted: false,
        }));
      },
      async prepareSession() {
        return { workspacePath, projectId: project.id, additionalDirectories: [] };
      },
    },
    tasks: {
      async getTaskMeta() {
        const task = readTask();
        if (!task) return null;
        return {
          taskId: task.taskId,
          title: task.title,
          status: running.value ? "running" : task.status,
          updatedAt: task.updatedAt,
        };
      },
      async createTask() {
        return { taskId: "sess_new", workspacePath };
      },
      async sendPrompt(params) {
        sent.push({ pluginId: "unknown", traceId: params.traceId, content: params.content });
      },
      async stopGeneration() {
        return { applied: true };
      },
      async renameTask(params) {
        // 真实落库：ACK 可能因撤销丢弃，但 mutation 结果必须能在仓库里看到。
        db.prepare(
          "UPDATE tasks SET title=?, title_overridden=1 WHERE workspace_key=? AND task_id=?",
        ).run(params.title, workspacePath, params.taskId);
        renameGate.started?.();
        renameGate.started = null;
        if (renameGate.wait) await renameGate.wait;
      },
      async setTaskPinned() {},
      async archiveTask() {},
      async unarchiveTask() {},
    },
    agent: {
      async readSessionMessages() {
        return [
          { id: "m1", role: "user", text: "hello" },
          { id: "m2", role: "assistant", text: "hi" },
        ];
      },
      async readLiveSession() {
        return { status: "idle" as const };
      },
    },
  });

  const starts: Fixture["starts"] = [];
  const service = createExtensionsService({
    grantsFilePath: join(pluginDir, "grants.json"),
    pluginDir,
    workspaceIdentity: () => `local:${workspacePath}`,
    processSupervisor: {
      async start(input) {
        starts.push({
          pluginId: input.pluginId,
          endpoint: input.endpoint,
          token: input.token,
          generation: input.generation,
        });
        return { pid: 1 };
      },
      async stop() {},
      async stopPlugin() {},
    },
    readSettings: async () => ({ locale: "en-US" }),
    readProjects: async () =>
      repo.readTree().projects.map((entry) => ({ id: entry.id, name: entry.name })),
    appControl: { service: appControl, sourceServerId: "local" },
  });
  for (const pluginId of ["alpha", "beta"]) {
    await service.grant({ pluginId, grants: ["sessions.write"] });
  }
  const snapshot = await service.start();
  if (snapshot.phase !== "ready") throw new Error(snapshot.error ?? "extension host not ready");

  return {
    root,
    workspacePath,
    db,
    repo,
    service,
    starts,
    sent,
    running,
    renameGate,
    contextFor(pluginId) {
      const started = starts.find((entry) => entry.pluginId === pluginId);
      if (!started) throw new Error(`plugin ${pluginId} did not start`);
      return createExtensionContext(
        createExtensionHostClient({
          endpoint: started.endpoint,
          token: started.token,
          generation: started.generation,
          workspaceIdentity: `local:${workspacePath}`,
          pluginId,
        }),
        pluginId,
      );
    },
    async cleanup() {
      await service.dispose().catch(() => {});
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const fixtures: Fixture[] = [];
afterEach(async () => {
  while (fixtures.length > 0) await fixtures.pop()!.cleanup();
});
async function fixture(): Promise<Fixture> {
  const value = await createFixture();
  fixtures.push(value);
  return value;
}

describe("extension session facade over real loopback and a temporary repository", () => {
  it("lists and reads repository-backed sessions and persists a rename", async () => {
    const f = await fixture();
    const alpha = f.contextFor("alpha");
    const listed = await alpha.sessions.listSessions({});
    expect(listed.sessions.map((session) => session.title)).toEqual(["Session A"]);

    const read = await alpha.sessions.readSession({ sessionId: "sess_a", view: "messages" });
    expect(read.view).toBe("messages");
    if (read.view === "messages") {
      expect(read.messages.map((message) => message.text)).toEqual(["hello", "hi"]);
    }

    const renamed = await alpha.sessions.renameSession({
      sessionId: "sess_a",
      title: "Renamed in repository",
      requestId: "req-rename-1",
    });
    expect(renamed).toEqual({ status: "applied", requestId: "req-rename-1" });
    expect(f.repo.readTree().tasks[0]?.title).toBe("Renamed in repository");
  });

  it("namespaces the idempotency key per plugin, not per session", async () => {
    const f = await fixture();
    const alpha = f.contextFor("alpha");
    const beta = f.contextFor("beta");
    const send = { sessionId: "sess_a", prompt: "hello", requestId: "req-shared" } as const;
    await alpha.sessions.sendToSession(send);
    await beta.sessions.sendToSession(send);
    await alpha.sessions.sendToSession(send);
    const traces = f.sent.map((entry) => entry.traceId);
    expect(traces).toHaveLength(3);
    // 两个插件的同名 requestId 必须是两条不同命令；同插件重放才命中同一身份。
    expect(traces[0]).not.toBe(traces[1]);
    expect(traces[2]).toBe(traces[0]);
  });

  it("rejects a token that claims another plugin identity", async () => {
    const f = await fixture();
    const alpha = f.starts.find((entry) => entry.pluginId === "alpha")!;
    const response = await fetch(`${alpha.endpoint}/capability`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${alpha.token}` },
      body: JSON.stringify({
        v: 1,
        generation: alpha.generation,
        workspaceIdentity: `local:${f.workspacePath}`,
        pluginId: "beta",
        capabilityId: "sessions.listSessions",
        input: {},
      }),
    });
    expect(await response.json()).toMatchObject({ ok: false, code: "unauthorized" });
  });

  it("keeps waitSessions pending on a running session and cancels it on revoke", async () => {
    const f = await fixture();
    const alpha = f.contextFor("alpha");
    f.running.value = true;
    const pending = alpha.sessions.waitSessions({
      operations: [{ sessionId: "sess_a", commandId: "cmd-1" }],
      mode: "any",
      timeoutMs: 30_000,
    });
    // 先挂拒绝处理，避免撤销发生在断言之前造成 unhandled rejection。
    pending.catch(() => {});
    const early = await Promise.race([
      pending.then(() => "settled"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 300)),
    ]);
    expect(early).toBe("pending");
    await f.service.revoke("alpha");
    await expect(pending).rejects.toMatchObject({ code: "canceled" });
  });

  it("settles waitSessions on stop without publishing a result", async () => {
    const f = await fixture();
    const beta = f.contextFor("beta");
    f.running.value = true;
    const pending = beta.sessions.waitSessions({
      operations: [{ sessionId: "sess_a", commandId: "cmd-2" }],
      mode: "any",
      timeoutMs: 30_000,
    });
    // 停止会先取消在途调用：从一开始就托管拒绝，测完再断言结论。
    const outcome = pending.then(
      () => null,
      (error: unknown) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    const stopped = await f.service.stop();
    expect(stopped.phase).toBe("stopped");
    // 停止先取消在途调用再关 loopback：调用必须结束，且不能拿到成功结果。
    expect(await outcome).toBeTruthy();
  });

  it("does not report a persisted rename as unexecuted when revoke drops the ACK", async () => {
    const f = await fixture();
    const alpha = f.contextFor("alpha");
    let release!: () => void;
    f.renameGate.wait = new Promise<void>((resolve) => {
      release = () => {
        f.renameGate.wait = null;
        resolve();
      };
    });
    const started = new Promise<void>((resolve) => {
      f.renameGate.started = resolve;
    });
    const pending = alpha.sessions.renameSession({
      sessionId: "sess_a",
      title: "Applied before ack",
      requestId: "req-late",
    });
    pending.catch(() => {});
    await started;
    await f.service.revoke("alpha");
    release();
    await expect(pending).rejects.toMatchObject({ code: "canceled" });
    expect(f.repo.readTree().tasks[0]?.title).toBe("Applied before ack");
  });
});
