import { describe, expect, it } from "vitest";
import type { ZCodeStreamEvent } from "@zcode/shared";
import {
  conversationReducer,
  initialConversationState,
  isSameConversationScope,
  type ConversationAction,
  type ConversationMessage,
  type ConversationScope,
  type ConversationState,
} from "./conversationReducer.js";

const scopeA: ConversationScope = { workspaceKey: "ws-a", taskId: "task-1" };
const scopeB: ConversationScope = { workspaceKey: "ws-a", taskId: "task-2" };

function begin(scope: ConversationScope = scopeA): ConversationState {
  return conversationReducer(initialConversationState, { type: "beginScope", scope });
}

function applySnapshot(
  state: ConversationState,
  messages: ConversationMessage[],
  scope: ConversationScope = scopeA,
): ConversationState {
  return conversationReducer(state, { type: "applySnapshot", scope, messages });
}

function stream(
  state: ConversationState,
  event: ZCodeStreamEvent,
  scope: ConversationScope = scopeA,
): ConversationState {
  return conversationReducer(state, { type: "streamEvent", scope, event });
}

function chunk(params: {
  content: string;
  messageId?: string;
  traceId?: string;
  inputId?: string;
}): Extract<ZCodeStreamEvent, { type: "agent_message_chunk" }> {
  return {
    type: "agent_message_chunk",
    taskId: scopeA.taskId,
    traceId: params.traceId ?? "trace-1",
    ...(params.messageId ? { messageId: params.messageId } : {}),
    ...(params.inputId ? { inputId: params.inputId } : {}),
    content: params.content,
  };
}

function snapshotUpdated(): Extract<ZCodeStreamEvent, { type: "task_snapshot_updated" }> {
  return {
    type: "task_snapshot_updated",
    workspacePath: "/workspace/a",
    workspaceKey: scopeA.workspaceKey,
    taskId: scopeA.taskId,
    traceId: "trace-1",
  };
}

describe("conversationReducer scope", () => {
  it("scope 身份按 workspace + task 判定", () => {
    expect(isSameConversationScope(scopeA, { ...scopeA })).toBe(true);
    expect(isSameConversationScope(scopeA, scopeB)).toBe(false);
    expect(isSameConversationScope(scopeA, null)).toBe(false);
    expect(isSameConversationScope(null, scopeA)).toBe(false);
  });

  it("切换 task 后丢弃迟到事件", () => {
    let state = begin(scopeA);
    state = applySnapshot(state, [{ id: "u1", role: "user", text: "旧任务历史" }]);
    state = conversationReducer(state, { type: "beginScope", scope: scopeB });
    expect(state.scope).toEqual(scopeB);
    expect(state.messages).toEqual([]);

    // 旧 scope 的迟到 chunk 不能污染新任务。
    state = stream(state, chunk({ messageId: "late", content: "旧任务迟到碎片" }), scopeA);
    expect(state.messages).toEqual([]);

    // 旧 scope 的迟到快照同样被丢弃。
    state = applySnapshot(state, [{ id: "u2", role: "user", text: "旧快照" }], scopeA);
    expect(state.messages).toEqual([]);
  });
});

describe("conversationReducer stream chunks", () => {
  it("屏障落地前丢弃增量 chunk，落地后按序渲染", () => {
    let state = begin();
    expect(state.awaitingSnapshot).toBe(true);

    state = stream(state, chunk({ messageId: "m1", content: "早到增量" }));
    expect(state.messages).toEqual([]);

    state = applySnapshot(state, [{ id: "u1", role: "user", text: "你好" }]);
    expect(state.awaitingSnapshot).toBe(false);

    state = stream(state, chunk({ messageId: "m1", content: "屏障后增量" }));
    expect(state.messages).toEqual([
      { id: "u1", role: "user", text: "你好" },
      { id: "m1", role: "assistant", text: "屏障后增量" },
    ]);
  });

  it("乱序 chunk 按 messageId 归并到各自气泡", () => {
    let state = applySnapshot(begin(), []);
    state = stream(state, chunk({ messageId: "m1", content: "A1" }));
    state = stream(state, chunk({ messageId: "m2", content: "B1" }));
    state = stream(state, chunk({ messageId: "m1", content: "A2" }));
    state = stream(state, chunk({ messageId: "m2", content: "B2" }));

    expect(state.messages).toEqual([
      { id: "m1", role: "assistant", text: "A1A2" },
      { id: "m2", role: "assistant", text: "B1B2" },
    ]);
  });

  it("重复 chunk 幂等：不新增气泡也不重复累加", () => {
    let state = applySnapshot(begin(), []);
    state = stream(state, chunk({ messageId: "m1", content: "hello" }));
    state = stream(state, chunk({ messageId: "m1", content: " world" }));
    const before = state;

    state = stream(state, chunk({ messageId: "m1", content: " world" }));
    expect(state).toBe(before);
    expect(state.messages).toEqual([{ id: "m1", role: "assistant", text: "hello world" }]);
  });

  it("累计式 chunk 覆盖而不追加", () => {
    let state = applySnapshot(begin(), []);
    state = stream(state, chunk({ messageId: "m1", content: "你好" }));
    state = stream(state, chunk({ messageId: "m1", content: "你好，世界" }));
    expect(state.messages).toEqual([{ id: "m1", role: "assistant", text: "你好，世界" }]);
  });

  it("缺 messageId 时按 traceId 归并", () => {
    let state = applySnapshot(begin(), []);
    state = stream(state, chunk({ traceId: "trace-9", content: "foo" }));
    state = stream(state, chunk({ traceId: "trace-9", content: "bar" }));
    expect(state.messages).toEqual([{ id: "trace-9", role: "assistant", text: "foobar" }]);
  });
});

describe("conversationReducer resync", () => {
  it("task_snapshot_updated 置回等快照屏障并禁止增量", () => {
    let state = applySnapshot(begin(), [{ id: "m1", role: "assistant", text: "已渲染" }]);
    state = stream(state, snapshotUpdated());
    expect(state.awaitingSnapshot).toBe(true);
    expect(state.needsResync).toBe(true);

    state = stream(state, chunk({ messageId: "m1", content: "屏障期碎片" }));
    expect(state.messages).toEqual([{ id: "m1", role: "assistant", text: "已渲染" }]);
  });

  it("bridge-degraded/断档置 resync 标志并要求重读快照", () => {
    let state = applySnapshot(begin(), [{ id: "m1", role: "assistant", text: "已渲染" }]);
    state = conversationReducer(state, { type: "resync", scope: scopeA });
    expect(state.needsResync).toBe(true);
    expect(state.awaitingSnapshot).toBe(true);
  });

  it("重读快照清空 resync 与屏障，并覆盖本地增量", () => {
    let state = applySnapshot(begin(), []);
    state = stream(state, chunk({ messageId: "m1", content: "本地增量" }));
    expect(state.messages).toEqual([{ id: "m1", role: "assistant", text: "本地增量" }]);
    state = conversationReducer(state, { type: "resync", scope: scopeA });
    state = applySnapshot(state, [{ id: "m1", role: "assistant", text: "权威快照" }]);
    expect(state.needsResync).toBe(false);
    expect(state.awaitingSnapshot).toBe(false);
    expect(state.messages).toEqual([{ id: "m1", role: "assistant", text: "权威快照" }]);
  });

  it("终态事件触发一次最终对账", () => {
    let state = applySnapshot(begin(), []);
    const complete: ZCodeStreamEvent = {
      type: "task_complete",
      taskId: scopeA.taskId,
      traceId: "trace-1",
      stopReason: "complete",
    };
    state = stream(state, complete);
    expect(state.needsResync).toBe(true);
    expect(state.awaitingSnapshot).toBe(true);
  });
});

describe("conversationReducer optimistic user message", () => {
  it("乐观用户消息只进入匹配 scope", () => {
    let state = begin(scopeA);
    state = conversationReducer(state, {
      type: "appendOptimisticUserMessage",
      scope: scopeA,
      id: "local-1",
      text: "先显示这条",
    });
    expect(state.messages).toEqual([{ id: "local-1", role: "user", text: "先显示这条" }]);

    const action: ConversationAction = {
      type: "appendOptimisticUserMessage",
      scope: scopeB,
      id: "local-2",
      text: "不应进入",
    };
    state = conversationReducer(state, action);
    expect(state.messages).toEqual([{ id: "local-1", role: "user", text: "先显示这条" }]);
  });
});
