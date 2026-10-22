import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AskUserQuestionInputSchema } from "../../apps/zcode-cli/packages/contracts/src/tools/ask-user-question.ts";
import { contentText, modelServer } from "../lib/zcode-cli-rust-interop-fixture.mjs";

/**
 * 这条独立用例防止 TUI smoke 自证：它不读 PTY，也不读 Rust 二进制，
 * 而是拿共享 fixture 真实发出的 AskUserQuestion 参数去校验 TS zod 契约
 * （Rust `tool_schemas.json` 的生成源）与 Rust 实际下发的 JSON schema，
 * 再用真实 loopback modelServer 验证「答案关联 → 问答完成」只对工具结果成立。
 */

const schemaFile = new URL(
  "../../apps/zcode-cli-rust/crates/tools/src/tool_schemas.json",
  import.meta.url,
);

/** 覆盖该 schema 用到的 JSON Schema 子集：object/array/string/boolean、required、items、min/max、封闭属性。 */
function assertJsonSchema(schema, value, path = "$") {
  if (schema.type === "object") {
    assert.ok(
      typeof value === "object" && value !== null && !Array.isArray(value),
      `${path} must be an object`,
    );
    for (const key of schema.required ?? []) assert.ok(key in value, `${path}.${key} is required`);
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (value[key] === undefined) continue;
      assertJsonSchema(child, value[key], `${path}.${key}`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value))
        assert.ok(key in (schema.properties ?? {}), `${path}.${key} is not an allowed field`);
    }
    return;
  }
  if (schema.type === "array") {
    assert.ok(Array.isArray(value), `${path} must be an array`);
    if (schema.minItems !== undefined)
      assert.ok(value.length >= schema.minItems, `${path} needs >= ${schema.minItems} items`);
    if (schema.maxItems !== undefined)
      assert.ok(value.length <= schema.maxItems, `${path} allows <= ${schema.maxItems} items`);
    for (const [index, item] of value.entries()) {
      if (schema.items) assertJsonSchema(schema.items, item, `${path}[${index}]`);
    }
    return;
  }
  if (schema.type === "string")
    return assert.equal(typeof value, "string", `${path} must be a string`);
  if (schema.type === "boolean")
    return assert.equal(typeof value, "boolean", `${path} must be a boolean`);
  throw new Error(`${path} uses an unsupported schema type: ${String(schema.type)}`);
}

/** 读取 SSE chat completions 响应：累积文本增量与 tool_calls，供断言真实 fixture 行为。 */
async function chat(baseUrl, messages) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "model-a", stream: true, messages }),
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  let content = "";
  const calls = [];
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice("data: ".length).trim();
    if (payload === "[DONE]") continue;
    const delta = JSON.parse(payload).choices?.[0]?.delta ?? {};
    if (typeof delta.content === "string") content += contentText(delta.content);
    for (const call of delta.tool_calls ?? []) {
      const slot = (calls[call.index ?? 0] ??= { id: "", name: "", arguments: "" });
      if (call.id) slot.id = call.id;
      if (call.function?.name) slot.name = call.function.name;
      if (call.function?.arguments) slot.arguments += call.function.arguments;
    }
  }
  return { content, calls: calls.filter(Boolean) };
}

test("tui-question fixture uses the real AskUserQuestion args and answer association", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zcode-rust-tui-question-"));
  const model = await modelServer({ root });
  t.after(async () => {
    await model.close();
    await rm(root, { recursive: true, force: true });
  });

  const argsSchema = JSON.parse(await readFile(schemaFile, "utf8")).AskUserQuestion;
  const opened = await chat(model.baseUrl, [{ role: "user", content: "tui-question" }]);
  assert.equal(opened.calls.length, 1, "tui-question must issue exactly one tool call");
  const [toolCall] = opened.calls;
  assert.equal(toolCall.name, "AskUserQuestion");
  const args = JSON.parse(toolCall.arguments);

  // 真实调用参数：TS 契约（Rust 工具 schema 的生成源）+ Rust 实际下发 schema 双重校验。
  const parsed = AskUserQuestionInputSchema.safeParse(args);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  assertJsonSchema(argsSchema, args);
  assert.deepEqual(Object.keys(args), ["questions"]);
  const [question] = args.questions;
  assert.equal(question.question, "Choose the TUI smoke answer");
  assert.equal(question.header, "TUI smoke");
  assert.equal(question.multiSelect, false);
  assert.deepEqual(
    question.options.map((option) => option.label),
    ["SMOKE_ANSWER", "SMOKE_ALTERNATE"],
  );
  // 旧 fixture 的单数 question/字符串 options 必须仍然被真实 schema 拒绝，证明校验不是空转。
  assert.equal(
    AskUserQuestionInputSchema.safeParse({
      question: "Choose the TUI smoke answer",
      options: ["SMOKE_ANSWER", "Other"],
    }).success,
    false,
  );
  assert.throws(() => assertJsonSchema(argsSchema, { question: "x", options: ["A", "B"] }));

  const callMessage = (call, questionArgs) => ({
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: call.id,
        type: "function",
        function: { name: "AskUserQuestion", arguments: questionArgs },
      },
    ],
  });
  const openedHistory = [
    { role: "user", content: "tui-question" },
    callMessage(toolCall, toolCall.arguments),
  ];
  const answerOf = (text) =>
    `User has answered your questions: "${text}"="SMOKE_ANSWER". You can now continue with the user's answers in mind.`;

  // 1) 同一 AskUserQuestion 的成功 tool result 才产生唯一 completion。
  const answered = await chat(model.baseUrl, [
    ...openedHistory,
    { role: "tool", tool_call_id: toolCall.id, content: answerOf(question.question) },
  ]);
  assert.equal(answered.content, "question answered: SMOKE_ANSWER");

  // 2) 工具参数/协议错误（旧伪问答的真实形态）不得被当成回答。
  const failed = await chat(model.baseUrl, [
    ...openedHistory,
    {
      role: "tool",
      tool_call_id: toolCall.id,
      content:
        "unknown field `question`, expected one of `questions`, `answers`, `annotations`, `metadata`",
    },
  ]);
  assert.equal(failed.content, "question unanswered: missing real AskUserQuestion answer");

  // 3) 普通 SMOKE_ANSWER prompt 只是普通回显，不是问答完成。
  const plain = await chat(model.baseUrl, [{ role: "user", content: "SMOKE_ANSWER" }]);
  assert.equal(plain.content, "answer: SMOKE_ANSWER");
  assert.ok(!plain.content.startsWith("question answered:"));

  // 4) 关联按 tool_call_id + 问题文本匹配：第二个问答的答案不能算到第一个调用上。
  const otherArgs = {
    questions: [
      {
        question: "Choose another answer",
        header: "Other",
        multiSelect: false,
        options: [
          { label: "SMOKE_ANSWER", description: "Same label, different question." },
          { label: "SMOKE_ALTERNATE", description: "Alternate." },
        ],
      },
    ],
  };
  assertJsonSchema(argsSchema, otherArgs);
  const otherCall = {
    id: "call_other_question",
    name: "AskUserQuestion",
    arguments: JSON.stringify(otherArgs),
  };
  const multiHistory = [
    { role: "user", content: "tui-question" },
    callMessage(toolCall, toolCall.arguments),
    { role: "tool", tool_call_id: toolCall.id, content: answerOf(question.question) },
    { role: "user", content: "tui-question again" },
    callMessage(otherCall, otherCall.arguments),
  ];
  const secondAnswer = await chat(model.baseUrl, [
    ...multiHistory,
    {
      role: "tool",
      tool_call_id: otherCall.id,
      content: `User has answered your questions: "${otherArgs.questions[0].question}"="SMOKE_ALTERNATE". You can now continue with the user's answers in mind.`,
    },
  ]);
  assert.equal(secondAnswer.content, "question answered: SMOKE_ALTERNATE");
  const wrongQuestion = await chat(model.baseUrl, [
    ...multiHistory,
    { role: "tool", tool_call_id: otherCall.id, content: answerOf(question.question) },
  ]);
  assert.equal(wrongQuestion.content, "question unanswered: missing real AskUserQuestion answer");

  // 5) 通用 interop 回归：非问答工具结果仍是 `tool done`。
  const readHistory = [
    { role: "user", content: "use tool" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_read",
          type: "function",
          function: { name: "Read", arguments: JSON.stringify({ file_path: "note.txt" }) },
        },
      ],
    },
  ];
  const readDone = await chat(model.baseUrl, [
    ...readHistory,
    { role: "tool", tool_call_id: "call_read", content: "TUI_NOTE_MARKER" },
  ]);
  assert.equal(readDone.content, "tool done");

  // 6) 错误/伪造文本即使带匹配的 q=a 也不能伪装成功：只有真实成功前缀才算作答。
  const spoofed = await chat(model.baseUrl, [
    ...openedHistory,
    {
      role: "tool",
      tool_call_id: toolCall.id,
      content: `tool failed: "${question.question}"="SMOKE_ANSWER" (User has answered your questions: not applied)`,
    },
  ]);
  assert.equal(spoofed.content, "question unanswered: missing real AskUserQuestion answer");
});
