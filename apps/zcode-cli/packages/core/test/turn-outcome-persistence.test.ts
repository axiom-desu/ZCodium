import assert from "node:assert/strict";
import { it } from "node:test";
import type { SessionId, SessionLastOutcome, TraceContext } from "@zcode/contracts";
import { SessionEventType, createSessionEvent } from "@zcode/contracts";

import { persistDurableSessionEvent } from "../src/runtime/methods/events-durable-persistence.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";

/**
 * 终态 lastOutcome 的归属：TurnComplete/TurnError 在终态事件发布前落唯一 session 行。
 * 这里只实例化该投影所需的 runtime 面（sessionStore），store 记录每次写请求。
 */
async function persist(
  type: SessionEventType,
  payload: unknown,
): Promise<{ id: string; lastOutcome?: SessionLastOutcome; timeUpdated?: number }[]> {
  const writes: { id: string; lastOutcome?: SessionLastOutcome; timeUpdated?: number }[] = [];
  const runtime = {
    sessionStore: {
      updateSession: async (input: { id: string }) => {
        writes.push(structuredClone(input) as (typeof writes)[number]);
        return input;
      },
    },
  } as unknown as AgentRuntimeInternal;
  const traceContext = { turnId: "turn-1", traceId: "trace-1" } as unknown as TraceContext;
  const event = createSessionEvent(type, "sess-1" as SessionId, payload, {
    turnId: traceContext.turnId,
    traceId: traceContext.traceId,
  });
  await persistDurableSessionEvent.call(runtime, event, traceContext);
  return writes;
}

async function outcomeOf(type: SessionEventType, payload: unknown) {
  const writes = await persist(type, payload);
  assert.equal(writes.length, 1);
  return writes[0]!;
}

it("TurnComplete 写 completed，取消写 interrupted，TurnError 写 error", async () => {
  const completed = await outcomeOf(SessionEventType.TurnComplete, { resultType: "success" });
  assert.equal(completed.id, "sess-1");
  assert.equal(completed.lastOutcome, "completed");
  // 写入发生在终态事件发布前，活动时间取事件自身时间戳，不另取 Date.now。
  assert.equal(typeof completed.timeUpdated, "number");

  assert.equal(
    (await outcomeOf(SessionEventType.TurnComplete, { resultType: "cancelled" })).lastOutcome,
    "interrupted",
  );
  assert.equal(
    (await outcomeOf(SessionEventType.TurnError, { error: { message: "boom" } })).lastOutcome,
    "error",
  );
});

it("非终态事件不写 lastOutcome", async () => {
  assert.deepEqual(await persist(SessionEventType.TurnSteerQueued, { input: "x" }), []);
});
