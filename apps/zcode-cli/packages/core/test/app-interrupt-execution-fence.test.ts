import assert from "node:assert/strict";
import { test } from "node:test";
import { stopActiveForegroundExecution } from "../src/runtime/methods/runtime-command-queue.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { ActiveForegroundExecutionState } from "../src/runtime/types.js";

/**
 * A7：App interrupt 的防误停依据必须由 runtime 的 active execution authority 原子比较，
 * 不能在 Host 侧只看 task meta。旧 execution 被新 run 取代时只能 mismatch，不能 abort 新 run。
 */
function runtimeWith(active: ActiveForegroundExecutionState) {
  return { activeForegroundExecution: active } as unknown as AgentRuntimeInternal;
}

function active(target: string): ActiveForegroundExecutionState {
  return {
    controller: new AbortController(),
    disposeParentAbort: () => undefined,
    foregroundExecutionId: target,
    preserveQueueAutoDrainOnCancel: false,
  };
}

test("旧 executionId 遇到新 run：mismatch 且不 abort 新执行", () => {
  const current = active("exec-new");
  const result = stopActiveForegroundExecution.call(runtimeWith(current), {
    expectedForegroundExecutionId: "exec-old",
    reason: "App interrupt",
  });
  assert.deepEqual(result, {
    kind: "mismatch",
    activeForegroundExecutionId: "exec-new",
  });
  assert.equal(current.controller.signal.aborted, false);
});

test("executionId 匹配：只停止目标 execution", () => {
  const current = active("exec-live");
  const result = stopActiveForegroundExecution.call(runtimeWith(current), {
    expectedForegroundExecutionId: "exec-live",
    reason: "App interrupt",
  });
  assert.deepEqual(result, { kind: "stopped", foregroundExecutionId: "exec-live" });
  assert.equal(current.controller.signal.aborted, true);
});

test("旧 execution 已结束：idle，不会误停后续 run", () => {
  const result = stopActiveForegroundExecution.call(
    { activeForegroundExecution: undefined } as unknown as AgentRuntimeInternal,
    { expectedForegroundExecutionId: "exec-old", reason: "App interrupt" },
  );
  assert.deepEqual(result, { kind: "idle" });
});
