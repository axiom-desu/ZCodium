import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { afterEach, describe, it } from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ComputerUseRuntime } from "@zcode/zcode-cua";
import { CUA_APP_ASSOCIATIONS_META_KEY } from "@zcode/zcode-cua/host-display-contract";
import { createNodeReplCallLedger, type NodeReplCallLedger } from "../src/call-ledger/contract.js";
import { createComputerUseBridgeGlobals, NODE_REPL_CUA_BRIDGE_SYMBOL } from "../src/cua-bridge.js";
import { createNodeReplCuaBroker, type NodeReplCuaBroker } from "../src/cua-broker.js";

// broker 只认本次调用的 token，会话信息取自账本条目，目标应用身份记入条目的 facts
// （apps/zcode-cli/docs/design/v2/tool/20-node-repl-call-ledger.md「CUA broker」）。
// 这一层是模型碰不到的一跳：请求上下文（workspace / session / runtime-scope / trace）
// 在主线程按 core 的 request-context 成文，目标应用身份也只从 broker 拿到的 runtime 结果取。
const fullRequestMeta = {
  runtime_scope: "main" as const,
  session_id: "session-1",
  workspace_path: "/workspace",
  workspace_identity: "ssh://host/workspace",
  workspace_key: "ssh://host/workspace",
  remote_session_id: "remote-1",
  turn_id: "turn-1",
  client_mode: "web-remote-replayable",
  delivery_kind: "web-remote-replayable",
  trace_id: "trace-1",
  span_id: "span-1",
};

describe("node_repl CUA bridge", () => {
  let broker: NodeReplCuaBroker | undefined;

  afterEach(async () => {
    await broker?.close();
    broker = undefined;
  });

  async function startBroker(
    execute: ComputerUseRuntime["execute"],
  ): Promise<{ broker: NodeReplCuaBroker; ledger: NodeReplCallLedger }> {
    const ledger = createNodeReplCallLedger();
    broker = createNodeReplCuaBroker({
      runtime: { execute, closeSession: async () => undefined, dispose: async () => undefined },
      ledger,
      // 不传 platform 时 broker 会走 POSIX 分支，在 tmpdir 里建 `znrc-*.sock`；Windows 的
      // net.Server.listen 只接受命名管道，给文件路径直接 EACCES。产品代码本身按 platform
      // 分支选管道或 unix socket，所以测试必须跑在真实平台上，而不是默默假设 POSIX。
      platform: process.platform,
    });
    await broker.ready;
    return { broker, ledger };
  }

  function bridgeFor(
    started: { broker: NodeReplCuaBroker },
    token: string,
    requestMeta: Record<string, unknown> = fullRequestMeta,
  ) {
    const active = { generation: 1, requestMeta, signal: new AbortController().signal };
    const globals = createComputerUseBridgeGlobals({
      broker: { socketPath: started.broker.connection.socketPath, token },
      documentationRoot: "/tmp/docs",
      generation: 1,
      getActiveCall: () => active,
      session: () => ({ mergeResponseMeta: () => undefined }) as never,
    });
    return globals[NODE_REPL_CUA_BRIDGE_SYMBOL] as {
      call(method: string, input: unknown): Promise<CallToolResult>;
      assertAvailable(): void;
    };
  }

  /** 绕过 bridge，直接往 broker 的 socket 发一行请求。 */
  async function sendRaw(socketPath: string, request: Record<string, unknown>): Promise<string> {
    return await new Promise<string>((resolve) => {
      const socket = createConnection(socketPath);
      let buffer = "";
      socket.once("connect", () => socket.end(`${JSON.stringify(request)}\n`));
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (buffer.includes("\n")) resolve(buffer.trim());
      });
      socket.once("error", () => resolve(buffer.trim()));
    });
  }

  it("forwards the call's trusted request context to the shared runtime", async () => {
    const calls: unknown[] = [];
    const started = await startBroker(async (input) => {
      calls.push(input);
      return {
        content: [{ type: "text", text: "ok" }],
        structuredContent: { state_id: "state-1" },
      } satisfies CallToolResult;
    });
    const call = started.ledger.open(fullRequestMeta);

    const result = await bridgeFor(started, call.token).call("screenshot", { display_id: 1 });

    assert.partialDeepStrictEqual(result, { structuredContent: { state_id: "state-1" } });
    assert.equal(calls.length, 1);
    assert.partialDeepStrictEqual(calls[0], {
      toolName: "screenshot",
      arguments: { display_id: 1 },
      context: {
        runtimeScope: "main",
        sessionId: "session-1",
        workspacePath: "/workspace",
        workspaceIdentity: "ssh://host/workspace",
        workspaceKey: "ssh://host/workspace",
        remoteSessionId: "remote-1",
        turnId: "turn-1",
        clientMode: "web-remote-replayable",
        deliveryKind: "web-remote-replayable",
        trace: { traceId: "trace-1", spanId: "span-1" },
      },
    });
  });

  it("ignores a context sent by the Worker and uses the call's own", async () => {
    // cell 绕过 bridge 时可以自报任意会话；broker 必须只用账本条目里来自 core 的会话信息。
    const calls: Array<{ context: Record<string, unknown> }> = [];
    const started = await startBroker(async (input) => {
      calls.push(input as never);
      return { content: [{ type: "text", text: "ok" }] };
    });
    const call = started.ledger.open(fullRequestMeta);

    const response = await sendRaw(started.broker.connection.socketPath, {
      id: "direct",
      token: call.token,
      method: "screenshot",
      input: {},
      context: { sessionId: "someone-else", runtimeScope: "main", workspaceKey: "/elsewhere" },
    });

    assert.deepEqual(JSON.parse(response), {
      id: "direct",
      ok: true,
      result: { content: [{ type: "text", text: "ok" }] },
    });
    assert.partialDeepStrictEqual(calls[0]?.context, {
      sessionId: "session-1",
      workspaceKey: "ssh://host/workspace",
    });
  });

  it("records the target app identity from the broker response in the call's facts", async () => {
    // 工具卡的 App 图标只能来自 broker 拿到的 runtime 结果：这一跳在 Worker 之外，cell 改不了。
    // producer 自带的内联 icon PNG 不进 run 结果（会话协议不承载 data URL），只保留 appKey/displayName。
    const started = await startBroker(
      async () =>
        ({
          content: [{ type: "text", text: "clicked" }],
          _meta: {
            [CUA_APP_ASSOCIATIONS_META_KEY]: {
              schemaVersion: 1,
              primary: {
                appKey: "darwin:com.apple.notes",
                displayName: "Notes",
                icon: { mimeType: "image/png", data: "iVBORw0KGgo=" },
              },
            },
          },
        }) satisfies CallToolResult,
    );
    const call = started.ledger.open(fullRequestMeta);
    const other = started.ledger.open({ ...fullRequestMeta, session_id: "session-2" });

    await bridgeFor(started, call.token).call("left_click", { app_ref: { pid: 1 } });

    assert.deepEqual(call.facts.cuaApps, [
      { appKey: "darwin:com.apple.notes", displayName: "Notes" },
    ]);
    assert.deepEqual(other.facts.cuaApps, []);
  });

  it("ignores app associations that carry no primary identity", async () => {
    // list_apps 声明的是 items 模式，没有 primary；request_access / stop 声明 none。
    // 这些调用不能覆盖同一 cell 里前面动作已经确立的身份。
    const started = await startBroker(
      async () =>
        ({
          content: [{ type: "text", text: "[]" }],
          _meta: {
            [CUA_APP_ASSOCIATIONS_META_KEY]: {
              schemaVersion: 1,
              items: [{ resultIndex: 0, application: { appKey: "darwin:com.apple.finder" } }],
            },
          },
        }) satisfies CallToolResult,
    );
    const call = started.ledger.open(fullRequestMeta);

    // 前提：调用确实到达 broker 并成功返回。
    const result = await bridgeFor(started, call.token).call("list_apps", {});
    assert.deepEqual(result.content, [{ type: "text", text: "[]" }]);
    assert.deepEqual(call.facts.cuaApps, []);
  });

  it("rejects subagents before opening the broker", async () => {
    const active = {
      generation: 1,
      requestMeta: { runtime_scope: "subagent" as const, session_id: "subagent-1" },
      signal: new AbortController().signal,
    };
    const globals = createComputerUseBridgeGlobals({
      documentationRoot: "/tmp/docs",
      generation: 1,
      getActiveCall: () => active,
      session: () => ({ mergeResponseMeta: () => undefined }) as never,
    });
    const bridge = globals[NODE_REPL_CUA_BRIDGE_SYMBOL] as {
      call(method: string, input: unknown): Promise<CallToolResult>;
    };

    await assert.rejects(
      bridge.call("screenshot", {}),
      /Computer Use is not available in subagent/u,
    );
  });

  it("rejects a subagent call that bypasses the bridge", async () => {
    let executed = 0;
    const started = await startBroker(async () => {
      executed += 1;
      return { content: [{ type: "text", text: "should not run" }] };
    });
    // 条目来自 core 的 subagent 请求；Worker 自报 main 也不能绕过。
    const call = started.ledger.open({ ...fullRequestMeta, runtime_scope: "subagent" });

    const response = await sendRaw(started.broker.connection.socketPath, {
      id: "direct",
      token: call.token,
      method: "screenshot",
      input: {},
      context: { sessionId: "session-1", runtimeScope: "main", workspaceKey: "/workspace" },
    });

    assert.deepEqual(JSON.parse(response), {
      id: "direct",
      ok: false,
      error: "Computer Use is not available in subagent",
    });
    assert.equal(executed, 0);
  });

  it("fails closed after a worker generation changes", async () => {
    const active = {
      generation: 1,
      requestMeta: { runtime_scope: "main" as const, session_id: "session-1" },
      signal: new AbortController().signal,
    };
    const globals = createComputerUseBridgeGlobals({
      broker: { socketPath: "/tmp/does-not-exist.sock", token: "token" },
      documentationRoot: "/tmp/docs",
      generation: 2,
      getActiveCall: () => active,
      session: () => ({ mergeResponseMeta: () => undefined }) as never,
    });
    const bridge = globals[NODE_REPL_CUA_BRIDGE_SYMBOL] as {
      assertAvailable(): void;
    };

    assert.throws(() => bridge.assertAvailable(), /runtime binding is stale/u);
  });

  it("rejects forged tokens and tokens of closed calls", async () => {
    let executed = 0;
    const started = await startBroker(async () => {
      executed += 1;
      return { content: [{ type: "text", text: "should not run" }] };
    });
    const closed = started.ledger.open(fullRequestMeta);
    closed.close();

    for (const token of ["wrong-token", closed.token]) {
      const response = await sendRaw(started.broker.connection.socketPath, {
        id: "forged",
        token,
        method: "screenshot",
        input: {},
      });
      assert.match(response, /not authorized/u);
    }
    assert.equal(executed, 0);
    assert.equal(closed.facts.computerUse, false);
  });

  // 会话能力标签 computer_use 的口径是「真实尝试」：带本次调用 token 的请求到达 broker 就记，
  // broker 侧的拒绝、runtime 的失败都算。
  it("records computerUse for every request that reaches the broker, whatever the outcome", async () => {
    const started = await startBroker(async (input) => {
      if (input.toolName === ("click" as never)) {
        throw new Error("Computer Use Helper is not running");
      }
      return { content: [{ type: "text", text: "no such app" }], isError: true };
    });
    const failedResult = started.ledger.open(fullRequestMeta);
    const thrown = started.ledger.open(fullRequestMeta);
    const subagent = started.ledger.open({ ...fullRequestMeta, runtime_scope: "subagent" });
    const malformed = started.ledger.open(fullRequestMeta);
    const untouched = started.ledger.open(fullRequestMeta);

    const failedResponse = await bridgeFor(started, failedResult.token).call("get_app_state", {
      app: "Nowhere",
    });
    assert.equal(failedResponse.isError, true);
    await assert.rejects(
      bridgeFor(started, thrown.token).call("click", {}),
      /Computer Use Helper is not running/u,
    );
    // 绕过 bridge 的 subagent 请求由 broker 拒绝。
    assert.partialDeepStrictEqual(
      JSON.parse(
        await sendRaw(started.broker.connection.socketPath, {
          id: "direct",
          token: subagent.token,
          method: "screenshot",
          input: {},
        }),
      ),
      { ok: false, error: "Computer Use is not available in subagent" },
    );
    assert.partialDeepStrictEqual(
      JSON.parse(
        await sendRaw(started.broker.connection.socketPath, {
          id: "direct",
          token: malformed.token,
        }),
      ),
      { ok: false, error: "Computer Use broker request is invalid" },
    );

    assert.equal(failedResult.facts.computerUse, true);
    assert.equal(thrown.facts.computerUse, true);
    assert.equal(subagent.facts.computerUse, true);
    assert.equal(malformed.facts.computerUse, true);
    assert.equal(untouched.facts.computerUse, false);
  });

  it("does not record attempts the Worker-side bridge stops before reaching the broker", async () => {
    let executed = 0;
    const started = await startBroker(async () => {
      executed += 1;
      return { content: [{ type: "text", text: "should not run" }] };
    });
    const bootstrapOnly = started.ledger.open(fullRequestMeta);
    const subagentMeta = { ...fullRequestMeta, runtime_scope: "subagent" };
    const subagent = started.ledger.open(subagentMeta);

    // SDK 引导只调用 assertAvailable，不发请求。
    bridgeFor(started, bootstrapOnly.token).assertAvailable();
    // subagent 由 Worker 侧 bridge 先拒绝。
    await assert.rejects(
      bridgeFor(started, subagent.token, subagentMeta).call("screenshot", {}),
      /Computer Use is not available in subagent/u,
    );

    assert.equal(executed, 0);
    assert.equal(bootstrapOnly.facts.computerUse, false);
    assert.equal(subagent.facts.computerUse, false);
  });
});
