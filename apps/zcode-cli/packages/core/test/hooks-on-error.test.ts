// ============================================================
// F15 Hook `onError`：hook 自身出错时的 allow / deny 语义
// ============================================================
// 不变式：
//   1. 缺省（无 onError）= allow，与引入本字段之前完全一致（fail-open）；
//   2. `deny` 只在 PreToolUse 上、且 hook 真的运行过并失败时把这次调用拦下，形状与退出码 2 的拦截同形；
//   3. 用户中断（cancelled）不算失败，不会被当成策略拒绝；
//   4. 非 PreToolUse 事件即便配了 deny 也不改变结果形状。

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CoreErrorType,
  HookEventName,
  HookOutcome,
  SessionEventType,
  createCoreError,
  type HookInput,
  type PreToolUseHookInput,
  type SessionEvent,
} from "@zcode/contracts";

import { createHookCancelledError } from "../src/hooks/runner-helpers.js";
import { createInMemoryHookRunner } from "../src/hooks/runner.js";
import type { HookRegistration } from "../src/hooks/types.js";

const PRE_TOOL_USE_INPUT: PreToolUseHookInput = {
  cwd: "/tmp/workspace",
  hookEventName: HookEventName.PreToolUse,
  mode: "build",
  riskLevel: "low",
  sessionId: "s1" as PreToolUseHookInput["sessionId"],
  timestamp: new Date(0).toISOString(),
  toolCallId: "call_1",
  toolInput: { command: "ls" },
  toolName: "Bash",
  traceId: "t1" as PreToolUseHookInput["traceId"],
};

function hookThatThrows(onError?: HookRegistration["onError"]): HookRegistration {
  return {
    callback: () => {
      throw new Error("hook script crashed");
    },
    event: HookEventName.PreToolUse,
    ...(onError === undefined ? {} : { onError }),
    source: "user",
  };
}

async function runHook(hook: HookRegistration, input: HookInput = PRE_TOOL_USE_INPUT) {
  const events: SessionEvent[] = [];
  const runner = createInMemoryHookRunner({
    emitEvent: async (event) => {
      events.push(event);
    },
    hooks: [hook],
  });
  const result = await runner.run(input);
  // 终态事件：started 之外的那一条（每个 hook 至多一次终态）。
  const terminal = events.filter((event) => event.type !== SessionEventType.HookRunStarted);
  return { events: terminal, result };
}

describe("hook onError", () => {
  it("缺省放行：失败只发 HookRunFailed，不改变权限结果", async () => {
    const { events, result } = await runHook(hookThatThrows());
    assert.equal(result.permissionBehavior, undefined);
    assert.equal(result.blockRequested, undefined);
    assert.deepEqual(result.additionalContexts, []);
    assert.equal(events[0]?.type, SessionEventType.HookRunFailed);
  });

  it("allow 显式声明与缺省同形", async () => {
    const { events, result } = await runHook(hookThatThrows("allow"));
    assert.equal(result.permissionBehavior, undefined);
    assert.equal(events[0]?.type, SessionEventType.HookRunFailed);
  });

  it("deny 把 PreToolUse 失败变成同形的拦截", async () => {
    const { events, result } = await runHook(hookThatThrows("deny"));
    assert.equal(result.permissionBehavior, "deny");
    assert.equal(result.blockRequested, true);
    assert.ok((result.stopReason ?? "").includes("onError"));
    assert.equal(events[0]?.type, SessionEventType.HookRunBlocked);
    const payload = events[0]?.payload as { blockReason?: string; outcome?: string } | undefined;
    assert.equal(payload?.outcome, HookOutcome.Blocked);
    assert.ok((payload?.blockReason ?? "").includes("hook script crashed"));
  });

  it("deny 对非 PreToolUse 事件不生效", async () => {
    const stopInput: HookInput = {
      ...PRE_TOOL_USE_INPUT,
      hookEventName: HookEventName.Stop,
    } as unknown as HookInput;
    const hook: HookRegistration = {
      callback: () => {
        throw new Error("boom");
      },
      event: HookEventName.Stop,
      onError: "deny",
    };
    const { events, result } = await runHook(hook, stopInput);
    assert.equal(result.blockRequested, undefined);
    assert.equal(events[0]?.type, SessionEventType.HookRunFailed);
  });

  it("用户中断不算失败，deny 不把取消变成策略拒绝", async () => {
    const hook: HookRegistration = {
      callback: () => {
        throw createHookCancelledError();
      },
      event: HookEventName.PreToolUse,
      onError: "deny",
    };
    const { events, result } = await runHook(hook);
    assert.equal(result.permissionBehavior, undefined);
    assert.equal(events[0]?.type, SessionEventType.HookRunFailed);
    const payload = events[0]?.payload as { outcome?: string } | undefined;
    assert.equal(payload?.outcome, HookOutcome.Cancelled);
  });

  it("失败语义不影响其它健康 hook 的放行", async () => {
    const events: SessionEvent[] = [];
    const runner = createInMemoryHookRunner({
      emitEvent: async (event) => {
        events.push(event);
      },
      hooks: [
        {
          callback: () => ({ hookSpecificOutput: { hookEventName: HookEventName.PreToolUse } }),
          event: HookEventName.PreToolUse,
        },
        {
          callback: () => {
            throw createCoreError(CoreErrorType.ToolExecutionFailed, "timed out");
          },
          event: HookEventName.PreToolUse,
          onError: "deny",
        },
      ],
    });
    const result = await runner.run(PRE_TOOL_USE_INPUT);
    assert.equal(result.permissionBehavior, "deny");
    const terminal = events.filter((event) => event.type !== SessionEventType.HookRunStarted);
    assert.deepEqual(
      terminal.map((event) => event.type),
      [SessionEventType.HookRunCompleted, SessionEventType.HookRunBlocked],
    );
  });
});
