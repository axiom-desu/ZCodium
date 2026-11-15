// 会话选区引用 → 模型材料 的纯函数守卫（上游 3.18.2 conversation-quotes）。
import assert from "node:assert/strict";
import { it } from "node:test";

import { withConversationQuotes } from "../src/runtime/helpers/conversation-quotes.js";

const COMMENT_GUIDANCE =
  "Each conversation_quote item with a `comment` field is a user annotation on that exact quoted text";

it("没有引用时正文逐字节不变", () => {
  assert.equal(withConversationQuotes("hello", undefined), "hello");
  assert.equal(withConversationQuotes("hello", []), "hello");
});

it("引用作为 JSON 材料附加，正文仍是 canonical 用户输入", () => {
  const quotes = [{ comment: "为什么这里要 sleep？", text: "await sleep(10)" }];
  const result = withConversationQuotes("解释这段", quotes);
  assert.ok(result.startsWith("解释这段\n\n<conversation_quote>\n"));
  assert.match(result, /<\/conversation_quote>\n\n/u);
  assert.match(result, /await sleep\(10\)/u);
  // 有非空批注时追加一句用途说明，模型才知道 comment 是用户对原文的要求。
  assert.match(result, new RegExp(COMMENT_GUIDANCE.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
});

it("只有空白批注不追加说明，也不丢引用", () => {
  const result = withConversationQuotes("看一下", [{ comment: "   ", text: "plain quote" }]);
  assert.match(result, /plain quote/u);
  assert.doesNotMatch(result, /user annotation on that exact quoted text/u);
});

it("纯函数：不修改传入数组，也不把引用里的命令文本当控制命令", () => {
  const quotes = [{ text: "/stop" }];
  const before = JSON.stringify(quotes);
  const result = withConversationQuotes("", quotes);
  assert.equal(JSON.stringify(quotes), before);
  assert.match(result, /"\/stop"/u);
});
