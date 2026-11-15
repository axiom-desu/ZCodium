import assert from "node:assert/strict";
import { it } from "node:test";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { V4CommandExecutor } from "../src/zcode-protocol-v4/commands/executor.js";
import type {
  V4CommandCoreHost,
  V4SessionRecordView,
} from "../src/zcode-protocol-v4/commands/types.js";

// A7 真实停止 fence：App control 下发的 expectedExecutionId 必须原样进入 v4 stop，
// 由既有 CLI runtime 在同一 owner 内原子比较。旧 execution 已结束/被新 run 取代时
// handler 只能 noop(guard.stopTargetChanged)，不得停下调用方没看到的新执行。

function envelope(expectedForegroundExecutionId: string): CommandEnvelope {
  return {
    type: "stop",
    payload: { expectedForegroundExecutionId },
    sessionId: "s1",
    commandId: "cmd-stop",
    clientId: "client-test",
    issuedAt: 1,
  } as unknown as CommandEnvelope;
}

function record(runtimeStop: (options: unknown) => unknown): V4SessionRecordView {
  const app = {
    sessionId: "s1",
    runtime: { stopActiveForegroundExecution: runtimeStop },
    readTarget: async () => null,
    updateTargetStatus: async () => null,
  };
  return {
    app: app as unknown as V4SessionRecordView["app"],
    traceContext: {} as never,
    workspace: { workspacePath: "/tmp/a7-fence" },
    persistence: "immediate",
  };
}

function host(recordValue: V4SessionRecordView): V4CommandCoreHost {
  return {
    getRecord: (id) => (id === "s1" ? recordValue : undefined),
    getQueueLength: () => 0,
    waitForProjectionEventCommit: async () => {},
  } as unknown as V4CommandCoreHost;
}

it("旧 execution 被新 run 取代：stop noop(guard.stopTargetChanged)，不误停新执行", async () => {
  const calls: unknown[] = [];
  const recordValue = record((options) => {
    calls.push(options);
    return { kind: "mismatch", activeForegroundExecutionId: "exec-new" };
  });
  const executor = new V4CommandExecutor(host(recordValue));
  await assert.rejects(
    executor.execute(envelope("exec-old")),
    (error: { reasonCode?: string }) => error.reasonCode === "guard.stopTargetChanged",
  );
  assert.deepEqual(calls, [
    { expectedForegroundExecutionId: "exec-old", reason: "v4 session stopped" },
  ]);
});

it("executionId 完全匹配：只停止目标 execution", async () => {
  const calls: unknown[] = [];
  const recordValue = record((options) => {
    calls.push(options);
    return { kind: "stopped", foregroundExecutionId: "exec-live" };
  });
  const executor = new V4CommandExecutor(host(recordValue));
  await executor.execute(envelope("exec-live"));
  assert.deepEqual(calls, [
    { expectedForegroundExecutionId: "exec-live", reason: "v4 session stopped" },
  ]);
});
