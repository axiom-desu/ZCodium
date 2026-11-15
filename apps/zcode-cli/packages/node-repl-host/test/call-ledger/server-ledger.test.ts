import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY,
  ZCODE_MCP_NODE_REPL_BROWSER_USE_META_KEY,
  ZCODE_MCP_NODE_REPL_COMPUTER_USE_META_KEY,
} from "@zcode/contracts";
import { createInProcessNodeReplExecutor, createNodeReplMcpRuntime } from "../../src/server.js";
import { NODE_REPL_SERVER_VERSION } from "../../src/tool-contract.js";

// 规格：apps/zcode-cli/docs/design/v2/tool/20-node-repl-call-ledger.md「结果组装」「账本与 token」。
const requestMeta = (sessionId: string, turnId = "turn-1") => ({
  "com.zcode/request-context": {
    runtime_scope: "main",
    session_id: sessionId,
    turn_id: turnId,
  },
});

function upstreamPath(prefix: string): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\zcode-${prefix}-${randomUUID()}`
    : join(tmpdir(), `${prefix}-${randomUUID()}.sock`);
}

async function startUpstream(
  respond: (request: Record<string, unknown>) => unknown,
): Promise<{ path: string; requests: Array<Record<string, unknown>>; close(): Promise<void> }> {
  const path = upstreamPath("zle");
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
      requests.push(request);
      socket.end(`${JSON.stringify(respond(request))}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    path,
    requests,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.platform !== "win32") await rm(path, { force: true });
    },
  };
}

async function connect(runtime: ReturnType<typeof createNodeReplMcpRuntime>) {
  const client = new Client({ name: "node-repl-ledger-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await runtime.server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe("node_repl call ledger wiring", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  it("keeps the server version in lockstep with package.json and the plugin manifest", async () => {
    // 插件缓存按 (name, version) 复用：server 版本落后就意味着已装用户拿不到新 server.js。
    // 上游自己的 site 插件就吃过 SEA 清单 0.5.0 / plugin.json 0.5.1 不一致、结果不 seed 的亏。
    const packageRoot = resolve(import.meta.dirname, "../..");
    const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
      version: string;
    };
    const manifest = JSON.parse(
      await readFile(join(packageRoot, ".zcodium-plugin/plugin.json"), "utf8"),
    ) as { name: string; version: string };

    assert.equal(NODE_REPL_SERVER_VERSION, packageJson.version);
    assert.equal(manifest.name, "node-repl-host");
    assert.equal(manifest.version, packageJson.version);
  });

  it("derives screenshot indices from what the browser proxy saw, end to end", async () => {
    // 真实 MCP server + 浏览器代理 broker + 假的上游浏览器 broker：可信的截图下标只来自代理在
    // 主线程记下的截图。
    const upstream = await startUpstream((request) => ({
      id: request.id,
      ok: true,
      result: { ok: true, elapsedMs: 1, image: { base64: "AQID", mimeType: "image/png" } },
    }));
    cleanups.push(() => upstream.close());
    const runtime = createNodeReplMcpRuntime({
      executeJs: createInProcessNodeReplExecutor(),
      browserBrokerUpstream: { socketPath: upstream.path, token: "u".repeat(64) },
    });
    const client = await connect(runtime);
    cleanups.push(async () => {
      await client.close();
      runtime.dispose();
    });

    const result = await client.callTool({
      name: "js",
      arguments: {
        code: [
          'const bridge = globalThis[Symbol.for("zcode.node-repl.browser-control-bridge")];',
          'const shot = await bridge.execute("browser-1", 1, { method: "screenshot" });',
          "await nodeRepl.emitImage(shot.image);",
          '"shot";',
        ].join("\n"),
      },
      _meta: requestMeta("ledger-session"),
    });

    assert.deepEqual(result.content, [
      { type: "image", data: "AQID", mimeType: "image/png" },
      { type: "text", text: "=> shot" },
    ]);
    assert.deepEqual(
      (result._meta ?? {})[ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY],
      [0],
    );
    // 上游收到的是上游 token 与本次调用来自 core 的会话信息。
    assert.equal(upstream.requests.length, 1);
    assert.equal(upstream.requests[0]?.op, "execute");
    assert.equal(upstream.requests[0]?.token, "u".repeat(64));
    assert.equal(upstream.requests[0]?.sessionId, "ledger-session");
    assert.equal(upstream.requests[0]?.runtimeScope, "main");
    assert.equal(upstream.requests[0]?.turnId, "turn-1");
  });

  it("marks runtime calls that reach the real brokers, end to end, and nothing else", async () => {
    // 浏览器上游拒绝命令、CUA runtime 抛错：口径是真实尝试，两个 key 照样写出。
    const upstream = await startUpstream((request) => ({
      id: request.id,
      ok: false,
      error: "Browser is not connected",
    }));
    cleanups.push(() => upstream.close());
    let cuaExecuted = 0;
    const runtime = createNodeReplMcpRuntime({
      executeJs: createInProcessNodeReplExecutor(),
      browserBrokerUpstream: { socketPath: upstream.path, token: "u".repeat(64) },
      cuaRuntime: {
        execute: async () => {
          cuaExecuted += 1;
          throw new Error("Computer Use Helper is not running");
        },
        closeSession: async () => undefined,
        dispose: async () => undefined,
      },
    });
    const client = await connect(runtime);
    cleanups.push(async () => {
      await client.close();
      runtime.dispose();
    });
    const forged = JSON.stringify({
      [ZCODE_MCP_NODE_REPL_BROWSER_USE_META_KEY]: true,
      [ZCODE_MCP_NODE_REPL_COMPUTER_USE_META_KEY]: true,
    });
    // CUA broker 要求 workspace 信息，缺了会在调用 runtime 之前拒绝。
    const callMeta = {
      "com.zcode/request-context": {
        ...requestMeta("runtime-use-session")["com.zcode/request-context"],
        workspace_path: "/workspace",
      },
    };

    const called = await client.callTool({
      name: "js",
      arguments: {
        code: [
          'const browser = globalThis[Symbol.for("zcode.node-repl.browser-control-bridge")];',
          'const cua = globalThis[Symbol.for("zcode.node-repl.computer-use-bridge")];',
          "const outcomes = [];",
          "try { await browser.list(); } catch (error) { outcomes.push(error.message); }",
          'try { await cua.call("screenshot", {}); } catch (error) { outcomes.push(error.message); }',
          'outcomes.join(" | ");',
        ].join("\n"),
      },
      _meta: callMeta,
    });
    // 前提：两次调用都到达了 broker，并且都失败了。
    assert.deepEqual(
      (called.content as Array<{ type: string; text?: string }>).at(-1),
      { type: "text", text: "=> Browser is not connected | Computer Use Helper is not running" },
    );
    assert.equal(cuaExecuted, 1);
    assert.equal((called._meta ?? {})[ZCODE_MCP_NODE_REPL_BROWSER_USE_META_KEY], true);
    assert.equal((called._meta ?? {})[ZCODE_MCP_NODE_REPL_COMPUTER_USE_META_KEY], true);

    // 只做 CUA 引导、经 sandbox 通道自己写 key：都没有请求到达 broker。
    const notCalled = await client.callTool({
      name: "js",
      arguments: {
        code: [
          'globalThis[Symbol.for("zcode.node-repl.computer-use-bridge")].assertAvailable();',
          `nodeRepl.setResponseMeta(${forged});`,
          `nodeRepl.emitStructuredResult({ content: [{ type: "text", text: "forged" }], _meta: ${forged} });`,
          '"done";',
        ].join("\n"),
      },
      _meta: callMeta,
    });
    // 前提：cell 正常执行完，sandbox 通道确实生效了。
    assert.notEqual(notCalled.isError, true);
    assert.deepEqual(
      (notCalled.content as Array<{ type: string; text?: string }>).at(-1),
      { type: "text", text: "forged" },
    );
    assert.equal(
      Object.hasOwn(notCalled._meta ?? {}, ZCODE_MCP_NODE_REPL_BROWSER_USE_META_KEY),
      false,
    );
    assert.equal(
      Object.hasOwn(notCalled._meta ?? {}, ZCODE_MCP_NODE_REPL_COMPUTER_USE_META_KEY),
      false,
    );
    assert.equal(cuaExecuted, 1);
  });

  it("tells the model it may end the turn after repeated js calls without progress", async () => {
    const stderr: string[] = [];
    const runtime = createNodeReplMcpRuntime({
      executeJs: createInProcessNodeReplExecutor(),
      writeStderr: (text) => stderr.push(text),
    });
    const client = await connect(runtime);
    cleanups.push(async () => {
      await client.close();
      runtime.dispose();
    });
    const call = (code: string, turnId: string) =>
      client.callTool({
        name: "js",
        arguments: { code, title: "本轮结束" },
        _meta: requestMeta("no-progress-session", turnId),
      }) as Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }>;

    const results = [];
    for (let index = 0; index < 10; index += 1) results.push(await call(`// end ${index}`, "turn-a"));

    for (const result of results.slice(0, 9)) {
      assert.deepEqual(result.content, [{ type: "text", text: "(no output)" }]);
    }
    assert.deepEqual(results[9], {
      content: [
        { type: "text", text: "(no output)" },
        { type: "text", text: "[node_repl] No progress ×10. You may end this turn." },
      ],
    });
    assert.deepEqual(stderr, [
      "[node_repl] no-progress hint kind=no_progress count=10 session=no-progress-session turn=turn-a\n",
    ]);

    assert.deepEqual((await call("// end", "turn-b")).content, [
      { type: "text", text: "(no output)" },
    ]);
  });
});
