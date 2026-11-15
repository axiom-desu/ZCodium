import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { projectStorage } from "#src/project-storage/index.js";
import { SessionControlError } from "@zcode/session-control/contracts";
import { createAppControlService } from "#src/app-control/index.js";
import { createAppControlRequestHandler } from "#src/app-control/rpc.js";
import { ZCodeProtocolClient } from "#src/zcode-agent/zcodeProtocolClient.js";
import { ZCodeStdioTransport } from "#src/zcode-agent/zcodeStdioTransport.js";

const root = await mkdtemp(join(tmpdir(), "zcode-rust-app-control-vertical-"));
const binary = join(process.cwd(), "apps/zcode-cli-rust/target/debug/zcode-cli-rust");
const worktree = join(root, "workspace");
const dataDir = join(root, "data");
const configPath = join(root, "model.json");
const home = join(root, "home");
const dbPath = join(root, "tasks-index.sqlite");
let db: DatabaseSync;
let child: ReturnType<typeof spawn> | undefined;
let client: ZCodeProtocolClient | undefined;
let transport: ZCodeStdioTransport | undefined;

after(async () => {
  await client?.disposeAndWait().catch(() => {});
  db?.close();
  await rm(root, { recursive: true, force: true });
});

function sseTool(id: string, name: string, input: unknown): string {
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 1 } } },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id, name, input: {} },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function sseText(text: string): string {
  return [
    { type: "message_start", message: { usage: { input_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
}

async function listenLoopback(script: string[]) {
  const server = createServer((socket) => {
    let data = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      data = Buffer.concat([data, chunk]);
      const boundary = data.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      const headers = data.subarray(0, boundary).toString("latin1");
      const length = Number(headers.match(/content-length:\s*(\d+)/i)?.[1] ?? 0);
      if (data.length < boundary + 4 + length) return;
      socket.removeAllListeners("data");
      const body = JSON.parse(data.subarray(boundary + 4, boundary + 4 + length).toString());
      requests.push(body);
      const payload = script.shift() ?? sseText("done");
      socket.end(
        `HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`,
      );
    });
  });
  const requests: unknown[] = [];
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, url: `http://127.0.0.1:${address.port}`, requests };
}

test("native app-server NDJSON ↔ Node Host AppControlService real loopback vertical", async () => {
  const provider = await listenLoopback([
    sseTool("native-list", "ListProjects", { query: "vertical" }),
    sseTool("native-read", "ReadSession", { sessionId: "sess_a", view: "summary" }),
    sseTool("native-rename", "RenameSession", { sessionId: "sess_a", title: "Renamed by native" }),
    sseText("completed"),
  ]);
  try {
    await mkdir(worktree, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await mkdir(home, { recursive: true });
    const model = {
      providerId: "r7d-loopback",
      modelId: "r7d-loopback",
      reasoningLevel: "none",
      baseUrl: provider.url,
      apiKeyEnv: "R7D_LOOPBACK_KEY",
      apiType: "anthropic-messages",
      formatProperties: {
        inputFormat: { supportsText: true },
        outputFormat: { supportsText: true },
        supportsToolCall: true,
      },
      retry: { maxRetries: 0, baseDelayMs: 0, jitter: false },
      streamIdleTimeoutMs: 5000,
      contextWindow: 200000,
      maxOutputTokens: 4096,
      contextBufferTokens: 1000,
    };
    await writeFile(configPath, JSON.stringify(model));

    db = new DatabaseSync(dbPath);
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
    const project = repo.saveProject({ name: "Vertical Project" });
    repo.initializeProjectRoot(project.id, worktree);
    db.prepare(`INSERT INTO tasks(
      workspace_key, workspace_path, task_id, title, provider, mode, created_at, updated_at,
      host_id, root_path, project_id, cli_title, cli_created_at, cli_updated_at,
      cli_last_outcome, cli_deleted, sort_order)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      worktree,
      worktree,
      "sess_a",
      "Before",
      "glm",
      "build",
      Date.now(),
      Date.now(),
      "local",
      worktree,
      project.id,
      "Before",
      Date.now(),
      Date.now(),
      "completed",
      0,
      1,
    );

    const service = createAppControlService({
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
          return { workspacePath: worktree, additionalDirectories: [], projectId: project.id };
        },
      },
      tasks: {
        async getTaskMeta(params) {
          const task = repo.readTree().tasks.find((entry) => entry.taskId === params.taskId);
          return task
            ? {
                taskId: task.taskId,
                title: task.title,
                status: task.status,
                updatedAt: task.updatedAt,
              }
            : null;
        },
        async createTask() {
          return { taskId: "unused", workspacePath: worktree };
        },
        async sendPrompt() {},
        async stopGeneration() {
          return { applied: true };
        },
        async renameTask(params) {
          db.prepare(
            "UPDATE tasks SET title=?, cli_title=?, title_overridden=1 WHERE workspace_key=? AND task_id=?",
          ).run(params.title, params.title, worktree, params.taskId);
        },
        async setTaskPinned() {},
        async archiveTask() {},
        async unarchiveTask() {},
      },
      agent: {
        async readSessionMessages() {
          return { messages: [{ id: "m1", role: "user", text: "hello" }] };
        },
        async readLiveSession() {
          return null;
        },
      },
    });

    child = spawn(
      binary,
      [
        "app-server",
        "--stdio",
        "--surface",
        "desktop",
        "--cwd",
        worktree,
        "--data-dir",
        dataDir,
        "--config",
        configPath,
      ],
      {
        cwd: worktree,
        env: {
          ...process.env,
          HOME: home,
          XDG_CONFIG_HOME: join(home, ".config"),
          XDG_DATA_HOME: join(home, ".local/share"),
          R7D_LOOPBACK_KEY: "loopback-only",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    transport = new ZCodeStdioTransport(child);
    client = new ZCodeProtocolClient(transport, { requestTimeoutMs: 20_000 });
    const received: Array<{
      id: string | number;
      method: string;
      params: Record<string, unknown>;
    }> = [];
    const hostReplies: unknown[] = [];
    let connectionCurrent = true;
    const handler = createAppControlRequestHandler({
      client: {
        respond: async (id, result) => {
          hostReplies.push({ id, result });
          await client!.respond(id as never, result);
        },
        respondError: async (id, error) => {
          hostReplies.push({ id, error });
          await client!.respondError(id as never, error as never);
        },
      },
      service: () => service,
      bind: async ({ callerSessionId, callId, signal }) => ({
        workspacePath: worktree,
        callerSessionId,
        callId,
        signal,
        sourceServerId: "local",
        connectionId: "r7d-native-host",
        assertCurrent() {
          if (!connectionCurrent)
            throw new SessionControlError("forbidden", "App caller connection is no longer active");
        },
      }),
      onResponseError(error) {
        throw error;
      },
    });
    client.onRequest((request) => {
      const frame = request as unknown as {
        id: string | number;
        method: string;
        params: Record<string, unknown>;
      };
      received.push(frame);
      if (frame.method === "session/requestRuntimePreferences") {
        assert.equal(frame.params.scope, "runtime-materialization");
        assert.equal(typeof frame.params.sessionId, "string");
        // 这正是 Host capability 响应字段；用同一 JSON-RPC id 回执。
        void client!.respond(frame.id as never, { toolSearchMode: "off", appControlEnabled: true });
        return;
      }
      assert.equal(handler.handle(frame), true, `unexpected reverse RPC ${frame.method}`);
    });

    const created = await client.request<Record<string, unknown>>("session/create", {
      workspace: { workspacePath: worktree, workspaceKey: worktree },
      mode: "yolo",
    });
    const sessionId = (created as { session: { sessionId: string } }).session.sessionId;
    assert.ok(sessionId);
    // Host 的目录投影必须包含刚 materialize 的根 caller；与真实 Host 同步会话索引的事实一致。
    db.prepare(`INSERT INTO tasks(
      workspace_key, workspace_path, task_id, title, provider, mode, created_at, updated_at,
      host_id, root_path, project_id, cli_title, cli_created_at, cli_updated_at,
      cli_last_outcome, cli_deleted, sort_order)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      worktree,
      worktree,
      sessionId,
      "Caller",
      "glm",
      "build",
      Date.now(),
      Date.now(),
      "local",
      worktree,
      project.id,
      "Caller",
      Date.now(),
      Date.now(),
      "running",
      0,
      2,
    );
    assert.ok(
      repo.readTree().tasks.some((task) => task.taskId === sessionId && task.hostId === "local"),
      JSON.stringify(repo.readTree().tasks),
    );
    await client.request("session/send", { sessionId, content: "list, read, then rename" });

    for (
      let i = 0;
      i < 500 && received.filter((frame) => frame.method.startsWith("appControl/")).length < 3;
      i++
    )
      await delay(20);
    const frames = received.filter((frame) => frame.method.startsWith("appControl/"));
    assert.deepEqual(
      frames.map((frame) => frame.method),
      ["appControl/listProjects", "appControl/readSession", "appControl/renameSession"],
    );
    assert.deepEqual(frames[0].params, {
      callerSessionId: sessionId,
      callId: "native-list",
      input: { query: "vertical" },
    });
    assert.deepEqual(frames[1].params, {
      callerSessionId: sessionId,
      callId: "native-read",
      input: { sessionId: "sess_a", view: "summary" },
    });
    assert.deepEqual(frames[2].params, {
      callerSessionId: sessionId,
      callId: "native-rename",
      input: { sessionId: "sess_a", title: "Renamed by native", requestId: "native-rename" },
    });
    assert.ok(frames.every((frame) => frame.id !== undefined));
    for (let i = 0; i < 500 && hostReplies.length < 3; i++) await delay(20);
    assert.deepEqual(
      hostReplies.slice(0, 3).map((reply) => (reply as { id: unknown }).id),
      frames.map((frame) => frame.id),
    );
    assert.ok(
      hostReplies
        .slice(0, 3)
        .every((reply) => (reply as { result?: { ok?: boolean } }).result?.ok === true),
      JSON.stringify(hostReplies),
    );
    const listResult = (
      hostReplies[0] as { result: { result: { projects: Array<{ title: string }> } } }
    ).result.result;
    assert.equal(listResult.projects[0]?.title, "Vertical Project");
    const readResult = (
      hostReplies[1] as { result: { result: { view: string; summary: { title: string } } } }
    ).result.result;
    assert.equal(readResult.view, "summary");
    assert.equal(readResult.summary.title, "Before");
    const renameResult = (
      hostReplies[2] as { result: { result: { status: string; requestId: string } } }
    ).result.result;
    assert.deepEqual(renameResult, { status: "applied", requestId: "native-rename" });
    for (let i = 0; i < 500 && provider.requests.length < 4; i++) await delay(20);
    assert.ok(
      provider.requests.length >= 4,
      "provider must observe all three tool rounds and final completion",
    );
    for (
      let i = 0;
      i < 100 &&
      repo.readTree().tasks.find((task) => task.taskId === "sess_a")?.title !== "Renamed by native";
      i++
    )
      await delay(20);
    assert.equal(
      repo.readTree().tasks.find((task) => task.taskId === "sess_a")?.title,
      "Renamed by native",
      JSON.stringify(hostReplies),
    );
    assert.ok(received.some((frame) => frame.method === "session/requestRuntimePreferences"));

    // 旧连接代际禁止真实 handler 执行；旧 ACK 不得冒充成功。
    connectionCurrent = false;
    assert.equal(
      handler.handle({
        id: "late",
        method: "appControl/renameSession",
        params: {
          callerSessionId: sessionId,
          callId: "stale",
          input: { sessionId: "sess_a", title: "must-not-run", requestId: "stale" },
        },
      }),
      true,
    );
    assert.equal(
      handler.handle({
        id: "forged",
        method: "appControl/renameSession",
        params: {
          callerSessionId: sessionId,
          callId: "forged",
          input: {
            sessionId: "sess_a",
            title: "must-not-run",
            requestId: "forged",
            callerSessionId: "sess_evil",
          },
        },
      }),
      true,
    );
    for (let i = 0; i < 100 && hostReplies.length < 5; i++) await delay(20);
    assert.deepEqual(hostReplies[3], {
      id: "forged",
      error: { code: -32602, message: "Invalid App control request params" },
    });
    assert.deepEqual(hostReplies[4], {
      id: "late",
      result: {
        ok: false,
        error: { code: "forbidden", message: "App caller connection is no longer active" },
      },
    });
    assert.equal(
      repo.readTree().tasks.find((task) => task.taskId === "sess_a")?.title,
      "Renamed by native",
    );
    client.dispose();
    client = undefined;
  } finally {
    await new Promise<void>((resolve) => provider.server.close(() => resolve()));
  }
});
