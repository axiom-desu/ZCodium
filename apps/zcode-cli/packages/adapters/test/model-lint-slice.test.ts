import assert from "node:assert/strict";
import { it } from "node:test";
import type { ModelStreamEvent } from "@zcode/contracts";

import { classifyModelFailure } from "../src/model/failure-classifier.js";
import { normalizeGenerateTextOutput } from "../src/model/runner-generate-support.js";
import { applyStreamEventsToRetryBoundary } from "../src/model/runner-stream-chunks.js";
import { toAiSdkMessages } from "../src/model/transform.js";

// 本切片测试锁定抽取后的关键边界：请求转换顺序、stream chunk 重试边界、
// usage 归一化来源与失败分类优先级。行为与拆分前逐项一致。

it("toAiSdkMessages keeps system/user/assistant/tool order and cache control", () => {
  const messages = toAiSdkMessages([
    { role: "system", content: "sys", cacheControl: { type: "ephemeral" } },
    { role: "user", content: "" },
    {
      role: "assistant",
      content: "hi",
      toolCalls: [{ id: "call_1", name: "lookup", input: { q: 1 } }],
    },
    { role: "tool", content: "result", toolCallId: "call_1", toolName: "lookup" },
  ]);

  assert.deepEqual(
    messages.map((message) => message.role),
    ["system", "user", "assistant", "tool"],
  );
  assert.deepEqual((messages[0] as { providerOptions?: unknown }).providerOptions, {
    anthropic: { cacheControl: { type: "ephemeral" } },
  });
  assert.equal(messages[1]?.content, "(no content)");
  const assistantContent = messages[2]?.content as unknown[];
  assert.deepEqual(assistantContent.at(-1), {
    type: "tool-call",
    toolCallId: "call_1",
    toolName: "lookup",
    input: { q: 1 },
  });
  const toolContent = messages[3]?.content as { type: string; toolCallId?: string }[];
  assert.equal(toolContent[0]?.type, "tool-result");
  assert.equal(toolContent[0]?.toolCallId, "call_1");
});

it("toAiSdkMessages rejects tool messages without toolCallId", () => {
  assert.throws(
    () => toAiSdkMessages([{ role: "tool", content: "x", toolName: "lookup" }]),
    /toolCallId/,
  );
});

it("classifyModelFailure keeps the original error priority", () => {
  assert.equal(
    classifyModelFailure(Object.assign(new Error("rate"), { statusCode: 429 })).code,
    "model_rate_limited",
  );

  const auth = classifyModelFailure(Object.assign(new Error("auth"), { statusCode: 401 }));
  assert.equal(auth.code, "provider_not_configured");
  assert.equal(auth.reason, "auth_failed");
  assert.equal(auth.retryable, false);

  const controller = new AbortController();
  controller.abort();
  const cancelled = classifyModelFailure(new Error("aborted"), controller.signal);
  assert.equal(cancelled.reason, "cancelled");
  assert.equal(cancelled.retryable, false);

  // InvalidModelRequest 是本地契约错误，优先于任何 HTTP 状态。
  const invalid = classifyModelFailure(
    Object.assign(new Error("invalid"), {
      code: "invalid_model_request",
      statusCode: 429,
    }),
  );
  assert.equal(invalid.code, "invalid_model_request");
  assert.equal(invalid.retryable, false);
});

it("stream retry boundary holds prelude events until a committed event", () => {
  const pending: ModelStreamEvent[] = [];
  const held = applyStreamEventsToRetryBoundary({
    emittedRetryBoundaryEvent: false,
    events: [{ type: "start" } as ModelStreamEvent],
    pendingRetrySafeEvents: pending,
    preserveProviderStreamBoundaries: true,
  });
  assert.equal(held.visibleEvents.length, 0);
  assert.equal(held.emittedRetryBoundaryEvent, false);
  assert.equal(pending.length, 1);

  const committed = applyStreamEventsToRetryBoundary({
    emittedRetryBoundaryEvent: false,
    events: [{ type: "text_delta", text: "hi" } as ModelStreamEvent],
    pendingRetrySafeEvents: pending,
    preserveProviderStreamBoundaries: true,
  });
  assert.equal(committed.emittedRetryBoundaryEvent, true);
  assert.deepEqual(
    committed.visibleEvents.map((event) => event.type),
    ["start", "text_delta"],
  );
  assert.equal(pending.length, 0);
});

it("provider event observation flushes held prelude once", () => {
  const pending: ModelStreamEvent[] = [{ type: "start" } as ModelStreamEvent];
  const observed = applyStreamEventsToRetryBoundary({
    emittedRetryBoundaryEvent: false,
    events: [],
    pendingRetrySafeEvents: pending,
    preserveProviderStreamBoundaries: true,
    providerEventObserved: true,
  });
  assert.equal(observed.emittedRetryBoundaryEvent, true);
  assert.deepEqual(
    observed.visibleEvents.map((event) => event.type),
    ["start"],
  );
  assert.equal(pending.length, 0);
});

it("normalizeGenerateTextOutput prefers totalUsage and keeps text", () => {
  const output = normalizeGenerateTextOutput(
    {
      text: "hello",
      reasoning: undefined,
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      totalUsage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
      toolCalls: [],
      toolResults: [],
      sources: [],
    },
    { messages: [] },
    undefined,
  );

  assert.equal(output.text, "hello");
  assert.equal(output.usage.inputTokens, 4);
  assert.equal(output.usage.outputTokens, 5);
  assert.equal(output.usage.totalTokens, 9);
});
