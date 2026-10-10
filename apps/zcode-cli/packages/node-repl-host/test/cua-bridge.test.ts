import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { afterEach, describe, it } from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CUA_APP_ASSOCIATIONS_META_KEY } from "@zcode/zcode-cua/host-display-contract";
import { createComputerUseBridgeGlobals, NODE_REPL_CUA_BRIDGE_SYMBOL } from "../src/cua-bridge.js";
import { createNodeReplCuaBroker, type NodeReplCuaBroker } from "../src/cua-broker.js";

/**
 * 宿主侧 CUA 桥的守卫。
 *
 * 这一层是模型碰不到的一跳：请求上下文（workspace / session / runtime-scope / trace）
 * 在这里成文，目标应用身份也只从 broker 响应取。所以每条拒绝路径都需要一个测试钉住，
 * 否则「沙箱改不了」这个前提只写在注释里。
 *
 * 移植自上游 3.15.1 的 test/cua-bridge.test.ts，断言语义一致，只把 runner 从 vitest 换成
 * node:test —— 本仓库 apps/zcode-cli 内已有这个入口（见 packages/debug），不额外引入 runner。
 */
describe("node_repl CUA bridge", () => {
  let broker: NodeReplCuaBroker | undefined;

  afterEach(async () => {
    await broker?.close();
    broker = undefined;
  });

  it("forwards the complete trusted request context to the shared runtime", async () => {
    const calls: unknown[] = [];
    broker = createNodeReplCuaBroker({
      runtime: {
        execute: async (input) => {
          calls.push(input);
          return {
            content: [{ type: "text", text: "ok" }],
            structuredContent: { state_id: "state-1" },
          } satisfies CallToolResult;
        },
        closeSession: async () => undefined,
        dispose: async () => undefined,
      },
      // 不传 platform 时 broker 会走 POSIX 分支，在 tmpdir 里建 `znrc-*.sock`；Windows 的
      // net.Server.listen 只接受命名管道，给文件路径直接 EACCES。产品代码本身按 platform
      // 分支选管道或 unix socket，所以测试必须跑在真实平台上，而不是默默假设 POSIX。
      platform: process.platform,
    });
    await broker.ready;

    const active = {
      generation: 3,
      requestMeta: {
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
      },
      signal: new AbortController().signal,
    };
    const session = { mergeResponseMeta: () => undefined } as never;
    const globals = createComputerUseBridgeGlobals({
      broker: broker.connection,
      documentationRoot: "/tmp/docs",
      generation: active.generation,
      getActiveCall: () => active,
      session: () => session,
    });

    const bridge = globals[NODE_REPL_CUA_BRIDGE_SYMBOL] as {
      call(method: string, input: unknown): Promise<CallToolResult>;
    };
    const result = await bridge.call("screenshot", { display_id: 1 });

    assert.partialDeepStrictEqual(result, { structuredContent: { state_id: "state-1" } });
    assert.equal(calls.length, 1);
    assert.partialDeepStrictEqual(calls[0], {
      toolName: "screenshot",
      arguments: { display_id: 1 },
      context: {
        sessionId: "session-1",
        workspacePath: "/workspace",
        workspaceIdentity: "ssh://host/workspace",
        workspaceKey: "ssh://host/workspace",
        remoteSessionId: "remote-1",
        clientMode: "web-remote-replayable",
        deliveryKind: "web-remote-replayable",
        trace: { traceId: "trace-1", spanId: "span-1" },
      },
    });
  });

  it("records the target app identity from the broker response, not from sandbox code", async () => {
    // 工具卡的 App 图标只能来自 broker 响应：这一跳沙箱看不见，也改不了。producer 自带的
    // 内联 icon PNG 不进 run 结果（会话协议不承载 data URL），只保留 appKey/displayName。
    broker = createNodeReplCuaBroker({
      runtime: {
        execute: async () =>
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
        closeSession: async () => undefined,
        dispose: async () => undefined,
      },
      platform: process.platform,
    });
    await broker.ready;

    const active = {
      generation: 1,
      requestMeta: { runtime_scope: "main" as const, session_id: "session-1", workspace_key: "ws" },
      signal: new AbortController().signal,
    };
    const recorded: unknown[] = [];
    const session = {
      mergeResponseMeta: () => undefined,
      recordCuaAppIdentity: (app: unknown) => recorded.push(app),
    } as never;
    const globals = createComputerUseBridgeGlobals({
      broker: broker.connection,
      documentationRoot: "/tmp/docs",
      generation: 1,
      getActiveCall: () => active,
      session: () => session,
    });
    const bridge = globals[NODE_REPL_CUA_BRIDGE_SYMBOL] as {
      call(method: string, input: unknown): Promise<CallToolResult>;
    };

    await bridge.call("left_click", { app_ref: { pid: 1 } });

    assert.deepEqual(recorded, [{ appKey: "darwin:com.apple.notes", displayName: "Notes" }]);
  });

  it("ignores app associations that carry no primary identity", async () => {
    // list_apps 声明的是 items 模式，没有 primary；request_access / stop 声明 none。
    // 这些调用不能覆盖同一 cell 里前面动作已经确立的身份。
    broker = createNodeReplCuaBroker({
      runtime: {
        execute: async () =>
          ({
            content: [{ type: "text", text: "[]" }],
            _meta: {
              [CUA_APP_ASSOCIATIONS_META_KEY]: {
                schemaVersion: 1,
                items: [{ resultIndex: 0, application: { appKey: "darwin:com.apple.finder" } }],
              },
            },
          }) satisfies CallToolResult,
        closeSession: async () => undefined,
        dispose: async () => undefined,
      },
      platform: process.platform,
    });
    await broker.ready;

    const active = {
      generation: 1,
      requestMeta: { runtime_scope: "main" as const, session_id: "session-1", workspace_key: "ws" },
      signal: new AbortController().signal,
    };
    const recorded: unknown[] = [];
    const globals = createComputerUseBridgeGlobals({
      broker: broker.connection,
      documentationRoot: "/tmp/docs",
      generation: 1,
      getActiveCall: () => active,
      session: () =>
        ({
          mergeResponseMeta: () => undefined,
          recordCuaAppIdentity: (app: unknown) => recorded.push(app),
        }) as never,
    });
    const bridge = globals[NODE_REPL_CUA_BRIDGE_SYMBOL] as {
      call(method: string, input: unknown): Promise<CallToolResult>;
    };

    await bridge.call("list_apps", {});

    assert.deepEqual(recorded, []);
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

    await assert.rejects(bridge.call("screenshot", {}), /Computer Use is not available in subagent/u);
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

  it("rejects a forged broker token", async () => {
    broker = createNodeReplCuaBroker({
      runtime: {
        execute: async () => ({ content: [{ type: "text", text: "should not run" }] }),
        closeSession: async () => undefined,
        dispose: async () => undefined,
      },
      platform: process.platform,
    });
    await broker.ready;
    const brokerConnection = broker.connection;
    const result = await new Promise<string>((resolve) => {
      const socket = createConnection(brokerConnection.socketPath);
      let buffer = "";
      socket.once("connect", () => {
        socket.end(
          `${JSON.stringify({
            id: "forged",
            token: "wrong-token",
            method: "screenshot",
            input: {},
            context: { sessionId: "session-1", workspaceKey: "/workspace" },
          })}\n`,
        );
      });
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (buffer.includes("\n")) resolve(buffer.trim());
      });
      socket.once("error", () => resolve(buffer.trim()));
    });

    assert.match(result, /not authorized/u);
  });
});
