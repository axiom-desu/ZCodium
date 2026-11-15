import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createNodeReplCallLedger } from "../../src/call-ledger/contract.js";

// 规格：apps/zcode-cli/docs/design/v2/tool/20-node-repl-call-ledger.md「账本与 token」。
describe("node_repl call ledger", () => {
  it("gives every call its own token and keeps facts per call", () => {
    const ledger = createNodeReplCallLedger();
    const first = ledger.open({ session_id: "session-a" });
    const second = ledger.open({ session_id: "session-b" });

    assert.match(first.token, /^[0-9a-f]{64}$/u);
    assert.notEqual(second.token, first.token);
    assert.deepEqual(ledger.resolve(first.token)?.requestMeta, { session_id: "session-a" });
    assert.deepEqual(first.facts, {
      cuaApps: [],
      browserScreenshots: [],
      browserUse: false,
      computerUse: false,
    });

    ledger.resolve(first.token)?.facts.cuaApps.push({ appKey: "darwin:com.apple.notes" });
    assert.deepEqual(first.facts.cuaApps, [{ appKey: "darwin:com.apple.notes" }]);
    assert.deepEqual(second.facts.cuaApps, []);
    // broker 经 resolve 拿到的条目与 tools/call 持有的是同一份 facts。
    const resolved = ledger.resolve(first.token);
    assert.ok(resolved);
    resolved.facts.computerUse = true;
    assert.equal(first.facts.computerUse, true);
    assert.equal(second.facts.computerUse, false);
  });

  it("rejects unknown tokens and tokens of closed calls", () => {
    const ledger = createNodeReplCallLedger();
    const call = ledger.open({ session_id: "session-a" });

    assert.equal(ledger.resolve("0".repeat(64)), undefined);
    assert.equal(ledger.resolve(undefined), undefined);
    assert.equal(ledger.resolve(42), undefined);

    call.close();
    // 超时、取消后迟到的请求不能再改写已经返回的结果。
    assert.equal(ledger.resolve(call.token), undefined);
  });

  it("copies the request metadata so later edits by the caller do not change the entry", () => {
    const ledger = createNodeReplCallLedger();
    const requestMeta: Record<string, unknown> = { session_id: "session-a" };
    const call = ledger.open(requestMeta);
    requestMeta.session_id = "session-b";

    assert.deepEqual(ledger.resolve(call.token)?.requestMeta, { session_id: "session-a" });
  });
});
