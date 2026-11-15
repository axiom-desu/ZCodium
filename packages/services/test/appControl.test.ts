import assert from "node:assert/strict";
import { test } from "node:test";
import { createAppControlService } from "../src/app-control/index.js";
import { createAppControlRequestHandler } from "../src/app-control/rpc.js";
import type { AppControlTaskRow } from "../src/app-control/contract.js";

const workspacePath = "/tmp/zcode-app-control-workspace";
const now = Date.now();

function createProjects(tasks: AppControlTaskRow[]) {
  const calls: string[] = [];
  return {
    calls,
    port: {
      async readTree() {
        return {
          projects: [{ id: "p1", hostId: "local", name: "小说", deleted: false }] as never,
          tasks: tasks as never,
        };
      },
      async readProjects() {
        return [{ id: "p1", hostId: "local", name: "小说", deleted: false }] as never;
      },
      async prepareSession() {
        return {
          workspacePath,
          additionalDirectories: [],
          projectId: "p1",
        } as never;
      },
    },
  };
}

const baseTask = (overrides: Partial<AppControlTaskRow> = {}): AppControlTaskRow => ({
  taskId: "sess_a",
  hostId: "local",
  workspacePath,
  projectId: "p1",
  title: "第一章",
  status: "completed",
  updatedAt: now,
  ...overrides,
});

function createService(options?: {
  tasks?: AppControlTaskRow[];
  navigation?: Parameters<typeof createAppControlService>[0]["navigation"];
  sent?: string[];
  live?: Parameters<typeof createAppControlService>[0]["agent"]["readLiveSession"];
  stopGeneration?: Parameters<typeof createAppControlService>[0]["tasks"]["stopGeneration"];
  /** 仅能力存在性断言：真实 fork 链路由 appFork.test.ts 覆盖。 */
  fork?: boolean;
}) {
  const sent = options?.sent ?? [];
  const tasks = options?.tasks ?? [baseTask(), baseTask({ taskId: "sess_b", title: "第二章" })];
  const projects = createProjects(tasks);
  const service = createAppControlService({
    sourceServerId: "local",
    projects: {
      ...projects.port,
      ...(options?.fork ? { async reserveFork() {} } : {}),
    },
    tasks: {
      async getTaskMeta(params) {
        return tasks.find((task) => task.taskId === params.taskId) ?? null;
      },
      async createTask() {
        return { taskId: "sess_new", workspacePath };
      },
      async sendPrompt(params) {
        sent.push(`${params.taskId}:${params.content}`);
      },
      async stopGeneration(params) {
        return options?.stopGeneration ? options.stopGeneration(params) : { applied: true };
      },
      async renameTask() {},
      async setTaskPinned() {},
      async archiveTask() {},
      async unarchiveTask() {},
    },
    agent: {
      async readSessionMessages() {
        return [
          { id: "m1", role: "user", text: "你好" },
          { id: "m2", role: "assistant", text: "在" },
        ];
      },
      async readLiveSession(params) {
        return options?.live ? options.live(params) : { status: "idle" as const };
      },
      ...(options?.fork
        ? {
            async readConversationRows() {
              return { rows: [], atRevision: 1, atLogEpoch: "epoch", hasMore: false };
            },
            async forkAssistant() {
              return { status: "created" as const, sessionId: "sess_child" };
            },
          }
        : {}),
    },
    ...(options?.navigation ? { navigation: options.navigation } : {}),
  });
  return { service, projects, sent };
}

let generation = 0;
function createBinding(overrides: Partial<{ sessionId: string; sourceServerId: string }> = {}) {
  const bound = generation;
  return {
    workspacePath,
    callerSessionId: overrides.sessionId ?? "sess_a",
    callId: "call_1",
    uiTarget: "window:1",
    sourceServerId: overrides.sourceServerId ?? "local",
    connectionId: `conn-${bound}`,
    signal: new AbortController().signal,
    assertCurrent() {
      if (bound !== generation) throw new Error("connection generation changed");
    },
  };
}

test("list/read/send/openSession 走真实用例层与绑定窗口导航", async () => {
  const navigated: string[] = [];
  const { service, sent } = createService({
    navigation: {
      async openSession(input) {
        input.binding.assertCurrent();
        navigated.push(`${input.session.sessionId}@${input.uiTarget ?? "none"}`);
        return { status: "opened", uiTarget: input.uiTarget };
      },
    },
  });
  const context = await service.bind(createBinding());
  const projects = await service.control.listProjects(context, {});
  assert.deepEqual(
    projects.projects.map((item) => item.title),
    ["小说"],
  );
  assert.deepEqual(
    projects.searchScope.scopes.map((scope) => scope.scope),
    ["host", "project"],
  );

  const list = await service.control.listSessions(context, {});
  assert.equal(list.sessions.length, 2);
  assert.equal(list.sessions[0]?.status, "idle");

  const read = await service.control.readSession(context, {
    sessionId: "sess_a",
    view: "messages",
  });
  assert.equal(read.view, "messages");
  assert.equal(read.messages[1]?.text, "在");

  const sentResult = await service.control.sendToSession(context, {
    sessionId: "sess_a",
    prompt: "继续",
    requestId: "req-1",
  });
  assert.equal(sentResult.admission, "accepted");
  assert.deepEqual(sent, ["sess_a:继续"]);

  const opened = await service.control.openSession(context, { sessionId: "sess_a" });
  assert.deepEqual(opened, { status: "opened", uiTarget: "window:1" });
  assert.deepEqual(navigated, ["sess_a@window:1"]);
});

test("跨 Host 与会话范围一律拒绝，且不触发 owner 写入", async () => {
  const sent: string[] = [];
  const { service } = createService({
    tasks: [
      baseTask(),
      baseTask({ taskId: "sess_b" }),
      baseTask({ taskId: "sess_remote", hostId: "remote" }),
    ],
    sent,
  });
  // 不存在的调用方根会话（例如模型自报的 ID）不能建立可信上下文。
  await assert.rejects(
    service.bind(createBinding({ sessionId: "sess_unknown" })),
    (error: { code?: string }) => error.code === "forbidden",
  );
  // 假造一个本 Host 绑定后，目标属于其他 Host 的会话仍必须被拒。
  const context = await service.bind(createBinding({ sessionId: "sess_b" }));
  await assert.rejects(
    service.control.readSession(context, {
      session: {
        kind: "app",
        sourceServerId: "remote",
        workspacePath,
        sessionId: "sess_remote",
      },
      view: "messages",
    }),
    (error: { code?: string }) => error.code === "forbidden",
  );
  assert.deepEqual(sent, []);
});

test("连接代际变化后导航端口看到的绑定同步失效", async () => {
  const { service } = createService({
    navigation: {
      async openSession(input) {
        input.binding.assertCurrent();
        return { status: "opened" };
      },
    },
  });
  const context = await service.bind(createBinding());
  generation += 1;
  await assert.rejects(
    service.control.openSession(context, { sessionId: "sess_a" }),
    /generation changed/,
  );
});

test("反向 RPC：未装配服务报 unavailable，重复在途报 conflict，取消只取消观察", async () => {
  const responses: unknown[] = [];
  let bound = 0;
  const handler = createAppControlRequestHandler({
    client: {
      async respond(_id, result) {
        responses.push(result);
      },
      async respondError(_id, error) {
        responses.push(error);
      },
    },
    service: () => undefined,
    bind: async () => {
      bound += 1;
      return createBinding() as never;
    },
    onResponseError: () => undefined,
  });
  assert.equal(
    handler.handle({
      id: 1,
      method: "appControl/listProjects",
      params: { callerSessionId: "sess_a", callId: "c1", input: {} },
    }),
    true,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(responses[0], {
    ok: false,
    error: { code: "unavailable", message: "App control is unavailable on this Host" },
  });
  assert.equal(
    handler.handle({
      id: 2,
      method: "appControl/listSessions",
      params: { callerSessionId: "sess_a", callId: "c2", input: {} },
    }),
    true,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(bound, 0);
  assert.equal(handler.handle({ id: 3, method: "other/method", params: {} }), false);
});

test("反向 RPC 拒绝无效取消参数，但只对已知方法负责", async () => {
  const seen: unknown[] = [];
  const handler = createAppControlRequestHandler({
    client: {
      async respond(_id, result) {
        seen.push(result);
      },
      async respondError(_id, error) {
        seen.push(error);
      },
    },
    service: () => undefined,
    bind: async () => createBinding() as never,
    onResponseError: () => undefined,
  });
  assert.equal(handler.handle({ id: 9, method: "appControl/cancel", params: {} }), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(seen[0], { code: -32602, message: "Invalid appControl cancellation" });
});

test("汇总的 availableActions 只在实际能力存在时给 fork", async () => {
  const { service } = createService({
    navigation: {
      async openSession() {
        return { status: "opened" as const };
      },
    },
  });
  const context = await service.bind(createBinding());
  const read = await service.control.readSession(context, { sessionId: "sess_a", view: "summary" });
  assert.equal(read.view, "summary");
  assert.ok(read.summary.availableActions.includes("readSession"));
  assert.ok(!read.summary.availableActions.includes("forkSession"));
  assert.ok(read.summary.availableActions.includes("openSession"));

  // 端口真实在场时才承认 fork；旧 Agent 缺失端口仍是 unavailable（见 appFork.test.ts）。
  const capable = createService({ fork: true });
  const capableContext = await capable.service.bind(createBinding());
  const capableRead = await capable.service.control.readSession(capableContext, {
    sessionId: "sess_a",
    view: "summary",
  });
  assert.equal(capableRead.view, "summary");
  assert.ok(capableRead.summary.availableActions.includes("forkSession"));
});

test("readSession summary 只从既有 runtime 读 executionId，并据此暴露 interruptSession", async () => {
  const seen: Array<{ taskId: string; executionId?: string }> = [];
  const { service } = createService({
    tasks: [baseTask({ status: "running" })],
    live: async (params) => {
      seen.push({ taskId: params.sessionId, executionId: "exec-1" });
      return { status: "running" as const, executionId: "exec-1" };
    },
  });
  const context = await service.bind(createBinding());
  const read = await service.control.readSession(context, { sessionId: "sess_a", view: "summary" });
  assert.equal(read.view, "summary");
  assert.equal(read.summary.executionId, "exec-1");
  assert.equal(read.summary.status, "running");
  assert.ok(read.summary.availableActions.includes("interruptSession"));
  assert.deepEqual(seen, [{ taskId: "sess_a", executionId: "exec-1" }]);

  const idleService = createService({
    tasks: [baseTask()],
    live: async () => ({ status: "idle" as const }),
  });
  const idleContext = await idleService.service.bind(createBinding());
  const idle = await idleService.service.control.readSession(idleContext, {
    sessionId: "sess_a",
    view: "summary",
  });
  assert.equal(idle.view, "summary");
  assert.equal(idle.summary.executionId, undefined);
  assert.ok(!idle.summary.availableActions.includes("interruptSession"));
});

test("interrupt 把 expectedExecutionId 交给 owner；旧 run 结束/被取代时 rejected 且不重试新 run", async () => {
  const calls: Array<{ taskId: string; expectedExecutionId?: string }> = [];
  // 第一次 mismatch（调用方拿的是旧 execution），第二次即使目标已有新 run 也不能被误停。
  const { service } = createService({
    tasks: [baseTask({ status: "running" }), baseTask({ taskId: "sess_b", status: "running" })],
    stopGeneration: async (params) => {
      calls.push({ taskId: params.taskId, expectedExecutionId: params.expectedExecutionId });
      return params.taskId === "sess_a"
        ? { applied: false, reason: "stale" as const }
        : { applied: true };
    },
  });
  const context = await service.bind(createBinding({ sessionId: "sess_b" }));

  const stale = await service.control.interruptSession(context, {
    sessionId: "sess_a",
    expectedExecutionId: "exec-old",
    requestId: "req-stale",
  });
  assert.deepEqual(stale, { status: "rejected", requestId: "req-stale", reason: "stale" });
  assert.deepEqual(calls[0], { taskId: "sess_a", expectedExecutionId: "exec-old" });

  const applied = await service.control.interruptSession(context, {
    sessionId: "sess_b",
    expectedExecutionId: "exec-live",
    requestId: "req-live",
  });
  assert.equal(applied.status, "applied");
  assert.deepEqual(calls[1], { taskId: "sess_b", expectedExecutionId: "exec-live" });
});

test("interrupt 对已结束会话返回 not_running，不触碰任何执行", async () => {
  const calls: string[] = [];
  const { service } = createService({
    tasks: [baseTask({ status: "completed" })],
    stopGeneration: async (params) => {
      calls.push(params.taskId);
      return { applied: true };
    },
  });
  const context = await service.bind(createBinding());
  const rejected = await service.control.interruptSession(context, {
    sessionId: "sess_a",
    expectedExecutionId: "exec-any",
    requestId: "req-idle",
  });
  assert.deepEqual(rejected, { status: "rejected", requestId: "req-idle", reason: "not_running" });
  assert.deepEqual(calls, []);
});

test("App 发现范围是显式授权下的 host-wide 语义，不是 current-project", async () => {
  const { service } = createService({
    tasks: [baseTask(), baseTask({ taskId: "sess_b", projectId: "p1" })],
  });
  const context = await service.bind(createBinding());
  assert.deepEqual(
    context.allowedScopes.filter((scope) => scope.scope === "host"),
    [{ kind: "app", scope: "host", sourceServerId: "local" }],
  );
  assert.deepEqual(
    context.allowedScopes
      .filter((scope) => scope.scope === "project")
      .map((scope) => ("projectId" in scope ? scope.projectId : undefined)),
    ["p1"],
  );
  assert.deepEqual(context.allowedScopes, context.discoveryScopes);

  // 绑定根会话仍必须属于本 Host；host-wide 不是“任意来源”。
  await assert.rejects(
    service.bind(createBinding({ sourceServerId: "remote" })),
    (error: { code?: string }) => error.code === "forbidden",
  );

  const listed = await service.control.listSessions(context, {});
  assert.deepEqual(
    listed.searchScope.scopes.filter((scope) => scope.scope === "host"),
    [{ kind: "app", scope: "host", sourceServerId: "local" }],
  );
});

test("bindClient 同样是显式 host-wide 授权，且仍绑定连接代际", async () => {
  const { service } = createService();
  generation += 1;
  const bound = generation;
  const context = await service.bindClient({
    kind: "client",
    clientId: "extension",
    sourceServerId: "local",
    connectionId: `client-${bound}`,
    signal: new AbortController().signal,
    assertCurrent() {
      if (bound !== generation) throw new Error("connection generation changed");
    },
  });
  assert.deepEqual(
    context.allowedScopes.map((scope) => scope.scope),
    ["host", "project"],
  );
  generation += 1;
  await assert.rejects(service.control.listProjects(context, {}), /generation changed/);
});
