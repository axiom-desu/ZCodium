import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  InMemorySessionEventStore,
  SessionEventType,
  createModelUsageSummaryFromEvents,
  type ModelNetworkStatusEvent,
  type SessionEvent,
  type SessionId,
  type TurnId,
} from "../src/index.js";

// 失败用量入账规则（Node `createModelUsageSummaryFromEvents`）：
// 成功只由 ModelComplete 计入；终止失败事件的 usage 补一次；重试不重复。

let counter = 0;

function event(
  type: SessionEventType,
  payload: Record<string, unknown>,
  sequenceNumber: number,
): SessionEvent {
  counter += 1;
  return {
    id: `evt_${counter}`,
    payload,
    sequenceNumber,
    sessionId: "session_a" as SessionId,
    timestamp: new Date(counter),
    traceId: "trace",
    turnId: "turn_a" as TurnId,
    type,
  } as unknown as SessionEvent;
}

function failedNetworkStatus(
  payload: Partial<ModelNetworkStatusEvent> & { type: "model_request_failed" },
  sequenceNumber: number,
): SessionEvent {
  return event(
    SessionEventType.ModelNetworkStatus,
    {
      attempt: 1,
      maxAttempts: 3,
      modelId: "m",
      providerId: "p",
      requestId: `req_${sequenceNumber}`,
      timestamp: new Date(counter).toISOString(),
      traceId: "trace",
      transport: "sse",
      ...payload,
    },
    sequenceNumber,
  );
}

function completed(usage: Record<string, number>, sequenceNumber: number): SessionEvent {
  return event(
    SessionEventType.ModelComplete,
    { content: "ok", stopReason: "stop", usage },
    sequenceNumber,
  );
}

describe("failure usage · 账本与冷恢复", () => {
  it("终止失败 usage 只计一次，成功仍只由 ModelComplete 计入", () => {
    // 重试中的失败不带 usage（适配层只在终止失败上附带）。
    const retryFailed = failedNetworkStatus(
      { reason: "server_error", retryable: true, type: "model_request_failed" },
      0,
    );
    const contextFailed = failedNetworkStatus(
      {
        reason: "context_exceeded",
        retryable: false,
        type: "model_request_failed",
        usage: { inputTokens: 120_000, outputTokens: 0, totalTokens: 120_000 },
      },
      1,
    );
    const done = completed({ inputTokens: 10, outputTokens: 4, totalTokens: 14 }, 2);

    const onlyFailed = createModelUsageSummaryFromEvents([retryFailed, contextFailed]);
    assert.deepEqual(onlyFailed, {
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      inputTokens: 120_000,
      modelRequestCount: 1,
      outputTokens: 0,
      reasoningTokens: 0,
      source: "provider",
      totalTokens: 120_000,
      webFetchRequests: 0,
      webSearchRequests: 0,
    });

    const both = createModelUsageSummaryFromEvents([retryFailed, contextFailed, done]);
    assert.equal(both?.modelRequestCount, 2);
    assert.equal(both?.inputTokens, 120_010);
    assert.equal(both?.totalTokens, 120_014);
  });

  it("durable 事件 JSON 往返（冷恢复）后用量不变", () => {
    const events = [
      failedNetworkStatus(
        {
          reason: "context_exceeded",
          retryable: false,
          type: "model_request_failed",
          usage: {
            cacheReadTokens: 30,
            inputTokens: 60_000,
            outputTokens: 0,
            totalTokens: 60_000,
          },
        },
        0,
      ),
      completed({ inputTokens: 1_000, outputTokens: 200, totalTokens: 1_200 }, 1),
    ];
    // 持久层只保存可序列化事实：JSON 往返等价于关库重读。
    const restored = JSON.parse(JSON.stringify(events)) as SessionEvent[];
    assert.deepEqual(
      createModelUsageSummaryFromEvents(restored),
      createModelUsageSummaryFromEvents(events),
    );
    const summary = createModelUsageSummaryFromEvents(restored);
    assert.equal(summary?.modelRequestCount, 2);
    assert.equal(summary?.cacheReadTokens, 30);
    assert.equal(summary?.inputTokens, 61_000);
  });

  it("事件存储 append 后读回仍是同一份用量", async () => {
    const store = new InMemorySessionEventStore();
    const events = [
      failedNetworkStatus(
        {
          reason: "context_exceeded",
          retryable: false,
          type: "model_request_failed",
          usage: { inputTokens: 5_000, outputTokens: 0, totalTokens: 5_000 },
        },
        0,
      ),
    ];
    for (const item of events) await store.append(item);
    const read = await store.getEvents("session_a" as SessionId);
    assert.deepEqual(createModelUsageSummaryFromEvents(read), {
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      inputTokens: 5_000,
      modelRequestCount: 1,
      outputTokens: 0,
      reasoningTokens: 0,
      source: "provider",
      totalTokens: 5_000,
      webFetchRequests: 0,
      webSearchRequests: 0,
    });
  });
});
