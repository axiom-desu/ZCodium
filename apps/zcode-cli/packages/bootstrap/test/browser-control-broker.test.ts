import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";
import { createProtocolBrowserControlBroker } from "../src/zcode-protocol/browser-control-broker.js";

/**
 * 子会话 Browser 权限的守卫（见 `.agents/specs/browser-subagent-shared-tabs.md`）。
 *
 * 放开 subagent 不是把校验删掉，而是把「按 runtime_scope 一刀切」换成「子会话必须经父
 * runtime 登记」。所以每条拒绝路径与每条 tab 归属规则都需要一个测试钉住。
 */

interface RecordedCall {
  method: string;
  params: Record<string, unknown> & { sessionId?: string; command?: { method: string } };
}

function createContext(calls: RecordedCall[]): ZCodeProtocolAgentServerContext {
  const sessions = new Map<string, unknown>([
    [
      "parent-1",
      {
        deliveryKind: "web-remote-replayable",
        workspace: {
          workspacePath: "/workspace",
          workspaceIdentity: "ssh://host/workspace",
          remoteSessionId: "remote-1",
        },
      },
    ],
  ]);
  return {
    sessions,
    requestClient: async (method: string, params: RecordedCall["params"]) => {
      calls.push({ method, params });
      return { browsers: [] };
    },
  } as unknown as ZCodeProtocolAgentServerContext;
}

const execute = (
  sessionId: string,
  command: { method: string },
): {
  browserId: string;
  browserGeneration: number;
  sessionId: string;
  command: { method: string };
} => ({ browserId: "iab", browserGeneration: 1, sessionId, command });

const lifecycleCalls = (calls: RecordedCall[]) =>
  calls.filter((call) => call.params.command !== undefined);

describe("protocol browser control broker — child sessions", () => {
  it("rejects a child session that was never registered", async () => {
    const calls: RecordedCall[] = [];
    const port = createProtocolBrowserControlBroker(createContext(calls));

    await assert.rejects(port.execute(execute("child-unregistered", { method: "list" })), /not active/u);
    // 被拒的请求不能在共享状态里留下连接条目。
    assert.equal(calls.length, 0);
  });

  it("derives a child-owned port: sessionId stays the child, closeSession closes its tabs", async () => {
    const calls: RecordedCall[] = [];
    const port = createProtocolBrowserControlBroker(createContext(calls));
    const child = port.forChildSession?.({
      childSessionId: "child-1",
      parentSessionId: "parent-1",
    });
    assert.ok(child, "forChildSession must exist on the protocol broker");

    await child.execute(execute("child-1", { method: "list" }));
    // tab 归属是子会话自己。
    assert.equal(lifecycleCalls(calls)[0]?.params.sessionId, "child-1");
    assert.equal(calls[0]?.params.workspaceIdentity, "ssh://host/workspace");

    const before = calls.length;
    await child.closeSession?.({ sessionId: "child-1" });
    const closed = calls.slice(before).at(-1);
    // 永不回来认领的子会话：连 tab 一起关。
    assert.deepEqual(closed?.params.command, { method: "closeSession", closeTabs: true });

    // 登记结束之后，请求与从未登记的一样被拒。
    await assert.rejects(child.execute(execute("child-1", { method: "list" })), /not active/u);
  });

  it("derives a parent-owned port: sessionId is rewritten and no lifecycle reaches the desktop", async () => {
    const calls: RecordedCall[] = [];
    const port = createProtocolBrowserControlBroker(createContext(calls));
    const child = port.forChildSession?.({
      childSessionId: "child-2",
      parentSessionId: "parent-1",
      tabOwner: "parent",
    });
    assert.ok(child, "forChildSession must exist on the protocol broker");

    await child.execute(execute("child-2", { method: "list" }));
    // 桌面按 sessionId 判断 tab 归属：子会话 id 它不认识，必须换成父会话。
    assert.equal(lifecycleCalls(calls)[0]?.params.sessionId, "parent-1");

    const before = calls.length;
    await child.turnEnded?.({ sessionId: "child-2" });
    await child.closeSession?.({ sessionId: "child-2" });
    // 子代理的轮次结束 / 运行结束都不能替父会话收尾。
    assert.equal(calls.length, before);

    await assert.rejects(child.execute(execute("child-2", { method: "list" })), /not active/u);
  });

  it("keeps the parent session's own lifecycle intact after a child released its registration", async () => {
    const calls: RecordedCall[] = [];
    const port = createProtocolBrowserControlBroker(createContext(calls));
    const child = port.forChildSession?.({
      childSessionId: "child-3",
      parentSessionId: "parent-1",
      tabOwner: "parent",
    });
    assert.ok(child);

    await child.execute(execute("child-3", { method: "list" }));
    await child.closeSession?.({ sessionId: "child-3" });

    // 连接记在父会话名下，因此父会话自己的 closeSession 仍然会发出去（且不带 closeTabs）。
    await port.closeSession?.({ sessionId: "parent-1" });
    assert.deepEqual(calls.at(-1)?.params.command, { method: "closeSession" });
  });

  it("shares one registration table across brokers of the same server context", async () => {
    const calls: RecordedCall[] = [];
    const context = createContext(calls);
    // 同一个 context 里 broker 会被造两次（进程级 node_repl 一份、runtime 端口一份）。
    // 登记在其中一个实例上，另一个实例的请求也必须能解析——这正是 2026-09-30 那条 bug。
    const protocolBroker = createProtocolBrowserControlBroker(context);
    const runtimePortBroker = createProtocolBrowserControlBroker(context);

    protocolBroker.forChildSession?.({
      childSessionId: "child-4",
      parentSessionId: "parent-1",
      tabOwner: "parent",
    });

    await runtimePortBroker.execute(execute("child-4", { method: "list" }));
    assert.equal(lifecycleCalls(calls).at(-1)?.params.sessionId, "parent-1");
  });
});
