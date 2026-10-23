import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import type { V4CommandCoreHost } from "../src/zcode-protocol-v4/commands/types.js";
import { V4InteractionRegistry } from "../src/zcode-protocol-v4/interaction-registry.js";
import { createGatewayEventForwarding } from "../src/zcode-protocol/v4-bridge-event-forwarding.js";
import { createCommandEntrySessionOps } from "../src/zcode-protocol/v4-bridge-session-ops.js";
import type {
  V4AutoDrainPort,
  V4BridgeBasePorts,
  V4StoredSummariesPort,
} from "../src/zcode-protocol/v4-bridge-shared.js";
import { mapSessionEvents } from "../src/zcode-protocol/session-mapper.js";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "../src/zcode-protocol/server-types.js";

/**
 * 旧 protocol 桥接层结构治理（见 `.agents/specs/lint-protocol-bridge.md`）。
 *
 * 提取只搬位置，不搬语义。这四条是拆分时最容易悄悄改坏的边界：
 * 1. 协议事件流的顺序与过滤（mapper 是纯派生，不能重排）；
 * 2. 同一 workspacePath 下不同 workspaceIdentity 的会话不能混桶；
 * 3. 会话关闭的顺序与 stale/重复关闭的幂等；
 * 4. 一次交互应答只有一个 owner 能写入（后到的应答按幂等 noop 收口）。
 */

let nextSequence = 1;

function event(
  type: SessionEvent["type"],
  payload: Record<string, unknown>,
  sessionId = "session-a",
): SessionEvent {
  return {
    id: `event-${nextSequence}` as SessionEvent["id"],
    sessionId: sessionId as SessionEvent["sessionId"],
    type,
    timestamp: new Date(1_000 + nextSequence),
    traceId: "trace-1" as SessionEvent["traceId"],
    sequenceNumber: nextSequence++,
    payload: payload as SessionEvent["payload"],
  };
}

function stubbedPorts(context: ZCodeProtocolAgentServerContext): V4BridgeBasePorts & {
  coreHost: V4CommandCoreHost;
  autoDrain: V4AutoDrainPort;
  summaries: V4StoredSummariesPort;
  getNativeExecutor(): never;
} {
  return {
    context,
    log: undefined,
    persistentCommands: {} as never,
    coreHost: { getRecord: () => undefined },
    autoDrain: {
      autoDrainV4QueueIfReady: async () => undefined,
      scheduleAutoDrainRetry: () => undefined,
    },
    summaries: { loadStoredSessionSummaries: async () => [] },
    getNativeExecutor: () => {
      throw new Error("native executor is not available in this test");
    },
  };
}

describe("protocol bridge 结构边界", () => {
  it("mapSessionEvents 保持输入顺序，只丢掉不该跨进程的内部事件", () => {
    const input: SessionEvent[] = [
      event(SessionEventType.TurnStarted, { inputId: "input-1" }),
      event(SessionEventType.StreamingToolLedgerUpdated, { ledger: "raw" }),
      event(SessionEventType.ModelStreaming, { kind: "text_delta", delta: "" }),
      event(SessionEventType.ModelStreaming, { kind: "text_delta", delta: "hi" }),
      event(SessionEventType.DynamicWorkflowRunProgress, { runId: "run-1" }),
      event(SessionEventType.TurnFinished, { inputId: "input-1" }),
    ];

    const mapped = mapSessionEvents(input);

    assert.deepEqual(
      mapped.map((item) => item.type),
      ["turn.started", "model.streaming", "session.updated"],
    );
    // 过滤后仍是稳定子序：保留项的相对顺序与输入一致。
    const keptIds = input
      .filter(
        (item) =>
          item.type !== SessionEventType.StreamingToolLedgerUpdated &&
          item.type !== SessionEventType.DynamicWorkflowRunProgress &&
          (item.type !== SessionEventType.ModelStreaming || item.payload.delta !== ""),
      )
      .map((item) => String(item.id));
    assert.deepEqual(
      mapped.map((item) => item.eventId),
      keptIds,
    );
    // 纯派生：输入数组不被改写。
    assert.equal(input.length, 6);
    assert.equal(String(input[1]!.id), "event-2");
  });

  it("同一 workspacePath 下不同 workspaceIdentity 的会话不混桶", () => {
    const workspacePath = "/tmp/shared-path";
    const record = (
      sessionId: string,
      workspaceIdentity: string,
      taskType: string,
    ): ZCodeProtocolSessionRecord =>
      ({
        app: { sessionId },
        createdAt: 1,
        updatedAt: 2,
        persistence: "immediate",
        taskType,
        workspace: { workspaceIdentity, workspaceKey: workspaceIdentity, workspacePath },
      }) as unknown as ZCodeProtocolSessionRecord;

    const sessions = new Map<string, ZCodeProtocolSessionRecord>([
      ["local-1", record("local-1", "local:one", "interactive")],
      ["remote-1", record("remote-1", "remote:ssh:box:/tmp/shared-path", "interactive")],
      ["child-1", record("child-1", "local:one", "subagent_child")],
    ]);
    const context = { sessions, deps: {} } as unknown as ZCodeProtocolAgentServerContext;
    const forwarding = createGatewayEventForwarding(stubbedPorts(context));

    assert.equal(forwarding.getSessionWorkspaceId("local-1"), "local:one");
    assert.equal(forwarding.getSessionWorkspaceId("remote-1"), "remote:ssh:box:/tmp/shared-path");
    // subagent child 不进任务列表桶，也不按路径回落到父 workspace。
    assert.equal(forwarding.getSessionWorkspaceId("child-1"), null);
    assert.deepEqual(forwarding.listWorkspaceSessionIds("local:one"), ["local-1"]);
    assert.deepEqual(forwarding.listWorkspaceSessionIds("remote:ssh:box:/tmp/shared-path"), [
      "remote-1",
    ]);
  });

  it("closeSession 先摘订阅再删注册表，stale 关闭是幂等 noop", async () => {
    const calls: string[] = [];
    const sessionId = "session-to-close";
    const record = {
      app: {
        close: async () => {
          calls.push("app.close");
        },
        sessionId,
      },
      unsubscribe: () => calls.push("unsubscribe"),
      workspace: { workspacePath: "/tmp/ws", workspaceKey: "/tmp/ws" },
    } as unknown as ZCodeProtocolSessionRecord;
    const sessions = new Map([[sessionId, record]]);
    const context = {
      deps: {},
      sessions,
      v4Gateway: {
        disposeSession: (id: string) => {
          // dispose 必须在注册表删除前拿到 record，否则 session.removed 推不出去。
          calls.push(`dispose:${sessions.has(id) ? "present" : "missing"}`);
        },
      },
    } as unknown as ZCodeProtocolAgentServerContext;
    const ops = createCommandEntrySessionOps({
      ...stubbedPorts(context),
      autoDrain: {
        autoDrainV4QueueIfReady: async () => undefined,
        scheduleAutoDrainRetry: () => undefined,
      },
    });

    await ops.closeSession?.(sessionId);

    assert.deepEqual(calls, ["unsubscribe", "app.close", "dispose:present"]);
    assert.equal(sessions.has(sessionId), false);

    // 并发竞态下重复关闭（stale run）：不抛、不重复 dispose。
    await ops.closeSession?.(sessionId);
    assert.deepEqual(calls, ["unsubscribe", "app.close", "dispose:present"]);
  });

  it("一次交互应答只有一个 owner：重复应答与 stale 注销都不生效", () => {
    const registry = new V4InteractionRegistry();
    const answers: string[] = [];
    const unregisterFirst = registry.register(
      "interaction-1",
      (answer) => answers.push(String(answer.optionId)),
      { kind: "other", sessionId: "session-a" },
    );

    assert.equal(registry.resolve("interaction-1", { optionId: "allowOnce" }), true);
    // 晚到的第二端应答：幂等 noop，不产生第二个 owner。
    assert.equal(registry.resolve("interaction-1", { optionId: "deny" }), false);
    assert.deepEqual(answers, ["allowOnce"]);

    // 旧登记（stale run 的 finally）不得注销重新注册的新等待者。
    unregisterFirst();
    const answersAfterReregister: string[] = [];
    registry.register(
      "interaction-1",
      (answer) => answersAfterReregister.push(String(answer.optionId)),
      { kind: "other", sessionId: "session-a" },
    );
    unregisterFirst();
    assert.equal(registry.resolve("interaction-1", { optionId: "allowOnce" }), true);
    assert.deepEqual(answersAfterReregister, ["allowOnce"]);
  });
});
