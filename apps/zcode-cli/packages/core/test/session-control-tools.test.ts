import assert from "node:assert/strict";
import test from "node:test";
import type {
  AppSessionControl,
  AppSessionTrustedContext,
  CliSessionControl,
  CliTrustedContext,
} from "@zcode/session-control/contracts";
import type { ToolEntry, ToolExecutionContext } from "../src/tool/types.js";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";
import {
  APP_SESSION_CONTROL_TOOL_NAMES,
  CLI_SESSION_CONTROL_TOOL_NAMES,
  SESSION_CONTROL_TOOL_NAMES,
  appSessionControlTools,
  sessionControlTools,
  sessionControlToolsByKind,
} from "../src/tool/session-control/index.js";
import { sessionControlForRuntime } from "../src/tool/session-control/contract.js";

const ROOT_SESSION = "sess_root";
const WORKSPACE = "/workspace/a";

function trustedContext(): CliTrustedContext {
  return {
    callerId: ROOT_SESSION,
    rootSession: { kind: "cli", sessionId: ROOT_SESSION, workspacePath: WORKSPACE },
    allowedScopes: [{ kind: "cli", workspacePath: WORKSPACE }],
    readAnyLocalSession: true,
  };
}

function entry(name: string): ToolEntry {
  const found = sessionControlTools.find((tool) => tool.metadata.name === name);
  assert.ok(found, `missing tool entry: ${name}`);
  return found;
}

function context(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    toolCallId: "tool-call-1",
    traceId: "trace-1",
    abortSignal: new AbortController().signal,
    workingDirectory: WORKSPACE,
    workspaceRoot: WORKSPACE,
    sessionId: ROOT_SESSION as ToolExecutionContext["sessionId"],
    ...overrides,
  };
}

function fakeControl(received: unknown[]): CliSessionControl {
  const record = (method: string) => async (_ctx: CliTrustedContext, input: unknown) => {
    received.push({ method, input });
    if (method === "listSessions") return { sessions: [] };
    if (method === "readSession") return { view: "messages", session: { kind: "cli", sessionId: "sess_x", workspacePath: WORKSPACE }, messages: [] };
    if (method === "createSession" || method === "sendToSession")
      return {
        requestId: (input as { requestId: string }).requestId,
        session: { kind: "cli", sessionId: "sess_x", workspacePath: WORKSPACE },
        operation: {
          session: { kind: "cli", sessionId: "sess_x", workspacePath: WORKSPACE },
          sessionId: "sess_x",
          commandId: "cmd",
        },
        admission: "accepted",
        delivery: "start_now",
      };
    if (method === "forkSession") return { requestId: "r", status: "rejected", reason: "no boundary" };
    if (method === "waitSessions") return { status: "completed", operations: [] };
    return { requestId: "r", status: "applied" };
  };
  return new Proxy({} as CliSessionControl, {
    get: (_target, property: string) => record(property),
  });
}

test("every tool contract is model-facing: no session reference and no requestId", () => {
  assert.equal(sessionControlTools.length, 8);
  assert.equal(appSessionControlTools.length, 12);
  assert.deepEqual(
    [...CLI_SESSION_CONTROL_TOOL_NAMES].sort(),
    [
      "CreateSession",
      "ForkSession",
      "InterruptSession",
      "ListSessions",
      "ReadSession",
      "RenameSession",
      "SendToSession",
      "WaitSessions",
    ],
  );
  // App 是独立 CLI 的超集：多出四个 App 专属名字，注册面按可信绑定二选一。
  assert.deepEqual(
    [...APP_SESSION_CONTROL_TOOL_NAMES].filter((name) => !CLI_SESSION_CONTROL_TOOL_NAMES.has(name)).sort(),
    ["ListProjects", "OpenSession", "SetSessionArchived", "SetSessionPinned"],
  );
  assert.equal(SESSION_CONTROL_TOOL_NAMES.size, 12);
  assert.equal(sessionControlToolsByKind.cli.length, 8);
  assert.equal(sessionControlToolsByKind.app.length, 12);
  for (const tool of sessionControlTools) {
    const properties = (tool.inputSchema as { properties: Record<string, unknown> }).properties;
    assert.ok(!("session" in properties), `${tool.metadata.name} must not expose session`);
    assert.ok(!("requestId" in properties), `${tool.metadata.name} must not expose requestId`);
    assert.equal(tool.permission.permission.startsWith("session_control."), true);
  }
  // 默认值字段不能因为 output 投影而变成必填（规格 0.14）。
  const wait = entry("WaitSessions").inputSchema as {
    properties: Record<string, unknown>;
    required?: string[];
  };
  assert.ok(wait.properties.timeoutMs);
  assert.ok(!(wait.required ?? []).includes("timeoutMs"));
  // 写工具提示模型用 retryOf 对账；只读工具不提示会被拒的字段。
  assert.ok(entry("SendToSession").metadata.modelInstructions?.some((line) => line.includes("retryOf")));
  assert.ok(!entry("ListSessions").metadata.modelInstructions?.some((line) => line.includes("retryOf")));
});

test("tools are only registered through the trusted binding gate", () => {
  const names = (options: Parameters<typeof registerBuiltInTools>[1]) => {
    const registered: string[] = [];
    registerBuiltInTools(
      { register: (tool) => registered.push(tool.metadata.name) },
      options,
    );
    return registered.filter((name) => SESSION_CONTROL_TOOL_NAMES.has(name));
  };
  assert.deepEqual(names({}), []);
  assert.equal(names({ sessionControlKind: "cli" }).length, 8);
  // App 绑定只提供 12 个 App 变体；两种绑定不会同时出现。
  const appNames = names({ sessionControlKind: "app" });
  assert.equal(appNames.length, 12);
  assert.ok(appNames.includes("ListProjects"));
  assert.equal(
    appNames.filter((name) => CLI_SESSION_CONTROL_TOOL_NAMES.has(name)).length,
    8,
  );
});

test("App write tools keep approval owner semantics: needsApproval and bound root only", async () => {
  const received: unknown[] = [];
  const binding = {
    kind: "app" as const,
    control: new Proxy({} as AppSessionControl, {
      get: (_target, property: string) => async (_ctx: AppSessionTrustedContext, input: unknown) => {
        received.push({ method: property, input });
        return property === "setSessionPinned"
          ? { status: "applied", requestId: "r" }
          : { status: "opened" };
      },
    }),
    context: (): AppSessionTrustedContext => ({
      callerId: ROOT_SESSION,
      rootSession: { kind: "app", sessionId: ROOT_SESSION, workspacePath: WORKSPACE },
      allowedScopes: [{ kind: "app", scope: "workspace", workspacePath: WORKSPACE }],
    }),
  };
  for (const name of ["CreateSession", "SendToSession", "SetSessionPinned", "OpenSession"]) {
    const tool = appSessionControlTools.find((entry) => entry.metadata.name === name);
    assert.ok(tool, name);
    // 审批 owner 仍是执行会话本身：写工具必须走既有 permission 通道，不能自批。
    assert.equal(tool.metadata.needsApproval, true, name);
    assert.equal(tool.permission.needsApproval, true, name);
  }
  // 只读工具不额外索取审批，但同样只接受执行上下文里的 App 绑定。
  const list = appSessionControlTools.find((entry) => entry.metadata.name === "ListSessions")!;
  assert.equal(list.metadata.needsApproval, false);
  await assert.rejects(
    list.handler({}, context({ sessionControl: binding, runtimeScope: "subagent" })),
    (error: { code?: string }) => error.code === "forbidden",
  );
  await assert.rejects(
    list.handler({}, context({ sessionControl: binding, sessionId: "sess_other" as never })),
    (error: { code?: string }) => error.code === "forbidden",
  );
  // CLI 绑定不能执行 App 专属工具，反之亦然。
  await assert.rejects(
    list.handler(
      {},
      context({
        sessionControl: { kind: "cli", control: fakeControl([]), context: trustedContext },
      }),
    ),
    (error: { code?: string }) => error.code === "forbidden",
  );
  assert.equal(received.length, 0);
});

test("handler injects the request identity from the tool call and retryOf", async () => {
  const received: unknown[] = [];
  const binding = {
    kind: "cli" as const,
    control: fakeControl(received),
    context: trustedContext,
  };
  const send = entry("SendToSession");
  await send.handler(
    { sessionId: "sess_x", prompt: "go" },
    context({ sessionControl: binding }),
  );
  assert.deepEqual((received[0] as { input: { requestId: string } }).input.requestId, "tool-call-1");

  await send.handler(
    { sessionId: "sess_x", prompt: "go", retryOf: "tool-call-earlier" },
    context({ sessionControl: binding, toolCallId: "tool-call-2" }),
  );
  assert.equal(
    (received[1] as { input: { requestId: string } }).input.requestId,
    "tool-call-earlier",
  );
  // 只读工具不接受也不注入 requestId。
  const list = entry("ListSessions");
  await list.handler({}, context({ sessionControl: binding }));
  assert.ok(!("requestId" in (received[2] as { input: Record<string, unknown> }).input));
});

test("handler refuses subagents and a binding bound to another root", async () => {
  const received: unknown[] = [];
  const binding = {
    kind: "cli" as const,
    control: fakeControl(received),
    context: trustedContext,
  };
  const list = entry("ListSessions");
  await assert.rejects(
    list.handler({}, context({ sessionControl: binding, runtimeScope: "subagent" })),
    (error: { code?: string }) => error.code === "forbidden",
  );
  await assert.rejects(
    list.handler({}, context({ sessionControl: binding, sessionId: "sess_other" as never })),
    (error: { code?: string }) => error.code === "forbidden",
  );
  await assert.rejects(list.handler({}, context({})), (error: { code?: string }) => {
    return error.code === "forbidden";
  });
  assert.equal(received.length, 0);
});

test("runtime binding gate drops sub-session task types and mismatched roots", () => {
  const binding = {
    kind: "cli" as const,
    control: fakeControl([]),
    context: trustedContext,
  };
  assert.ok(sessionControlForRuntime(binding, "interactive", ROOT_SESSION));
  assert.ok(sessionControlForRuntime(binding, "fork", ROOT_SESSION));
  assert.equal(sessionControlForRuntime(binding, undefined, ROOT_SESSION)?.kind, "cli");
  assert.equal(sessionControlForRuntime(binding, "subagent_child", ROOT_SESSION), undefined);
  assert.equal(sessionControlForRuntime(binding, "workflow_child", ROOT_SESSION), undefined);
  assert.equal(sessionControlForRuntime(binding, "interactive", "sess_other"), undefined);
  assert.equal(sessionControlForRuntime(undefined, "interactive", ROOT_SESSION), undefined);
});
