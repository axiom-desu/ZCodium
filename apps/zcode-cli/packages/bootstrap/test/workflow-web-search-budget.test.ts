// ============================================================
// F13 driver 侧 WebSearch 预算：计数与上限的唯一所有者
// ============================================================
// 不变式：
//   1. 计数在 driver 会话状态里，端口只按 sessionId 晚查状态，模型改不了路由；
//   2. 上限取 persona 的 `budget.webSearch`（合法整数 0–1024），否则默认 128；
//   3. 耗尽返回 exhausted + 面向模型的文案；没有在飞 ask 时不扣也不拦；
//   4. 扣减是同步的，同一批并行调用不会都看到"还剩一次"。

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PersonaSpec } from "@zcode/dynamic-workflow";
import type { SessionId } from "@zcode/contracts";

import {
  DEFAULT_WEB_SEARCH_BUDGET_PER_ASK,
  MAX_WEB_SEARCH_BUDGET_PER_ASK,
  makeWebSearchBudgetPort,
  webSearchBudgetExhaustedMessage,
  webSearchLimitOf,
} from "../src/app/workflow-driver-web-search-budget.js";
import type { SessionState } from "../src/app/workflow-driver-types.js";

const SESSION = "session-1" as SessionId;

function stateOf(partial: Record<string, unknown>): SessionState {
  return {
    currentInstance: { ordinal: 1, siteId: "ask#1" },
    webSearchLimit: DEFAULT_WEB_SEARCH_BUDGET_PER_ASK,
    webSearchesUsed: 0,
    ...partial,
  } as unknown as SessionState;
}

function portFor(state: SessionState | undefined) {
  const sessions = new Map<string, SessionState>(
    state === undefined ? [] : [[SESSION, state]],
  );
  return makeWebSearchBudgetPort(sessions, SESSION);
}

describe("webSearchLimitOf", () => {
  it("缺省用默认值，persona 写合法整数就用它", () => {
    assert.equal(webSearchLimitOf({} as PersonaSpec), DEFAULT_WEB_SEARCH_BUDGET_PER_ASK);
    assert.equal(webSearchLimitOf({ budget: { webSearch: 0 } } as never), 0);
    assert.equal(webSearchLimitOf({ budget: { webSearch: 5 } } as never), 5);
  });

  it("非法值回落默认值，不用无上限兜底", () => {
    for (const bad of [-1, 1.5, MAX_WEB_SEARCH_BUDGET_PER_ASK + 1, "8", null]) {
      assert.equal(webSearchLimitOf({ budget: { webSearch: bad } } as never), DEFAULT_WEB_SEARCH_BUDGET_PER_ASK);
    }
  });
});

describe("makeWebSearchBudgetPort", () => {
  it("按上限放行，第 N+1 次耗尽并给出文案", () => {
    const state = stateOf({ webSearchLimit: 2 });
    const port = portFor(state);
    assert.equal(port.charge().kind, "charged");
    assert.equal(port.charge().kind, "charged");
    const over = port.charge();
    assert.equal(over.kind, "exhausted");
    assert.equal(over.kind === "exhausted" && over.limit, 2);
    assert.equal(
      over.kind === "exhausted" && over.message,
      webSearchBudgetExhaustedMessage(2),
    );
    // 被拒的那次不计入已用次数。
    assert.equal(state.webSearchesUsed, 2);
  });

  it("限额 0 表示一次都不许搜", () => {
    const port = portFor(stateOf({ webSearchLimit: 0 }));
    assert.equal(port.charge().kind, "exhausted");
  });

  it("没有在飞 ask 时不扣也不拦", () => {
    const state = stateOf({ currentInstance: undefined });
    assert.equal(portFor(state).charge().kind, "charged");
    assert.equal(state.webSearchesUsed, 0);
  });

  it("会话缺席时不报错也不扣减", () => {
    assert.equal(portFor(undefined).charge().kind, "charged");
  });

  it("计数按状态共享：同一会话的两个端口看到同一个已用次数", () => {
    const state = stateOf({ webSearchLimit: 1 });
    const sessions = new Map<string, SessionState>([[SESSION, state]]);
    const a = makeWebSearchBudgetPort(sessions, SESSION);
    const b = makeWebSearchBudgetPort(sessions, SESSION);
    assert.equal(a.charge().kind, "charged");
    assert.equal(b.charge().kind, "exhausted");
  });
});
