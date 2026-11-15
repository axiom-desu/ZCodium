import assert from "node:assert/strict";
import { it } from "node:test";
import { zcodeProtocolErrorCodes } from "@zcode/shared";
import { assertV4CommandSessionReady } from "../src/zcode-protocol/server-dispatch-v4.js";
import { ProtocolRequestError } from "../src/zcode-protocol/server-types.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

// v4/command 的 lifecycle 闸门：stop/restart 期间生命周期 owner 说 not ready 时，
// 命令必须在进入 CommandInbox 之前被拒绝（与 legacy requireSession 的 runtimeNotReady 同义）。
// createSession（sessionId=null）和非法信封不能因闸门改变既有语义。

const envelope = (sessionId: string | null) => ({
  commandId: "cmd-1",
  clientId: "client-1",
  sessionId,
  type: "sendText",
  payload: { text: "hello" },
  issuedAt: Date.UTC(2026, 10, 1),
});

function context(isReady: (sessionId: string) => boolean): ZCodeProtocolAgentServerContext {
  return {
    sessionLifecycle: { isReady },
  } as unknown as ZCodeProtocolAgentServerContext;
}

it("stopping/restarting 会话的 v4 命令在 inbox 前失败", () => {
  const contextUnderTest = context((sessionId) => sessionId !== "stopping");
  assert.throws(
    () => assertV4CommandSessionReady(contextUnderTest, envelope("stopping")),
    (error: unknown) => {
      assert.ok(error instanceof ProtocolRequestError);
      assert.equal(error.code, zcodeProtocolErrorCodes.sessionUnavailable);
      assert.deepEqual(error.data, { code: "runtimeNotReady" });
      return true;
    },
  );
});

it("ready 会话、createSession 与非法信封不受生命周期闸门影响", () => {
  const contextUnderTest = context((sessionId) => sessionId === "ready");
  assert.doesNotThrow(() => assertV4CommandSessionReady(contextUnderTest, envelope("ready")));
  assert.doesNotThrow(() => assertV4CommandSessionReady(contextUnderTest, envelope(null)));
  assert.doesNotThrow(() => assertV4CommandSessionReady(contextUnderTest, { nonsense: true }));
  // 无 lifecycle 的旧装配保持原行为。
  assert.doesNotThrow(() =>
    assertV4CommandSessionReady({} as ZCodeProtocolAgentServerContext, envelope("stopping")),
  );
});
