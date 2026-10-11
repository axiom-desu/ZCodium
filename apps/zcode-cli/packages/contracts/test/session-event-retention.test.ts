import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createSessionEventRetentionPolicy,
  isTransientSessionEvent,
  SessionEventType,
  TRANSIENT_SESSION_EVENT_TYPES,
} from "../src/index.js";

const ev = (type: SessionEventType, turnId?: string) => ({ type, turnId });

describe("session event retention policy", () => {
  it("RET-001 turn-window：turn 结束只 seal，下一 turn 开始才淘汰上一 turn", () => {
    const policy = createSessionEventRetentionPolicy("turn-window");
    assert.deepEqual(policy.onAppend(ev(SessionEventType.TurnStarted, "t1"), 0), []);
    assert.deepEqual(policy.onAppend(ev(SessionEventType.ModelStreaming, "t1"), 0), []);
    assert.deepEqual(policy.onAppend(ev(SessionEventType.ModelComplete, "t1"), 0), []);
    assert.deepEqual(policy.onAppend(ev(SessionEventType.TurnComplete, "t1"), 0), []);
    // 仍在滞后窗口内：不淘汰。
    assert.deepEqual(policy.onAppend(ev(SessionEventType.SessionTitleUpdated, "t1"), 0), []);
    assert.deepEqual(policy.onAppend(ev(SessionEventType.TurnStarted, "t2"), 0), ["t1"]);
    assert.deepEqual(policy.onAppend(ev(SessionEventType.TurnError, "t2"), 0), []);
    assert.deepEqual(policy.onAppend(ev(SessionEventType.TurnStarted, "t3"), 0), ["t2"]);
  });

  it("RET-001 多个已结束 turn 一起淘汰；rewind 不触发淘汰；无 turnId 的事件不参与", () => {
    const policy = createSessionEventRetentionPolicy("turn-window");
    policy.onAppend(ev(SessionEventType.TurnStarted, "t1"), 0);
    policy.onAppend(ev(SessionEventType.TurnComplete, "t1"), 0);
    policy.onAppend(ev(SessionEventType.TurnStarted, "t2"), 0);
    policy.onAppend(ev(SessionEventType.TurnComplete, "t2"), 0);
    assert.deepEqual(policy.onAppend(ev(SessionEventType.RewindTriggered, "t2"), 0), []);
    assert.deepEqual(policy.onAppend(ev(SessionEventType.TurnStarted), 0), []);
    assert.deepEqual(policy.onAppend(ev(SessionEventType.TurnStarted, "t3"), 0), ["t2"]);
  });

  it("unbounded 永不淘汰", () => {
    const policy = createSessionEventRetentionPolicy("unbounded");
    policy.onAppend(ev(SessionEventType.TurnStarted, "t1"), 0);
    policy.onAppend(ev(SessionEventType.TurnComplete, "t1"), 0);
    assert.deepEqual(policy.onAppend(ev(SessionEventType.TurnStarted, "t2"), 0), []);
  });

  it("瞬态集合是与消息流同频的四类事件，且 reducer 不消费它们", () => {
    assert.deepEqual(
      [...TRANSIENT_SESSION_EVENT_TYPES].sort(),
      [
        SessionEventType.ModelStreaming,
        SessionEventType.ToolCallProgress,
        SessionEventType.StreamingToolLedgerUpdated,
        SessionEventType.ModelNetworkStatus,
      ].sort(),
    );
    assert.equal(isTransientSessionEvent({ type: SessionEventType.ModelStreaming }), true);
    assert.equal(isTransientSessionEvent({ type: SessionEventType.ModelComplete }), false);
  });
});

describe("session event retention policy · 时间兜底", () => {
  it("RET-008 sealed turn 超过 grace 且没有后继 turn 时由 collectExpired 交出；一次性 subagent 子 session 场景", () => {
    const policy = createSessionEventRetentionPolicy("turn-window");
    policy.onAppend(ev(SessionEventType.TurnStarted, "child"), 0);
    policy.onAppend(ev(SessionEventType.ModelStreaming, "child"), 1_000);
    policy.onAppend(ev(SessionEventType.TurnComplete, "child"), 10_000);
    assert.deepEqual(policy.collectExpired(60_000, 120_000), []);
    assert.deepEqual(policy.collectExpired(130_000, 120_000), ["child"]);
    // 交出后不再重复交出。
    assert.deepEqual(policy.collectExpired(200_000, 120_000), []);
  });

  it("RET-008 后继 turn 先到时按 turn 窗口淘汰，时间兜底不再重复", () => {
    const policy = createSessionEventRetentionPolicy("turn-window");
    policy.onAppend(ev(SessionEventType.TurnStarted, "t1"), 0);
    policy.onAppend(ev(SessionEventType.TurnComplete, "t1"), 5_000);
    assert.deepEqual(policy.onAppend(ev(SessionEventType.TurnStarted, "t2"), 6_000), ["t1"]);
    assert.deepEqual(policy.collectExpired(500_000, 120_000), []);
  });

  it("unbounded 的时间兜底恒为空", () => {
    const policy = createSessionEventRetentionPolicy("unbounded");
    policy.onAppend(ev(SessionEventType.TurnStarted, "t1"), 0);
    policy.onAppend(ev(SessionEventType.TurnComplete, "t1"), 1);
    assert.deepEqual(policy.collectExpired(1_000_000, 0), []);
  });
});
