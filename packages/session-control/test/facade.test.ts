import assert from "node:assert/strict";
import test from "node:test";
import { createCliSessionControl } from "../src/application/cli/index.js";
import {
  DEFAULT_WAIT_TIMEOUT_MS,
  type AccessGrant,
  type CliScope,
  type CliSessionControlDependencies,
  type CliSessionRef,
  type CliTrustedContext,
  type OperationFeed,
  type OperationSnapshot,
} from "../src/contract.js";
import {
  createManualDeadlines,
  createOperationFeed,
  flushMicrotasks,
} from "../src/testing/index.js";

const ROOT: CliSessionRef = { kind: "cli", sessionId: "sess_root", workspacePath: "/workspace/a" };
const TARGET: CliSessionRef = {
  kind: "cli",
  sessionId: "sess_target",
  workspacePath: "/workspace/a",
};
const SCOPE: CliScope = { kind: "cli", workspacePath: "/workspace/a" };
const GRANT: AccessGrant<CliScope> = { scope: SCOPE, fence: "fence-1" };

function context(overrides: Partial<CliTrustedContext> = {}): CliTrustedContext {
  return {
    callerId: ROOT.sessionId,
    rootSession: ROOT,
    allowedScopes: [SCOPE],
    ...overrides,
  };
}

function snapshot(
  operations: OperationSnapshot["operation"][],
  status: OperationSnapshot["status"],
  revision: number,
  epoch = "epoch-1",
): OperationSnapshot {
  return { operation: operations[0]!, epoch, revision, status };
}

interface Fixture {
  cli: CliSessionControlDependencies;
  calls: string[];
  grants: AccessGrant<CliScope>[];
  resolveTargets: Map<string, CliSessionRef | undefined>;
  feed?: ReturnType<typeof createOperationFeed>;
}

function fixture(overrides: Partial<CliSessionControlDependencies> = {}): Fixture {
  const calls: string[] = [];
  const grants: AccessGrant<CliScope>[] = [];
  const resolveTargets = new Map<string, CliSessionRef | undefined>();
  const denied = (name: string) => () => {
    calls.push(name);
    return Promise.reject(new Error(`unexpected port call: ${name}`));
  };
  const cli: CliSessionControlDependencies = {
    access: {
      async authorize(_ctx, request) {
        calls.push(`authorize:${request.action}`);
        grants.push({ scope: request.scope as CliScope, fence: GRANT.fence });
        return { scope: request.scope, fence: GRANT.fence };
      },
    },
    sessions: {
      async resolveSession(_ctx, sessionId) {
        calls.push(`resolve:${sessionId}`);
        if (resolveTargets.has(sessionId)) return resolveTargets.get(sessionId);
        return sessionId === ROOT.sessionId ? ROOT : TARGET;
      },
      listSessions: denied("listSessions") as never,
      readSession: denied("readSession") as never,
    },
    execution: {
      createSession: denied("createSession") as never,
      forkSession: denied("forkSession") as never,
      sendToSession: denied("sendToSession") as never,
      interruptSession: denied("interruptSession") as never,
      renameSession: denied("renameSession") as never,
    },
    observations: { open: denied("open") as never },
    deadlines: createManualDeadlines(),
    ...overrides,
  };
  return { cli, calls, grants, resolveTargets };
}

test("rejects non-canonical and ambiguous targets before any port call", async () => {
  const { cli } = fixture();
  const control = createCliSessionControl(cli);
  await assert.rejects(
    control.readSession(context(), {
      session: TARGET,
      sessionId: TARGET.sessionId,
      view: "summary",
    }),
    (error: { code?: string }) => error.code === "invalid_input",
  );
  await assert.rejects(
    control.readSession(context(), { sessionId: "dummy", view: "summary" }),
    (error: { code?: string }) => error.code === "invalid_input",
  );
});

test("resolves a bare sessionId through the trusted port and keeps the same identity", async () => {
  const sends: unknown[] = [];
  const { cli } = fixture({
    execution: {
      createSession: async () => assert.fail("unexpected"),
      forkSession: async () => assert.fail("unexpected"),
      async sendToSession(_ctx, input, grant) {
        sends.push({ input, grant });
        return {
          requestId: input.requestId,
          session: input.session,
          operation: {
            session: input.session,
            sessionId: input.session.sessionId,
            commandId: "c1",
          },
          admission: "accepted",
          delivery: "start_now",
        };
      },
      interruptSession: async () => assert.fail("unexpected"),
      renameSession: async () => assert.fail("unexpected"),
    } as CliSessionControlDependencies["execution"],
  });
  const control = createCliSessionControl(cli);
  const result = await control.sendToSession(context(), {
    sessionId: TARGET.sessionId,
    prompt: "do it",
    requestId: "tool-call-1",
  });
  assert.equal(result.admission, "accepted");
  assert.equal(
    (sends[0] as { input: { session: CliSessionRef } }).input.session.sessionId,
    TARGET.sessionId,
  );
});

test("rejects a target resolved to a different session", async () => {
  const { cli, resolveTargets } = fixture();
  resolveTargets.set(TARGET.sessionId, { ...TARGET, sessionId: "sess_other" });
  const control = createCliSessionControl(cli);
  await assert.rejects(
    control.sendToSession(context(), {
      sessionId: TARGET.sessionId,
      prompt: "x",
      requestId: "r1",
    }),
    (error: { code?: string }) => error.code === "invalid_output",
  );
});

test("denies a target outside the trusted scope without calling the execution port", async () => {
  const { cli } = fixture();
  const control = createCliSessionControl(cli);
  await assert.rejects(
    control.sendToSession(context(), {
      session: { kind: "cli", sessionId: TARGET.sessionId, workspacePath: "/workspace/b" },
      prompt: "x",
      requestId: "r1",
    }),
    (error: { code?: string; message?: string }) => {
      assert.equal(error.code, "forbidden");
      // 自造引用被拒时要告诉模型改用 sessionId，而不是只说越权。
      assert.match(String(error.message), /sessionId/u);
      return true;
    },
  );
});

test("refuses to wait for the calling root session and duplicate operations", async () => {
  const { cli, calls } = fixture();
  const control = createCliSessionControl(cli);
  await assert.rejects(
    control.waitSessions(context(), {
      operations: [{ sessionId: ROOT.sessionId, commandId: "c1" }],
      mode: "any",
      timeoutMs: 0,
    }),
    (error: { code?: string }) => error.code === "self_wait",
  );
  await assert.rejects(
    control.waitSessions(context(), {
      operations: [
        { sessionId: TARGET.sessionId, commandId: "c1" },
        { sessionId: TARGET.sessionId, commandId: "c1" },
      ],
      mode: "any",
      timeoutMs: 0,
    }),
    (error: { code?: string }) => error.code === "invalid_input",
  );
  assert.ok(!calls.some((call) => call.startsWith("authorize:waitSessions")));
});

test("wait completes on the real terminal update and closes the feed", async () => {
  const operation = { session: TARGET, sessionId: TARGET.sessionId, commandId: "cmd-1" };
  const feed = createOperationFeed(snapshot([operation], "running", 1));
  const { cli } = fixture({
    observations: { open: async () => feed as OperationFeed },
  });
  const control = createCliSessionControl(cli);
  const waiting = control.waitSessions(context(), {
    operations: [{ sessionId: TARGET.sessionId, commandId: operation.commandId }],
    mode: "all",
    timeoutMs: 5_000,
  });
  await flushMicrotasks();
  feed.push({ type: "snapshot", snapshot: snapshot([operation], "completed", 2) });
  const result = await waiting;
  assert.equal(result.status, "completed");
  assert.equal(result.operations[0]?.status, "completed");
  assert.equal(feed.closeCount, 1);
});

test("wait invalidates on a revision that does not advance", async () => {
  const operation = { session: TARGET, sessionId: TARGET.sessionId, commandId: "cmd-2" };
  const feed = createOperationFeed(snapshot([operation], "accepted", 1));
  const { cli } = fixture({ observations: { open: async () => feed as OperationFeed } });
  const control = createCliSessionControl(cli);
  const waiting = control.waitSessions(context(), {
    operations: [{ sessionId: TARGET.sessionId, commandId: operation.commandId }],
    mode: "any",
    timeoutMs: 5_000,
  });
  await flushMicrotasks();
  feed.push({ type: "snapshot", snapshot: snapshot([operation], "completed", 1) });
  const result = await waiting;
  assert.equal(result.status, "unknown");
  assert.match(String(result.operations[0]?.reason), /order changed/u);
});

test("zero timeout reads baselines without subscribing to updates", async () => {
  const operation = { session: TARGET, sessionId: TARGET.sessionId, commandId: "cmd-3" };
  const feed = createOperationFeed(snapshot([operation], "running", 1));
  const { cli } = fixture({ observations: { open: async () => feed as OperationFeed } });
  const control = createCliSessionControl(cli);
  const result = await control.waitSessions(context(), {
    operations: [{ sessionId: TARGET.sessionId, commandId: operation.commandId }],
    mode: "any",
    timeoutMs: 0,
  });
  assert.equal(result.status, "timed_out");
  assert.equal(feed.closeCount, 1);
});

test("times out through the real deadline port and still closes the feed", async () => {
  const operation = { session: TARGET, sessionId: TARGET.sessionId, commandId: "cmd-4" };
  const feed = createOperationFeed(snapshot([operation], "running", 1));
  const deadlines = createManualDeadlines();
  const { cli } = fixture({ observations: { open: async () => feed as OperationFeed }, deadlines });
  const control = createCliSessionControl(cli);
  const waiting = control.waitSessions(context(), {
    operations: [{ sessionId: TARGET.sessionId, commandId: operation.commandId }],
    mode: "all",
    timeoutMs: DEFAULT_WAIT_TIMEOUT_MS,
  });
  await flushMicrotasks();
  deadlines.expireAll();
  const result = await waiting;
  assert.equal(result.status, "timed_out");
  assert.equal(feed.closeCount, 1);
});

test("wait is cancelled by the caller signal without stopping the target", async () => {
  const operation = { session: TARGET, sessionId: TARGET.sessionId, commandId: "cmd-5" };
  const feed = createOperationFeed(snapshot([operation], "running", 1));
  const { cli } = fixture({ observations: { open: async () => feed as OperationFeed } });
  const control = createCliSessionControl(cli);
  const controller = new AbortController();
  const waiting = control.waitSessions(context({ signal: controller.signal }), {
    operations: [{ sessionId: TARGET.sessionId, commandId: operation.commandId }],
    mode: "any",
    timeoutMs: 5_000,
  });
  await flushMicrotasks();
  controller.abort();
  const result = await waiting;
  assert.equal(result.status, "cancelled");
  assert.equal(result.operations[0]?.status, "running");
});

test("wait keeps the trusted context identity for access and observation", async () => {
  // App control 用 WeakMap 保存可信连接；wait 若用 {...ctx} 派生上下文会丢失绑定，
  // 导致客户端类 caller 的 waitSessions 完全不可用。
  const operation = { session: TARGET, sessionId: TARGET.sessionId, commandId: "cmd-6" };
  const bound = new WeakMap<object, string>();
  const trusted = context();
  bound.set(trusted, "connection-1");
  const seen: string[] = [];
  const feed = createOperationFeed(snapshot([operation], "completed", 1));
  const { cli } = fixture({
    access: {
      async authorize(ctx, request) {
        seen.push(bound.get(ctx) ?? "unbound");
        return { scope: request.scope as CliScope, fence: GRANT.fence };
      },
    },
    observations: {
      async open(ctx) {
        seen.push(bound.get(ctx) ?? "unbound");
        return feed as OperationFeed;
      },
    },
  });
  const control = createCliSessionControl(cli);
  const result = await control.waitSessions(trusted, {
    operations: [{ sessionId: TARGET.sessionId, commandId: operation.commandId }],
    mode: "any",
    timeoutMs: 5_000,
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(seen, ["connection-1", "connection-1"]);
});

test("readSession rejects a different view or a substituted session", async () => {
  const { cli } = fixture({
    sessions: {
      resolveSession: async () => TARGET,
      listSessions: async () => ({ sessions: [] }),
      async readSession(_ctx, input) {
        return input.view === "summary"
          ? {
              view: "summary",
              summary: {
                session: { ...TARGET, sessionId: "sess_x" },
                title: "t",
                status: "idle",
                availableActions: [],
              },
            }
          : { view: "messages", session: TARGET, messages: [] };
      },
    },
  });
  const control = createCliSessionControl(cli);
  await assert.rejects(
    control.readSession(context(), { sessionId: TARGET.sessionId, view: "summary" }),
    (error: { code?: string }) => error.code === "invalid_output",
  );
});

test("createSession requires the port-level requestId and forwards it unchanged", async () => {
  const requests: string[] = [];
  const { cli } = fixture({
    execution: {
      async createSession(_ctx, input) {
        requests.push(input.requestId);
        return {
          requestId: input.requestId,
          creation: "created",
          firstInput: "unknown",
          delivery: "unknown",
          session: { kind: "cli", sessionId: "sess_new", workspacePath: ROOT.workspacePath },
          reason: "model unavailable",
        };
      },
      forkSession: async () => assert.fail("unexpected"),
      sendToSession: async () => assert.fail("unexpected"),
      interruptSession: async () => assert.fail("unexpected"),
      renameSession: async () => assert.fail("unexpected"),
    } as CliSessionControlDependencies["execution"],
  });
  const control = createCliSessionControl(cli);
  // 模型面只给 retryOf，端口面必须拿到 requestId——这是工具层的责任，不是 facade 的。
  await assert.rejects(
    control.createSession(context(), { prompt: "hi", retryOf: "tool-call-9" } as never),
    (error: { code?: string }) => error.code === "invalid_input",
  );
  const result = await control.createSession(context(), { prompt: "hi", requestId: "tool-call-9" });
  assert.equal(requests[0], "tool-call-9");
  assert.equal(result.requestId, "tool-call-9");
  assert.equal(result.creation, "created");
});
