import assert from "node:assert/strict";
import { it } from "node:test";
import type { SessionSummary } from "@zcode/shared/zcode-protocol-v4";

import { SessionsIndexPublisher } from "../src/zcode-protocol-v4/sessions-index-publisher.js";
import { createGatewayState } from "../src/zcode-protocol-v4/v4-gateway-state.js";
import * as lifecycle from "../src/zcode-protocol-v4/v4-gateway-lifecycle.js";
import { ConversationV4Gateway, type V4GatewayHost } from "../src/zcode-protocol-v4/v4-gateway.js";

/**
 * `session/close` 只释放 runtime，不等于持久删除（S1）。
 * `session.removed` 是 Host 的删除事实：只有完成软删除的执行面显式传 `{ deleted: true }`
 * 时才能从 sessions-index 发布，否则关闭一个仍然存在的会话会把它从列表里抹掉。
 */
function host(overrides: Partial<V4GatewayHost> = {}): V4GatewayHost {
  return {
    sessionExists: () => true,
    emitWireFrame: () => {},
    executeCommand: async () => undefined,
    getSessionWorkspaceId: () => "ws",
    ...overrides,
  } as V4GatewayHost;
}

function summary(): SessionSummary {
  return {
    sessionId: "s1",
    workspaceId: "ws",
    title: "task",
    titleSource: "default",
    phase: "completedSuccess",
    sessionEnded: true,
    hasBackgroundWork: false,
    lastActivityAt: 10,
    createdAt: 1,
  };
}

/** 真实 publisher 上包一层记账：只有 projection 真的移除了会话才记一条。 */
function state() {
  const ctx = createGatewayState(host(), {});
  const publisher = new SessionsIndexPublisher("ws", "epoch");
  publisher.seed(summary());
  const removed: string[] = [];
  const remove = publisher.removeSession.bind(publisher);
  publisher.removeSession = (sessionId: string) => {
    const changed = remove(sessionId);
    if (changed) removed.push(sessionId);
    return changed;
  };
  ctx.indexPublishers.set("ws", publisher);
  return { ctx, publisher, removed };
}

it("普通 session/close 只释放运行态，不发布 session.removed", () => {
  const { ctx, publisher, removed } = state();
  try {
    lifecycle.disposeSession(ctx, "s1");
    assert.deepEqual(removed, [], "未软删除的会话不能发 session.removed");
    // 会话必须仍在 index 里：再次移除同一会话才有变化。
    assert.equal(publisher.removeSession("s1"), true, "普通关闭后会话仍应留在列表投影里");
  } finally {
    lifecycle.dispose(ctx);
  }
});

it("完成软删除的路径显式传 deleted:true，且只发一次 removed", () => {
  const { ctx, removed } = state();
  try {
    lifecycle.disposeSession(ctx, "s1", { deleted: true });
    assert.deepEqual(removed, ["s1"], "软删除完成后必须发一次 session.removed");
    // 重复删除幂等：移除事实已经发过，不得再发第二次。
    lifecycle.disposeSession(ctx, "s1", { deleted: true });
    assert.deepEqual(removed, ["s1"]);
  } finally {
    lifecycle.dispose(ctx);
  }
});

it("gateway 公开签名接受 deleted 选项，默认仍是只释放运行态", () => {
  const gateway = new ConversationV4Gateway(host());
  try {
    assert.equal(typeof gateway.disposeSession, "function");
    // 只验证公开签名与透传（deleted 缺省时必须可用）。
    gateway.disposeSession("s1", { deleted: true });
    gateway.disposeSession("s2");
  } finally {
    gateway.dispose();
  }
});
