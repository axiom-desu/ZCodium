// 后台子代理停滞：registry 活动派生、钟的 one-shot/加倍、取消与出队失效判定（上游 3.18.2，C7 片）。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/registry.js";
import type { RuntimeTaskSnapshot } from "../src/runtime-task/registry.js";
import {
  BackgroundSubagentStallClock,
  isBackgroundSubagentStallReminderCurrent,
  noteSubagentActivity,
  type BackgroundSubagentStallReminder,
} from "../src/subagent/background-stall.js";

function childEvent(type: SessionEventType, payload: Record<string, unknown>): SessionEvent {
  return { type, payload } as unknown as SessionEvent;
}

function runningTask(overrides: Partial<RuntimeTaskSnapshot> = {}): RuntimeTaskSnapshot {
  return {
    agentId: "agent_solver",
    agentType: "general-purpose",
    branchGeneration: 0,
    description: "fix the failing test",
    isBackgrounded: true,
    parentSessionId: "parent",
    startedAt: new Date(0),
    status: "running",
    taskId: "agent_solver",
    type: "local_agent",
    ...overrides,
  };
}

describe("noteSubagentActivity", () => {
  it("只把进展事件写进 registry：模型请求、工具开始/结束、审批等待", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    registry.register(runningTask());
    noteSubagentActivity(registry, "agent_solver", childEvent(SessionEventType.ModelRequest, {}), 1);
    assert.equal(registry.get("agent_solver")?.activity?.lastProgressAt, 1);

    noteSubagentActivity(
      registry,
      "agent_solver",
      childEvent(SessionEventType.ToolCallStarted, {
        toolCallId: "call-1",
        toolName: "Bash",
      }),
      2,
    );
    const activity = registry.get("agent_solver")?.activity;
    assert.deepEqual(
      activity?.runningTools.map((tool) => [tool.toolCallId, tool.startedAt]),
      [["call-1", 2]],
    );

    noteSubagentActivity(
      registry,
      "agent_solver",
      childEvent(SessionEventType.PermissionRequested, {
        requestId: "req-1",
        toolCallId: "call-1",
      }),
      3,
    );
    assert.equal(registry.get("agent_solver")?.activity?.waitingForPermission, true);

    noteSubagentActivity(
      registry,
      "agent_solver",
      childEvent(SessionEventType.ToolCallResult, { toolCallId: "call-1" }),
      4,
    );
    const settled = registry.get("agent_solver")?.activity;
    assert.equal(settled?.waitingForPermission, false);
    assert.deepEqual(settled?.runningTools, []);
    assert.equal(settled?.lastProgressAt, 4);
  });

  it("终态之后的迟到事件不改写快照；非进展事件不写", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    registry.register(runningTask());
    noteSubagentActivity(registry, "agent_solver", childEvent(SessionEventType.ModelRequest, {}), 1);
    registry.update("agent_solver", (task) => ({ ...task, status: "completed" }));
    const before = registry.get("agent_solver");
    noteSubagentActivity(
      registry,
      "agent_solver",
      childEvent(SessionEventType.ToolCallStarted, { toolCallId: "late", toolName: "Read" }),
      9,
    );
    assert.deepEqual(registry.get("agent_solver"), before);
  });
});

describe("BackgroundSubagentStallClock", () => {
  function fakeHost(tasks: RuntimeTaskSnapshot[]) {
    let now = 0;
    let timer: { callback: () => void; dueAt: number } | undefined;
    const reminders: BackgroundSubagentStallReminder[] = [];
    return {
      host: {
        now: () => now,
        liveAgents: () => tasks,
        remind: (reminder: BackgroundSubagentStallReminder) => reminders.push(reminder),
        setTimer: (callback: () => void, delayMs: number) => {
          timer = { callback, dueAt: now + delayMs };
          return () => {
            timer = undefined;
          };
        },
      },
      reminders,
      advance(ms: number) {
        now += ms;
        if (timer && timer.dueAt <= now) {
          const due = timer;
          timer = undefined;
          due.callback();
        }
      },
    };
  }

  it("一次到期只提醒一次，下一次间隔加倍；取消后不再提醒", () => {
    const tasks = [runningTask()];
    const harness = fakeHost(tasks);
    const clock = new BackgroundSubagentStallClock(harness.host, {
      firstAfterMs: 1_000,
      maxIntervalMs: 10_000,
    });
    clock.reconcile();
    // 未到期不提醒。
    harness.advance(999);
    assert.equal(harness.reminders.length, 0);
    harness.advance(1);
    assert.equal(harness.reminders.length, 1);
    assert.equal(harness.reminders[0]?.ordinal, 1);
    assert.equal(harness.reminders[0]?.nextReportInMs, 2_000);
    assert.equal(harness.reminders[0]?.description, "fix the failing test");

    // one-shot：没有新的 reconcile 不会因为同一个到期再提醒一次。
    harness.advance(1_999);
    assert.equal(harness.reminders.length, 1);
    // 第二次到期：ordinal 递增、间隔继续加倍（1s → 2s → 4s）。
    harness.advance(1);
    assert.equal(harness.reminders.length, 2);
    assert.equal(harness.reminders[1]?.ordinal, 2);
    assert.equal(harness.reminders[1]?.nextReportInMs, 4_000);

    // 任务结束（取消 / 终态）：state 被摘除，不再排定时器。
    tasks.splice(0, 1);
    clock.reconcile();
    harness.advance(60_000);
    assert.equal(harness.reminders.length, 2);

    // dispose 后即使 registry 未变也不再提醒。
    clock.dispose();
  });

  it("在等用户审批时不算停滞；有新进展后计数清零", () => {
    const tasks = [runningTask()];
    const harness = fakeHost(tasks);
    const clock = new BackgroundSubagentStallClock(harness.host, { firstAfterMs: 1_000 });
    tasks[0] = runningTask({
      activity: { lastProgressAt: 0, runningTools: [], waitingForPermission: true },
    });
    clock.reconcile();
    harness.advance(10_000);
    assert.equal(harness.reminders.length, 0);

    // 审批结束、有新进展：从新进展重新计时（假钟当前时刻是 10_000）。
    tasks[0] = runningTask({
      activity: { lastProgressAt: 10_000, runningTools: [], waitingForPermission: false },
    });
    clock.reconcile();
    harness.advance(999);
    assert.equal(harness.reminders.length, 0);
    harness.advance(1);
    assert.equal(harness.reminders.length, 1);
    clock.dispose();
  });
});

describe("isBackgroundSubagentStallReminderCurrent", () => {
  it("Agent 结束、有新进展、在等审批 → 提醒已过时", () => {
    const current = runningTask({
      activity: { lastProgressAt: 100, runningTools: [], waitingForPermission: false },
    });
    assert.equal(isBackgroundSubagentStallReminderCurrent(current, { lastProgressAt: 100 }), true);
    assert.equal(
      isBackgroundSubagentStallReminderCurrent({ ...current, status: "completed" }, {}),
      false,
    );
    assert.equal(isBackgroundSubagentStallReminderCurrent(undefined, {}), false);
    assert.equal(
      isBackgroundSubagentStallReminderCurrent(current, { lastProgressAt: 200 }),
      false,
    );
    assert.equal(
      isBackgroundSubagentStallReminderCurrent(
        {
          ...current,
          activity: { lastProgressAt: 100, runningTools: [], waitingForPermission: true },
        },
        { lastProgressAt: 100 },
      ),
      false,
    );
  });
});
