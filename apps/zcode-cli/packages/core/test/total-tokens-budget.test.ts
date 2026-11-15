import assert from "node:assert/strict";
import { it } from "node:test";

import { TOTAL_TOKENS_BUDGET, formatTotalTokensReminder } from "../src/context/total-tokens.js";
import {
  consumeTotalTokensBudget,
  createTotalTokensBudgetState,
  decideTotalTokensReminder,
  reanchorTotalTokensBudget,
  rollOverTotalTokensBudget,
} from "../src/runtime/helpers/total-tokens-budget.js";

// 上游 3.18.2 core/tests/total-tokens-reminder.test.ts 的判定表，改写为本仓 node:test。
// 这里是纯状态机；真实请求里的附件在 bootstrap/test/upstream-318-context-sync.test.ts。

it("预算是固定的 15M，文案是 tokens left", () => {
  assert.equal(TOTAL_TOKENS_BUDGET, 15_000_000);
  assert.equal(formatTotalTokensReminder(15_000_000), "<total_tokens>15000000 tokens left</total_tokens>");
  assert.equal(formatTotalTokensReminder(0), "<total_tokens>0 tokens left</total_tokens>");
});

it("maxUsed 只增不减：上下文回退不把倒数加回去", () => {
  let state = createTotalTokensBudgetState();
  const first = consumeTotalTokensBudget(state, 100_000);
  state = first.state;
  assert.equal(first.remaining, TOTAL_TOKENS_BUDGET - 100_000);
  const second = consumeTotalTokensBudget(state, 40_000);
  assert.equal(second.remaining, TOTAL_TOKENS_BUDGET - 100_000);
  assert.equal(second.state.maxUsed, 100_000);
});

it("重新起算把 anchor 推到 rolledOver + 当前上下文，maxUsed 归零", () => {
  let state = consumeTotalTokensBudget(createTotalTokensBudgetState(), 90_000).state;
  state = rollOverTotalTokensBudget(state, 500_000);
  state = reanchorTotalTokensBudget(state, 10_000);
  assert.deepEqual(state, { anchor: 510_000, maxUsed: 0, rolledOver: 500_000 });
  const consumed = consumeTotalTokensBudget(state, 12_000);
  // rolledOver + context - anchor = 2_000，压缩前的 500_000 不会被重新计入。
  assert.equal(consumed.remaining, TOTAL_TOKENS_BUDGET - 2_000);
});

it("压缩结转后不回到满额", () => {
  let state = consumeTotalTokensBudget(createTotalTokensBudgetState(), 400_000).state;
  state = rollOverTotalTokensBudget(state, 400_000);
  const consumed = consumeTotalTokensBudget(state, 30_000);
  assert.equal(consumed.remaining, TOTAL_TOKENS_BUDGET - 430_000);
});

it("工具批次之后总是提醒但不重新起算", () => {
  assert.deepEqual(
    decideTotalTokensReminder({ fromUser: false, mainSession: true, reason: "tool_batch" }),
    { emit: true, reanchor: false },
  );
  assert.deepEqual(
    decideTotalTokensReminder({ fromUser: true, mainSession: true, reason: "tool_batch" }),
    { emit: true, reanchor: false },
  );
});

it("轮首只对主会话里出自用户本人的输入提醒并重新起算", () => {
  assert.deepEqual(
    decideTotalTokensReminder({ fromUser: true, mainSession: true, reason: "turn_input" }),
    { emit: true, reanchor: true },
  );
  // goal 续跑 / 子 agent 任务这类非真实用户输入的轮首不提醒。
  assert.deepEqual(
    decideTotalTokensReminder({ fromUser: false, mainSession: true, reason: "turn_input" }),
    { emit: false, reanchor: false },
  );
  // 子 agent 会话即使输入来自父会话任务也不是主会话：不提醒。
  assert.deepEqual(
    decideTotalTokensReminder({ fromUser: true, mainSession: false, reason: "turn_input" }),
    { emit: false, reanchor: false },
  );
});

it("文本回复后的 guide：总是提醒，只有用户亲手 steer 才重新起算", () => {
  assert.deepEqual(
    decideTotalTokensReminder({ fromUser: true, mainSession: true, reason: "text_guide" }),
    { emit: true, reanchor: true },
  );
  // 信箱、工具跟进这类 guide 照常提醒，但不把倒数拨回满额。
  assert.deepEqual(
    decideTotalTokensReminder({ fromUser: false, mainSession: true, reason: "text_guide" }),
    { emit: true, reanchor: false },
  );
});
