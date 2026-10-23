// S6：V4 工具行必须用 Core 确认的目标身份定稿；包装名只属于原始模型流。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFERRED_TOOL_CALL_NAME, SessionEventType, type SessionEvent } from "@zcode/contracts";
import { applyConversationDeltas } from "@zcode/shared/zcode-protocol-v4";

import { ConversationTopicPublisher } from "../src/zcode-protocol-v4/conversation-topic-publisher.js";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";

let sequence = 0;
function event(type: SessionEventType, payload: unknown, turnId = "turn"): SessionEvent {
  sequence += 1;
  return {
    id: `evt_${sequence}`,
    sessionId: "session",
    turnId,
    traceId: "trace",
    timestamp: new Date(1_700_000_000_000 + sequence),
    sequenceNumber: sequence,
    type,
    payload,
  } as SessionEvent;
}

function started() {
  const projection = new ProductProjection("session", "epoch");
  const publisher = new ConversationTopicPublisher("session", "epoch");
  const emit = (type: SessionEventType, payload: unknown, turnId?: string) => {
    const next = event(type, payload, turnId);
    const deltas = projection.applyEvent(next);
    publisher.ingest(next);
    return deltas;
  };
  emit(SessionEventType.SessionCreated, { mode: "plan", contextWindow: 200_000 });
  emit(SessionEventType.TurnStarted, { turnNumber: 1, input: "plan", messageId: "user" });
  const clients = (["continuous", "replayable"] as const).map((deliveryProfile) => {
    const subscription = publisher.subscribe({ connectionId: deliveryProfile, deliveryProfile });
    if (subscription.frame?.payload.kind !== "snapshot") throw new Error("expected snapshot");
    return {
      deliveryProfile,
      subscriptionId: subscription.ack.subscriptionId,
      snapshot: subscription.frame.payload.snapshot,
    };
  });
  return { projection, publisher, emit, clients };
}

const TARGET = "TodoWrite";
const INPUT = { todos: [{ content: "next", priority: "medium", status: "pending" }] };
const wrapperInput = { input: INPUT, name: TARGET };

function wrapperRow() {
  return started()
    .projection.getSnapshot()
    .rows.window.find((row) => row.kind === "toolCall");
}

describe("DeferredToolCall product projection", () => {
  it("scheduled 目标身份覆盖包装行，迟到原始流不能回退", () => {
    const { projection, publisher, emit, clients } = started();
    emit(SessionEventType.ModelStreaming, {
      kind: "tool_input_start",
      toolCallId: "call-1",
      toolName: DEFERRED_TOOL_CALL_NAME,
      done: false,
      delta: "",
    });
    const raw = {
      kind: "tool_call",
      toolCallId: "call-1",
      toolName: DEFERRED_TOOL_CALL_NAME,
      input: wrapperInput,
      done: false,
      delta: "",
    };
    emit(SessionEventType.ModelStreaming, raw);
    emit(SessionEventType.ToolCallScheduled, {
      toolCallId: "call-1",
      toolName: TARGET,
      input: INPUT,
      schedule: { parallelGroups: [["call-1"]], executionOrder: ["call-1"] },
    });
    // 迟到/重放的包装流不得把已定稿目标输入改回 {name,input}。
    emit(SessionEventType.ModelStreaming, raw);
    const row = projection.getSnapshot().rows.window.find((item) => item.kind === "toolCall");
    assert.equal(row?.toolName, TARGET);
    assert.deepEqual(row?.input, INPUT);
    assert.equal(row?.inputText, JSON.stringify(INPUT));
    for (const client of clients) {
      const frame = publisher.flush(client.subscriptionId);
      if (frame?.payload.kind !== "deltas") throw new Error("expected deltas");
      const snapshot = applyConversationDeltas(client.snapshot, frame.payload.deltas);
      const projected = snapshot.rows.window.find((item) => item.kind === "toolCall");
      assert.equal(projected?.toolName, TARGET);
      assert.deepEqual(projected?.input, INPUT);
    }
  });

  it("断流后的 tool_call_closed 只补齐包装行目标身份，不重置已有错误", () => {
    const { projection, emit } = started();
    emit(SessionEventType.ModelStreaming, {
      kind: "tool_input_start",
      toolCallId: "call-2",
      toolName: DEFERRED_TOOL_CALL_NAME,
      done: false,
      delta: "",
    });
    emit(SessionEventType.ModelStreaming, {
      kind: "tool_call",
      toolCallId: "call-2",
      toolName: DEFERRED_TOOL_CALL_NAME,
      input: wrapperInput,
      done: false,
      delta: "",
    });
    emit(SessionEventType.ToolCallError, {
      toolCallId: "call-2",
      error: { type: "interrupted", message: "interrupted" },
    });
    const before = projection.getSnapshot().rows.window.find((row) => row.kind === "toolCall");
    emit(SessionEventType.StreamingToolLedgerUpdated, {
      assistantMessageId: "assistant",
      attemptId: "attempt",
      toolCallId: "call-2",
      toolName: TARGET,
      input: INPUT,
      status: "tool_call_closed",
      executionTiming: "during_stream",
    });
    const row = projection.getSnapshot().rows.window.find((item) => item.kind === "toolCall");
    assert.deepEqual(row, {
      ...before,
      toolName: TARGET,
      input: INPUT,
      inputText: JSON.stringify(INPUT),
    });
    assert.equal(row?.status, "error");
    // 重复 closed 事件不重复更新。
    assert.deepEqual(
      emit(SessionEventType.StreamingToolLedgerUpdated, {
        assistantMessageId: "assistant",
        attemptId: "attempt",
        toolCallId: "call-2",
        toolName: TARGET,
        input: INPUT,
        status: "tool_call_closed",
        executionTiming: "during_stream",
      }),
      [],
    );
  });

  it("普通行、缺输入、错误状态、旧 turn 与子代理镜像不参与补齐", () => {
    const { projection, emit } = started();
    emit(SessionEventType.ModelStreaming, {
      kind: "tool_call",
      toolCallId: "call-3",
      toolName: "Read",
      input: { file_path: "/tmp/a" },
      done: false,
      delta: "",
    });
    const before = wrapperRow() ?? projection.getSnapshot().rows.window.at(-1);
    assert.ok(before);
    for (const payload of [
      {
        assistantMessageId: "assistant",
        attemptId: "attempt",
        toolCallId: "call-3",
        toolName: "Read",
        input: { file_path: "/tmp/b" },
        status: "tool_call_closed",
        executionTiming: "during_stream",
      },
      {
        assistantMessageId: "assistant",
        attemptId: "attempt",
        toolCallId: "call-3",
        toolName: TARGET,
        status: "tool_call_closed",
        executionTiming: "during_stream",
      },
      {
        assistantMessageId: "assistant",
        attemptId: "attempt",
        toolCallId: "missing",
        toolName: TARGET,
        input: INPUT,
        status: "tool_call_closed",
        executionTiming: "during_stream",
      },
    ]) {
      assert.deepEqual(emit(SessionEventType.StreamingToolLedgerUpdated, payload), []);
    }
    assert.deepEqual(
      projection.getSnapshot().rows.window.find((row) => row.kind === "toolCall"),
      before,
    );
  });
});
