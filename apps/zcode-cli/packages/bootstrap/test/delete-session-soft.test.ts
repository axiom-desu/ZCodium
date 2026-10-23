import assert from "node:assert/strict";
import { it } from "node:test";
import type { CreateSessionInput, SessionId } from "@zcode/contracts";

import { SqliteSessionStore } from "@zcode/adapters/storage";
import { createCommandEntrySessionOps } from "../src/zcode-protocol/v4-bridge-session-ops.js";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "../src/zcode-protocol/server-types.js";

/**
 * deleteSession 执行面的顺序契约：先落持久软删除事实，再释放 runtime、最后摘除注册表。
 * 反过来（先关闭/摘除、再落库）一旦进程在两者之间重启，持久行仍未删除，
 * 已广播的 session.removed 会让会话在冷启动后重新出现在列表里（复活）。
 */
function harness(store: SqliteSessionStore) {
  const events: string[] = [];
  // 删除执行面必须显式声明「持久软删除已完成」，否则 gateway 不能发 session.removed。
  const disposed: { id: string; deleted?: boolean }[] = [];
  const sessionId = "sess-1";
  const record = {
    app: {
      sessionId,
      close: async () => {
        events.push("close");
      },
    },
    persistence: "immediate",
    taskType: "interactive",
    unsubscribe: () => events.push("unsubscribe"),
  } as unknown as ZCodeProtocolSessionRecord;
  const context = {
    deps: { sessionStore: store },
    sessions: new Map([[sessionId, record]]),
    v4Gateway: {
      disposeSession: (id: string, options?: { deleted?: boolean }) => {
        disposed.push({ deleted: options?.deleted, id });
        events.push(`dispose:${id}`);
      },
    },
  } as unknown as ZCodeProtocolAgentServerContext;
  const ops = createCommandEntrySessionOps({
    context,
    log: undefined,
    persistentCommands: {} as never,
    autoDrain: { autoDrainV4QueueIfReady: async () => {}, scheduleAutoDrainRetry: () => {} },
  });
  return { context, disposed, events, ops, sessionId };
}

async function seed(store: SqliteSessionStore): Promise<void> {
  await store.createSession({
    id: "sess-1" as SessionId,
    projectID: "proj" as CreateSessionInput["projectID"],
    slug: "sess-1",
    directory: "/w",
    title: "sess-1",
    version: "test",
  });
}

it("先持久软删除，再释放 runtime 并摘除注册表；重复删除幂等", async () => {
  const store = new SqliteSessionStore({ dbPath: ":memory:" });
  try {
    await seed(store);
    const { context, disposed, events, ops, sessionId } = harness(store);
    const order: string[] = [];
    const original = store.softDeleteSession!.bind(store);
    store.softDeleteSession = async (id: SessionId, at?: number) => {
      order.push("softDelete");
      await original(id, at ?? 1_000);
    };

    await ops.closeSession!(sessionId);
    // 持久事实必须早于 runtime 释放与注册表摘除。
    assert.deepEqual(order, ["softDelete"]);
    assert.deepEqual(events, ["unsubscribe", "close", `dispose:${sessionId}`]);
    // 软删除完成后才允许发 session.removed：dispose 必须带 deleted:true。
    assert.deepEqual(disposed, [{ deleted: true, id: sessionId }]);
    assert.equal(context.sessions.has(sessionId), false);
    assert.equal((await store.getSession(sessionId as SessionId))?.time.deleted, 1_000);
    assert.deepEqual(await store.listSessions(), []);

    // 已摘除的会话重复删除幂等成功（草稿回收路径会重发）。
    await ops.closeSession!(sessionId);
    assert.equal((await store.getSession(sessionId as SessionId))?.time.deleted, 1_000);
    assert.deepEqual(order, ["softDelete"]);
    // 重复删除不再发布第二个移除事实。
    assert.deepEqual(disposed, [{ deleted: true, id: sessionId }]);
  } finally {
    store.close();
  }
});

it("store 不支持软删除时失败，不静默降级成只关闭", async () => {
  const store = new SqliteSessionStore({ dbPath: ":memory:" });
  try {
    await seed(store);
    const { context, disposed, events, ops, sessionId } = harness(store);
    store.softDeleteSession = undefined;
    await assert.rejects(async () => ops.closeSession!(sessionId), /soft deletion is unavailable/);
    // 没有任何释放动作：删除失败不得发布移除事实，也不能提前关闭 runtime。
    assert.deepEqual(events, []);
    assert.deepEqual(disposed, []);
    assert.equal(context.sessions.has(sessionId), true);
    assert.equal((await store.getSession(sessionId as SessionId))?.time.deleted, undefined);
  } finally {
    store.close();
  }
});
