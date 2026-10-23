import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SessionEventType, type SessionEvent } from "@zcode/contracts";

import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";
import {
  cloneProjectionState,
  createProjectionState,
  type ProjectionState,
} from "../src/zcode-protocol-v4/product-projection-state.js";
import { createInitialConversationSnapshot } from "../src/zcode-protocol-v4/projection-state.js";

let eventCounter = 0;

function event(
  type: SessionEventType,
  payload: unknown,
  options: { turnId?: string; sequenceNumber?: number } = {},
): SessionEvent {
  eventCounter += 1;
  return {
    id: `evt_state_${eventCounter}`,
    sessionId: "session_state",
    ...(options.turnId ? { turnId: options.turnId } : {}),
    type,
    timestamp: new Date(1_000 + eventCounter),
    traceId: "trace_state",
    sequenceNumber: options.sequenceNumber ?? eventCounter,
    payload,
  } as SessionEvent;
}

function initialState(): ProjectionState {
  return createProjectionState(createInitialConversationSnapshot("session_state", "epoch"));
}

function isMutableContainer(value: unknown): boolean {
  return value instanceof Map || value instanceof Set;
}

describe("ProjectionState clone/adopt atomicity", () => {
  it("clones every declared side index and never shares a mutable container", () => {
    const state = initialState();
    // 侧表全部填充一次，避免空容器掩盖“忘拷贝该字段”。
    state.rowIndexById.set(1, 0);
    state.toolRowIdByCallId.set("tool_1", 1);
    state.latestListAppsSnapshot.set(1, { appId: "app_1" } as never);
    state.openForegroundToolCallIds.add("tool_1");
    state.fileToolInputPreviewByCallId.set("tool_1", {
      lastPublishedAt: 1,
      pendingAppend: "{}",
    });
    state.subagentRowIdByAgentId.set("agent_1", 2);
    state.hookRowIdByInvocationId.set("hook_1", 3);
    state.pendingSessionHookInvocations.set("hook_1", {
      firstEvent: event(SessionEventType.SessionCreated, {}),
      content: {
        invocationId: "hook_1",
        hookId: "hook",
        event: "SessionStart",
        lane: "session",
        executions: [],
      } as never,
    });
    state.rewoundHookInvocationIds.add("hook_1");
    state.invalidSubagentChildSessionIds.add("child_1");
    state.messageIdByRowId.set(1, "msg_1");
    state.outputContinuationRowIdByMessageId.set("msg_1", 1);
    state.entityIdByRowId.set(1, "entity_1");
    state.editTargetByEntityId.set("entity_1", { entityId: "entity_1" } as never);
    state.turnHeaderRowIdByTurnId.set("turn_1", 1);
    state.compactMarkerRowIdByOperationId.set("op_1", 1);
    state.goalVerifyMarkerRowIdByLifecycleKey.set("target_1", 1);
    state.productTurnIdByRuntimeTurnId.set("turn_1", "product_1");
    state.runtimeTurnIdByProductTurnId.set("product_1", "turn_1");
    state.productTurnSplitOrdinalByRuntimeTurnId.set("turn_1", 1);
    state.deliveryByPendingInputId.set("input_1", "queue");
    state.normalizationDiagnostics.push({ code: "diag", detail: "kept" } as never);

    const clone = cloneProjectionState(state);

    assert.deepEqual(
      Object.keys(clone).sort(),
      Object.keys(state).sort(),
      "cloneProjectionState 必须覆盖 ProjectionState 的全部字段",
    );
    for (const [key, value] of Object.entries(state)) {
      if (key === "hydrationAccumulator") continue;
      if (isMutableContainer(value)) {
        const cloned = (clone as unknown as Record<string, unknown>)[key];
        assert.notEqual(cloned, value, `${key} 必须是独立容器`);
        assert.deepEqual(cloned, value, `${key} 内容必须与源一致`);
        continue;
      }
      if (Array.isArray(value)) {
        const cloned = (clone as unknown as Record<string, unknown>)[key];
        assert.notEqual(cloned, value, `${key} 必须是独立数组`);
        assert.deepEqual(cloned, value, `${key} 内容必须与源一致`);
        continue;
      }
      if (typeof value === "object" && value !== null && key !== "snapshot") {
        assert.notEqual(
          (clone as unknown as Record<string, unknown>)[key],
          value,
          `${key} 必须是独立对象`,
        );
      }
    }
    // 候选 clone 不得带入 hydration 累加器：候选永远走不可变 apply。
    assert.equal(clone.hydrationAccumulator, null);

    // 写入隔离：clone 的侧表改动不能回写源状态。
    clone.toolRowIdByCallId.set("tool_2", 9);
    clone.openForegroundToolCallIds.add("tool_2");
    clone.fileToolInputPreviewByCallId.get("tool_1")!.pendingAppend = "changed";
    clone.pendingSessionHookInvocations.get("hook_1")!.content.executions.push({
      executionId: "exec_1",
    } as never);
    assert.equal(state.toolRowIdByCallId.has("tool_2"), false);
    assert.equal(state.openForegroundToolCallIds.has("tool_2"), false);
    assert.equal(state.fileToolInputPreviewByCallId.get("tool_1")!.pendingAppend, "{}");
    assert.equal(state.pendingSessionHookInvocations.get("hook_1")!.content.executions.length, 0);
  });

  it("rejects a candidate without touching the committed state", () => {
    const projection = new ProductProjection("session_state", "epoch");
    projection.applyEvent(
      event(
        SessionEventType.TurnStarted,
        { turnNumber: 1, input: "hello", messageId: "msg_user_1" },
        { turnId: "turn_1" },
      ),
    );
    const committed = projection.getSnapshot();
    const committedRowIds = committed.rows.window.map((row) => row.rowId);
    const committedEntityIds = committedRowIds.map((rowId) => projection.getEntityIdForRow(rowId));
    const nextEvent = event(
      SessionEventType.TurnComplete,
      { resultType: "success" },
      { turnId: "turn_1" },
    );

    const rejected = projection.applyEventAtomically(nextEvent, () => false);

    assert.equal(rejected, null);
    assert.equal(projection.getSnapshot(), committed);
    assert.deepEqual(
      projection.getSnapshot().rows.window.map((row) => row.rowId),
      committedRowIds,
    );
    // 侧表（entity/row 索引）同样未被候选提交污染。
    assert.deepEqual(
      committedRowIds.map((rowId) => projection.getEntityIdForRow(rowId)),
      committedEntityIds,
    );

    // 拒绝后同一事件仍可正常归约（candidate 未污染 owner）。
    const accepted = projection.applyEventAtomically(nextEvent, () => true);
    assert.notEqual(accepted, null);
    assert.notEqual(projection.getSnapshot(), committed);
    assert.equal(projection.getSnapshot().seq, nextEvent.sequenceNumber);
  });

  it("discards the candidate when the accept callback throws", () => {
    const projection = new ProductProjection("session_state", "epoch");
    projection.applyEvent(
      event(
        SessionEventType.TurnStarted,
        { turnNumber: 1, input: "hello", messageId: "msg_user_1" },
        { turnId: "turn_1" },
      ),
    );
    const committed = projection.getSnapshot();

    assert.throws(
      () =>
        projection.applyEventAtomically(
          event(SessionEventType.TurnComplete, { resultType: "success" }, { turnId: "turn_1" }),
          () => {
            throw new Error("wire.encode.tooLarge");
          },
        ),
      /wire\.encode\.tooLarge/,
    );
    assert.equal(projection.getSnapshot(), committed);
  });
});
