import assert from "node:assert/strict";
import type {
  McpCallToolRequest,
  McpConnectOptions,
  McpPort,
  McpServerConfig,
  McpServerStatus,
} from "@zcode/contracts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { McpClient } from "../src/mcp/adapter-types.js";
import { installElicitationHandler } from "../src/mcp/adapter-handlers.js";
import { createMcpConnectionPool } from "../src/mcp/pool.js";
import { McpResourceSubscriptionRegistry } from "../src/mcp/resource-subscriptions.js";

const CONNECTED: McpServerStatus = {
  status: "connected",
  transport: "stdio",
  toolCount: 0,
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const CONFIG: McpServerConfig = { type: "stdio", command: "fixture" };
const SHARED_CONFIG: McpServerConfig = { ...CONFIG, isolation: "workspace" };

/** 只等取消的请求：未取消就永远挂着，模拟在途 tool/resource/connect。 */
function hang<T>(signal: AbortSignal | undefined, seen?: AbortSignal[]): Promise<T> {
  if (signal) seen?.push(signal);
  return new Promise<T>((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function adapterWith(overrides: Partial<McpPort>): McpPort {
  return {
    connectConfiguredServers: async () => ({ statuses: {}, tools: [] }),
    connectServer: async () => CONNECTED,
    disconnectServer: async () => CONNECTED,
    status: async () => ({ fixture: CONNECTED }),
    listTools: async () => [],
    callTool: async () => ({ content: [] }),
    close: async () => {},
    ...overrides,
  } as McpPort;
}

let home: string;
const savedEnv = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };

before(async () => {
  home = await mkdtemp(join(tmpdir(), "mcp-pool-cancel-"));
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
});

after(async () => {
  process.env.HOME = savedEnv.HOME;
  process.env.XDG_CONFIG_HOME = savedEnv.XDG_CONFIG_HOME;
  await rm(home, { recursive: true, force: true });
});

describe("MCP pool lease cancellation", () => {
  it("lease close cancels the pending connection wait and the entry connect signal", async () => {
    const connectSignals: AbortSignal[] = [];
    const adapter = adapterWith({
      connectServer: (_name: string, _config: McpServerConfig, options?: McpConnectOptions) =>
        hang<McpServerStatus>(options?.signal, connectSignals),
    });
    const pool = createMcpConnectionPool({ createAdapter: () => adapter, idleGraceMs: 0 });
    const lease = pool.acquireLease({ sessionId: "session-a" });

    const connecting = lease.connectServer("fixture", CONFIG);
    const closed = lease.close();
    await assert.rejects(connecting, /MCP session lease (is )?closed/);
    await closed;

    assert.equal(connectSignals.length, 1);
    assert.equal(connectSignals[0]?.aborted, true, "entry signal aborts before transport close");
    assert.equal(pool.stats().activeConnections, 0);
    await assert.rejects(
      lease.callTool({ serverName: "fixture", toolName: "echo" }),
      /MCP session lease is closed/,
    );
    await pool.close();
  });

  it("lease close cancels in-flight tool and resource requests exactly once", async () => {
    const requestSignals: AbortSignal[] = [];
    let closeCount = 0;
    const adapter = adapterWith({
      callTool: (_request: McpCallToolRequest, options) =>
        hang(options?.signal, requestSignals),
      readResource: (_request, options) => hang(options?.signal, requestSignals),
      listResources: (_request, options) => hang(options?.signal, requestSignals),
      close: async () => {
        closeCount += 1;
      },
    });
    const pool = createMcpConnectionPool({ createAdapter: () => adapter, idleGraceMs: 0 });
    const lease = pool.acquireLease({ sessionId: "session-close" });
    await lease.connectServer("fixture", CONFIG);

    const call = lease.callTool({ serverName: "fixture", toolName: "slow" });
    const read = lease.readResource?.({ serverName: "fixture", uri: "ui://slow" });
    const list = lease.listResources?.({ serverName: "fixture" });
    assert.ok(read && list);
    const closed = lease.close();
    for (const request of [call, read, list]) {
      await assert.rejects(request as Promise<unknown>, /MCP session lease closed/);
    }
    await closed;
    assert.equal(requestSignals.length, 3);
    assert.ok(requestSignals.every((signal) => signal.aborted));
    assert.equal(closeCount, 1);
    // 幂等：重复 close 不二次关闭 transport。
    await lease.close();
    assert.equal(closeCount, 1);
    await pool.close();
  });

  it("caller abort cancels only that request and keeps the pooled connection", async () => {
    let closeCount = 0;
    let pendingResolve: (() => void) | undefined;
    let callCount = 0;
    const adapter = adapterWith({
      callTool: (_request, options) => {
        callCount += 1;
        if (callCount === 1) return hang(options?.signal);
        return new Promise((resolve) => {
          pendingResolve = () => resolve({ content: [{ type: "text", text: "ok" }] });
        });
      },
      close: async () => {
        closeCount += 1;
      },
    });
    const pool = createMcpConnectionPool({ createAdapter: () => adapter, idleGraceMs: 0 });
    const lease = pool.acquireLease({ sessionId: "session-caller" });
    await lease.connectServer("fixture", CONFIG);

    const caller = new AbortController();
    const aborted = lease.callTool(
      { serverName: "fixture", toolName: "slow" },
      { signal: caller.signal },
    );
    const reason = new Error("caller cancelled");
    caller.abort(reason);
    await assert.rejects(aborted, /caller cancelled/);

    // lease 与 entry 都没有被 caller 取消：同 lease 后续请求仍可复用连接
    // （若 caller signal 被当成 entry 连接信号，这里会重复连接或直接失败）。
    assert.equal(closeCount, 0);
    assert.equal(pool.stats().activeConnections, 1);
    const followUp = lease.callTool({ serverName: "fixture", toolName: "fast" });
    pendingResolve?.();
    assert.deepEqual(await followUp, { content: [{ type: "text", text: "ok" }] });
    assert.equal(closeCount, 0);
    await pool.close();
  });

  it("closing one lease does not cancel another lease's in-flight request on a shared entry", async () => {
    const pending: Array<() => void> = [];
    let createAdapterCalls = 0;
    let closeCount = 0;
    const adapter = adapterWith({
      callTool: (_request, options) =>
        new Promise((resolve, reject) => {
          pending.push(() => resolve({ content: [] }));
          const signal = options?.signal;
          if (signal?.aborted) {
            reject(signal.reason);
            return;
          }
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      close: async () => {
        closeCount += 1;
      },
    });
    const pool = createMcpConnectionPool({
      createAdapter: () => {
        createAdapterCalls += 1;
        return adapter;
      },
      idleGraceMs: 0,
    });
    const leaseA = pool.acquireLease({ sessionId: "a" });
    const leaseB = pool.acquireLease({ sessionId: "b" });
    await leaseA.connectServer("fixture", SHARED_CONFIG, { workingDirectory: "/shared" });
    await leaseB.connectServer("fixture", SHARED_CONFIG, { workingDirectory: "/shared" });
    assert.equal(createAdapterCalls, 1, "workspace isolation shares one pooled connection");

    const callA = leaseA.callTool({ serverName: "fixture", toolName: "a" });
    const callB = leaseB.callTool({ serverName: "fixture", toolName: "b" });
    await leaseA.close();
    await assert.rejects(callA, /MCP session lease closed/);
    // B 的请求仍在途，且 entry 没有因 A 关闭而关闭。
    assert.equal(closeCount, 0);
    assert.equal(pool.stats().activeConnections, 1);
    pending.at(-1)?.();
    assert.deepEqual(await callB, { content: [] });

    pending.at(-1)?.();
    await pool.close();
  });

  it("lease close during a stale reconnect aborts the reconnect and leaves no entry behind", async () => {
    const connectSignals: AbortSignal[] = [];
    let closeCount = 0;
    let connectCalls = 0;
    const reconnectStarted = deferred<void>();
    const adapter = adapterWith({
      connectServer: (_name, _config, options) => {
        connectCalls += 1;
        if (connectCalls === 1) return Promise.resolve(CONNECTED);
        connectSignals.push(options!.signal!);
        reconnectStarted.resolve();
        return hang<McpServerStatus>(options?.signal);
      },
      pingServer: async () => false,
      close: async () => {
        closeCount += 1;
      },
    });
    const pool = createMcpConnectionPool({ createAdapter: () => adapter, idleGraceMs: 0 });
    const lease = pool.acquireLease({ sessionId: "session-stale" });
    await lease.connectServer("fixture", CONFIG);

    const revalidate = lease.connectServer("fixture", CONFIG, { revalidate: true });
    // 重连已发起（第二次 connectServer），但尚未完成。
    await reconnectStarted.promise;
    assert.equal(connectCalls, 2);
    const closed = lease.close();
    await assert.rejects(revalidate, /MCP session lease closed/);
    await closed;
    assert.equal(connectSignals[0]?.aborted, true, "entry close aborts the stale reconnect");
    assert.equal(pool.stats().activeConnections, 0);
    assert.equal(closeCount, 1, "transport closed exactly once");

    // 迟到重连不得复活 entry。
    await pool.close();
    assert.equal(pool.stats().activeConnections, 0);
    assert.equal(closeCount, 1);
  });

  it("elicitation waits carry the active tool-call signal", async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const handlers = new Map<string, (request: unknown) => Promise<unknown>>();
    const host = {
      records: new Map(),
      resourceSubscriptions: new McpResourceSubscriptionRegistry(),
      activeCallTraces: new Map(),
      activeCallSignals: new Map<string, AbortSignal>(),
      elicitation: {
        requestElicitation: async (_request: unknown, options?: { signal?: AbortSignal }) => {
          seen.push(options?.signal);
          return { action: "decline" as const };
        },
      },
      onToolListChanged: () => {},
    };
    const client = {
      setRequestHandler: (method: string, handler: (request: unknown) => Promise<unknown>) => {
        handlers.set(method, handler);
      },
    } as unknown as McpClient;
    installElicitationHandler(host, client, "fixture");

    const call = new AbortController();
    host.activeCallSignals.set("fixture", call.signal);
    await handlers.get("elicitation/create")?.({ params: { message: "continue?" } });
    assert.equal(seen[0], call.signal, "elicitation follows the in-flight tool call");

    call.abort(new Error("lease closed"));
    assert.equal(seen[0]?.aborted, true);
  });
});
