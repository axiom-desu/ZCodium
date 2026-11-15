import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import { projectStorage } from "#src/project-storage/index.js";
import { createAppControlService } from "../src/app-control/index.js";
import { createAppControlRequestHandler } from "../src/app-control/rpc.js";
import type { AppControlBinding } from "../src/app-control/contract.js";
import type {
  AppControlConversationPage,
  AppControlForkCommandResult,
} from "../src/app-control/contract.js";

/**
 * A8：真实 SQLite 项目仓储 + loopback App 命令端口。
 *
 * 这里不伪造第二个 fork store：子任务归属仍由项目仓储的 reserveCreatedTask 写库，
 * 测试只 loopback V4 投影分页与 CLI 命令结果，验证 App 层的稳定边界映射与失败语义。
 */

interface Fixture {
  db: DatabaseSync;
  directory: string;
  workspacePath: string;
  projectId: string;
  repository: ReturnType<typeof projectStorage.repository>;
}

const resources: Fixture[] = [];
afterEach(async () => {
  for (const item of resources.splice(0)) {
    item.db.close();
    await rm(item.directory, { recursive: true, force: true });
  }
});

async function fixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "zcode-app-fork-"));
  const workspacePath = join(directory, "workspace");
  const db = new DatabaseSync(join(directory, "tasks-index.sqlite"));
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE tasks (
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
    backupDirectories: [join(directory, "backup")],
    settings: { lastWorkspaceSession: [], recentProjects: [] },
  });
  const repository = projectStorage.repository(db);
  const project = repository.saveProject({ name: "Fork project", roots: [workspacePath] });
  db.prepare(
    `INSERT INTO tasks(
      workspace_key,workspace_path,task_id,title,cli_title,provider,task_status,
      created_at,updated_at,cli_created_at,cli_updated_at,cli_last_outcome,
      host_id,root_path,project_id,handoff_pending)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    workspacePath,
    workspacePath,
    "sess_parent",
    "Parent",
    "Parent",
    "glm",
    "completed",
    1,
    2,
    1,
    2,
    "completed",
    "local",
    workspacePath,
    project.id,
    0,
  );
  const item = { db, directory, workspacePath, projectId: project.id, repository };
  resources.push(item);
  return item;
}

const parentRef = (workspacePath: string) => ({
  kind: "app" as const,
  sourceServerId: "local",
  workspacePath,
  sessionId: "sess_parent",
});

function stableRows(): AppControlConversationPage {
  return {
    rows: [
      { kind: "userInput", rowId: 9, entityId: "msg_user" },
      {
        kind: "assistantText",
        rowId: 10,
        entityId: "msg_assistant",
        assistantResponseId: "msg_assistant",
        canFork: true,
      },
    ],
    atRevision: 7,
    atLogEpoch: "epoch-1",
    hasMore: false,
  };
}

function createHarness(
  fixed: Fixture,
  options?: {
    capability?: boolean;
    rows?: (params: { beforeRowId?: number }) => AppControlConversationPage;
    fork?: (params: {
      target: { rowId: number; entityId: string };
      baseRevision: number;
      baseLogEpoch: string;
      commandId: string;
      clientId: string;
    }) => AppControlForkCommandResult | Promise<AppControlForkCommandResult>;
    parentStatus?: string;
    onReadRows?: () => void;
    reserveError?: Error;
    bindingSource?: string;
  },
) {
  const capability = options?.capability !== false;
  const calls = {
    rowReads: [] as Array<{ beforeRowId?: number }>,
    fork: [] as Array<{
      target: { rowId: number; entityId: string };
      baseRevision: number;
      baseLogEpoch: string;
      commandId: string;
      clientId: string;
    }>,
    reserve: [] as Array<{
      workspacePath: string;
      taskId: string;
      projectId: string | null;
      forkedFromTaskId: string;
    }>,
  };
  let generation = 0;
  const service = createAppControlService({
    sourceServerId: "local",
    projects: {
      async readTree() {
        return fixed.repository.readTree({ includeDeleted: true, includeDeletedTasks: true });
      },
      async readProjects() {
        return fixed.repository.readTree({ includeDeleted: true, includeTasks: false }).projects;
      },
      async prepareSession() {
        return {
          workspacePath: fixed.workspacePath,
          additionalDirectories: [],
          projectId: fixed.projectId,
        };
      },
      ...(capability
        ? {
            async reserveFork(input: {
              workspacePath: string;
              taskId: string;
              projectId: string | null;
              forkedFromTaskId: string;
            }) {
              calls.reserve.push(input);
              if (options?.reserveError) throw options.reserveError;
              fixed.repository.reserveCreatedTask({
                task: { workspacePath: input.workspacePath, taskId: input.taskId },
                projectId: input.projectId,
                forkedFromTaskId: input.forkedFromTaskId,
              });
            },
          }
        : {}),
    },
    tasks: {
      async getTaskMeta() {
        return {
          taskId: "sess_parent",
          title: "Parent",
          status: options?.parentStatus ?? "completed",
          updatedAt: 2,
        };
      },
      async createTask() {
        return { taskId: "sess_new", workspacePath: fixed.workspacePath };
      },
      async sendPrompt() {},
      async stopGeneration() {
        return { applied: true };
      },
      async renameTask() {},
      async setTaskPinned() {},
      async archiveTask() {},
      async unarchiveTask() {},
    },
    agent: {
      async readSessionMessages() {
        return [];
      },
      async readLiveSession() {
        return { status: "idle" as const };
      },
      ...(capability
        ? {
            async readConversationRows(params: { beforeRowId?: number }) {
              calls.rowReads.push({ ...(params.beforeRowId !== undefined ? params : {}) });
              options?.onReadRows?.();
              return options?.rows ? options.rows(params) : stableRows();
            },
            async forkAssistant(params: {
              target: { rowId: number; entityId: string };
              baseRevision: number;
              baseLogEpoch: string;
              commandId: string;
              clientId: string;
            }) {
              calls.fork.push(params);
              return options?.fork
                ? options.fork(params)
                : { status: "created" as const, sessionId: "sess_child" };
            },
          }
        : {}),
    },
  });
  const binding = (): AppControlBinding => {
    const bound = generation;
    return {
      workspacePath: fixed.workspacePath,
      callerSessionId: "sess_parent",
      callId: "call_fork",
      sourceServerId: options?.bindingSource ?? "local",
      connectionId: "conn-fork",
      signal: new AbortController().signal,
      assertCurrent() {
        if (bound !== generation) throw new Error("connection generation changed");
      },
    };
  };
  return {
    service,
    calls,
    binding,
    advanceGeneration: () => {
      generation += 1;
    },
    current: () => generation,
  };
}

async function bindParent(harness: ReturnType<typeof createHarness>) {
  return harness.service.bind(harness.binding());
}

test("stable message boundary forks through the real V4 command and reserves the child task", async () => {
  const fixed = await fixture();
  const harness = createHarness(fixed);
  const context = await bindParent(harness);
  const result = await harness.service.control.forkSession(context, {
    session: parentRef(fixed.workspacePath),
    atMessage: "msg_assistant",
    requestId: "req-fork",
  });
  assert.equal(result.status, "created");
  assert.equal(result.session?.sessionId, "sess_child");
  assert.equal(result.session?.workspacePath, fixed.workspacePath);
  assert.equal(result.session?.project?.projectId, fixed.projectId);
  // messageId 必须显式映射到真实 row target，不能当 rowId 或“取最后一条”。
  assert.deepEqual(harness.calls.fork[0]?.target, { rowId: 10, entityId: "msg_assistant" });
  assert.equal(harness.calls.fork[0]?.baseRevision, 7);
  assert.equal(harness.calls.fork[0]?.baseLogEpoch, "epoch-1");
  assert.equal(harness.calls.fork[0]?.clientId, "sess_parent");
  assert.match(harness.calls.fork[0]?.commandId ?? "", /^app-control-/);
  assert.deepEqual(harness.calls.reserve, [
    {
      workspacePath: fixed.workspacePath,
      taskId: "sess_child",
      projectId: fixed.projectId,
      forkedFromTaskId: "sess_parent",
    },
  ]);
  const child = fixed.db
    .prepare("SELECT forked_from_task_id,root_path,project_id FROM tasks WHERE task_id=?")
    .get("sess_child");
  assert.deepEqual(
    { ...child },
    {
      forked_from_task_id: "sess_parent",
      root_path: fixed.workspacePath,
      project_id: fixed.projectId,
    },
  );
});

test("summary advertises fork only when the real ports are wired; old agents are unavailable", async () => {
  const fixed = await fixture();
  const capable = createHarness(fixed);
  const capableContext = await bindParent(capable);
  const capableSummary = await capable.service.control.readSession(capableContext, {
    sessionId: "sess_parent",
    view: "summary",
  });
  assert.equal(capableSummary.view, "summary");
  assert.ok(capableSummary.summary.availableActions.includes("forkSession"));

  const legacy = createHarness(fixed, { capability: false });
  const legacyContext = await bindParent(legacy);
  const legacySummary = await legacy.service.control.readSession(legacyContext, {
    sessionId: "sess_parent",
    view: "summary",
  });
  assert.equal(legacySummary.view, "summary");
  assert.ok(!legacySummary.summary.availableActions.includes("forkSession"));
  await assert.rejects(
    legacy.service.control.forkSession(legacyContext, {
      session: parentRef(fixed.workspacePath),
      atMessage: "msg_assistant",
      requestId: "req-fork",
    }),
    (error: { code?: string }) => error.code === "unavailable",
  );
  assert.deepEqual(legacy.calls.fork, []);
});

test("old runtime that does not know v4 forkAssistant is an explicit unavailable, not a fake created", async () => {
  const fixed = await fixture();
  const harness = createHarness(fixed, {
    fork: () => ({ status: "unsupported", reason: "method not found" }),
  });
  const context = await bindParent(harness);
  await assert.rejects(
    harness.service.control.forkSession(context, {
      session: parentRef(fixed.workspacePath),
      atMessage: "msg_assistant",
      requestId: "req-fork",
    }),
    (error: { code?: string }) => error.code === "unavailable",
  );
  assert.deepEqual(harness.calls.reserve, []);
});

test("a busy parent is rejected before any projection read or command", async () => {
  const fixed = await fixture();
  const harness = createHarness(fixed, { parentStatus: "running" });
  const context = await bindParent(harness);
  const result = await harness.service.control.forkSession(context, {
    session: parentRef(fixed.workspacePath),
    atMessage: "msg_assistant",
    requestId: "req-fork",
  });
  assert.equal(result.status, "rejected");
  assert.equal(result.reason, "parent_busy");
  assert.deepEqual(harness.calls.rowReads, []);
  assert.deepEqual(harness.calls.fork, []);
  assert.deepEqual(harness.calls.reserve, []);
});

test("a message that is not a stable fork boundary is rejected, never replaced by the last row", async () => {
  const fixed = await fixture();
  const missing = createHarness(fixed, {
    rows: () => ({
      rows: [
        { kind: "userInput", rowId: 1, entityId: "msg_user" },
        { kind: "assistantText", rowId: 2, entityId: "msg_other", canFork: false },
      ],
      atRevision: 2,
      atLogEpoch: "epoch-1",
      hasMore: false,
    }),
  });
  const missingContext = await bindParent(missing);
  const notFound = await missing.service.control.forkSession(missingContext, {
    session: parentRef(fixed.workspacePath),
    atMessage: "msg_assistant",
    requestId: "req-fork",
  });
  assert.deepEqual(notFound, {
    status: "rejected",
    requestId: "req-fork",
    reason: "fork_target_not_found",
  });

  const unstable = createHarness(fixed, {
    rows: () => ({
      rows: [
        {
          kind: "assistantText",
          rowId: 3,
          entityId: "msg_assistant",
          assistantResponseId: "msg_assistant",
          canFork: false,
        },
      ],
      atRevision: 2,
      atLogEpoch: "epoch-1",
      hasMore: false,
    }),
  });
  const unstableContext = await bindParent(unstable);
  const notStable = await unstable.service.control.forkSession(unstableContext, {
    session: parentRef(fixed.workspacePath),
    atMessage: "msg_assistant",
    requestId: "req-fork",
  });
  assert.equal(notStable.status, "rejected");
  assert.equal(notStable.reason, "fork_target_not_stable");
  assert.deepEqual(unstable.calls.fork, []);
});

test("a snapshot that advances while paging is stale and never reaches the CLI", async () => {
  const fixed = await fixture();
  let page = 0;
  const harness = createHarness(fixed, {
    rows: () => {
      page += 1;
      return page === 1
        ? {
            rows: [{ kind: "userInput", rowId: 5, entityId: "msg_user" }],
            atRevision: 4,
            atLogEpoch: "epoch-1",
            hasMore: true,
          }
        : {
            rows: [
              {
                kind: "assistantText",
                rowId: 6,
                entityId: "msg_assistant",
                assistantResponseId: "msg_assistant",
                canFork: true,
              },
            ],
            atRevision: 5,
            atLogEpoch: "epoch-1",
            hasMore: false,
          };
    },
  });
  const context = await bindParent(harness);
  const result = await harness.service.control.forkSession(context, {
    session: parentRef(fixed.workspacePath),
    atMessage: "msg_assistant",
    requestId: "req-fork",
  });
  assert.equal(result.status, "rejected");
  assert.equal(result.reason, "fork_target_stale");
  assert.deepEqual(harness.calls.fork, []);
  assert.deepEqual(harness.calls.reserve, []);
});

test("an unknown command result keeps the receipt: no reservation and no fake success", async () => {
  const fixed = await fixture();
  const harness = createHarness(fixed, {
    fork: () => ({ status: "unknown", reason: "transport closed" }),
  });
  const context = await bindParent(harness);
  const result = await harness.service.control.forkSession(context, {
    session: parentRef(fixed.workspacePath),
    atMessage: "msg_assistant",
    requestId: "req-fork",
  });
  assert.deepEqual(result, {
    status: "unknown",
    requestId: "req-fork",
    reason: "transport closed",
  });
  assert.deepEqual(harness.calls.reserve, []);
  assert.equal(
    fixed.db.prepare("SELECT count(*) AS n FROM tasks WHERE task_id=?").get("sess_child")?.["n"],
    0,
  );
});

test("a lost command transport is unknown, not a fake rejection or success", async () => {
  const fixed = await fixture();
  const harness = createHarness(fixed, {
    fork: () => {
      throw new Error("socket closed");
    },
  });
  const context = await bindParent(harness);
  const result = await harness.service.control.forkSession(context, {
    session: parentRef(fixed.workspacePath),
    atMessage: "msg_assistant",
    requestId: "req-fork",
  });
  assert.deepEqual(result, {
    status: "unknown",
    requestId: "req-fork",
    reason: "fork_result_unavailable",
  });
  assert.deepEqual(harness.calls.reserve, []);
});

test("a created child whose ownership reservation fails is reported unknown and kept on disk", async () => {
  const fixed = await fixture();
  const harness = createHarness(fixed, { reserveError: new Error("project.cross-host-move") });
  const context = await bindParent(harness);
  const result = await harness.service.control.forkSession(context, {
    session: parentRef(fixed.workspacePath),
    atMessage: "msg_assistant",
    requestId: "req-fork",
  });
  assert.equal(result.status, "unknown");
  assert.equal(result.session?.sessionId, "sess_child");
  assert.equal(result.reason, "fork_ownership_unavailable");
  // CLI 已创建的子会话不能被 App 层删除或回收；数据库也没有伪造成功行。
  assert.equal(
    fixed.db.prepare("SELECT count(*) AS n FROM tasks WHERE task_id=?").get("sess_child")?.["n"],
    0,
  );
});

test("a session outside this Host is rejected before any projection read or command", async () => {
  const fixed = await fixture();
  const harness = createHarness(fixed);
  const context = await bindParent(harness);
  await assert.rejects(
    harness.service.control.forkSession(context, {
      session: {
        kind: "app",
        sourceServerId: "remote",
        workspacePath: fixed.workspacePath,
        sessionId: "sess_parent",
      },
      atMessage: "msg_assistant",
      requestId: "req-fork",
    }),
    (error: { code?: string }) => error.code === "forbidden",
  );
  assert.deepEqual(harness.calls.rowReads, []);
  assert.deepEqual(harness.calls.fork, []);
});

test("a Host connection generation change after the boundary read aborts before dispatch", async () => {
  const fixed = await fixture();
  const harness = createHarness(fixed, {
    onReadRows: () => harness.advanceGeneration(),
  });
  const context = await bindParent(harness);
  await assert.rejects(
    harness.service.control.forkSession(context, {
      session: parentRef(fixed.workspacePath),
      atMessage: "msg_assistant",
      requestId: "req-fork",
    }),
    /connection generation changed/,
  );
  assert.deepEqual(harness.calls.fork, []);
  assert.deepEqual(harness.calls.reserve, []);
});

test("reverse RPC loopback parses the public fork schema and returns the created child", async () => {
  const fixed = await fixture();
  const harness = createHarness(fixed);
  const responses: unknown[] = [];
  const handler = createAppControlRequestHandler({
    client: {
      async respond(_id, result) {
        responses.push(result);
      },
      async respondError(_id, error) {
        responses.push(error);
      },
    },
    service: () => harness.service,
    bind: async (request) => ({
      ...harness.binding(),
      callerSessionId: request.callerSessionId,
      callId: request.callId,
      ...(request.turnId ? { turnId: request.turnId } : {}),
      signal: request.signal,
    }),
    onResponseError: (error) => {
      throw error;
    },
  });
  assert.equal(
    handler.handle({
      id: 1,
      method: "appControl/forkSession",
      params: {
        callerSessionId: "sess_parent",
        callId: "call_fork",
        input: {
          sessionId: "sess_parent",
          atMessage: "msg_assistant",
          requestId: "req-fork",
        },
      },
    }),
    true,
  );
  for (let attempt = 0; attempt < 200 && responses.length === 0; attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(responses.length, 1);
  const response = responses[0] as {
    ok?: boolean;
    result?: { status?: string; session?: { sessionId?: string } };
  };
  assert.equal(response.ok, true, JSON.stringify(response));
  assert.equal(response.result?.status, "created");
  assert.equal(response.result?.session?.sessionId, "sess_child");
});
