import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SessionEventType, type SessionEvent } from "@zcode/contracts";

import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";

let eventCounter = 0;

function event(
  type: SessionEventType,
  payload: unknown,
  options: { turnId?: string; sequenceNumber?: number } = {},
): SessionEvent {
  eventCounter += 1;
  return {
    id: `evt_${eventCounter}`,
    sessionId: "session_projection",
    ...(options.turnId ? { turnId: options.turnId } : {}),
    type,
    timestamp: new Date(1_000 + eventCounter),
    traceId: "trace_projection",
    sequenceNumber: options.sequenceNumber ?? eventCounter,
    payload,
  } as SessionEvent;
}

function startedProjection(): ProductProjection {
  const projection = new ProductProjection("session_projection", "epoch");
  projection.applyEvent(
    event(
      SessionEventType.TurnStarted,
      { turnNumber: 1, input: "hello", messageId: "msg_user_1" },
      { turnId: "turn_1" },
    ),
  );
  return projection;
}

describe("ProductProjection public projection contract", () => {
  it("keeps draft snapshot and seedConfig non-visible until an event arrives", () => {
    const projection = new ProductProjection("session_projection", "epoch");
    const initial = projection.getSnapshot();

    assert.equal(initial.sessionId, "session_projection");
    assert.equal(initial.logEpoch, "epoch");
    assert.equal(initial.seq, 0);
    assert.equal(initial.revision, 0);
    assert.equal(initial.control.phase, "draft");
    assert.equal(projection.getSnapshot(), initial);

    projection.seedConfig({ provider: "provider_a", model: "model_a", mode: "build" });

    const seeded = projection.getSnapshot();
    assert.equal(seeded.config.provider, "provider_a");
    assert.equal(seeded.config.model, "model_a");
    assert.equal(seeded.revision, 0);
    assert.equal(seeded.seq, 0);
    assert.deepEqual(seeded.rows.window, []);
  });

  it("applies session/turn events in order and preserves the event sequence on the snapshot", () => {
    const projection = new ProductProjection("session_projection", "epoch");

    assert.deepEqual(
      projection.applyEvent(
        event(SessionEventType.SessionCreated, {
          planEnabled: false,
          mode: "build",
          contextWindow: 1_000,
        }),
      ),
      [],
    );
    const deltas = projection.applyEvent(
      event(
        SessionEventType.TurnStarted,
        { turnNumber: 1, input: "hello", messageId: "msg_user_1" },
        { turnId: "turn_1" },
      ),
    );

    assert.deepEqual(
      deltas.map((delta) => delta.op),
      ["row.appended", "row.appended", "state.updated", "row.upserted", "state.updated"],
    );
    const snapshot = projection.getSnapshot();
    assert.equal(snapshot.seq, 2);
    assert.equal(snapshot.control.phase, "running");
    assert.deepEqual(
      snapshot.rows.window.map((row) => row.kind),
      ["turnHeader", "userInput"],
    );
    assert.equal(projection.getMessageIdForRow(2), "msg_user_1");
    assert.equal(projection.getTurnIdForRow(1), "msg_user_1");
  });

  it("keeps queue admission order and autoDrain state on the owner snapshot", () => {
    const projection = startedProjection();

    projection.applyEvent(
      event(
        SessionEventType.TurnSteerQueued,
        {
          pendingInputId: "queue_1",
          input: "queued input",
          inputPreview: "queued input",
          inputSize: 12,
          targetTurnId: "turn_1",
          queueLength: 1,
          intent: {
            queueItemId: "queue_1",
            requestedDelivery: "queue",
            admittedDelivery: "queue",
          },
        },
        { turnId: "turn_1", sequenceNumber: 20 },
      ),
    );
    projection.applyEvent(
      event(SessionEventType.QueueAutoDrainChanged, { autoDrain: false }, { turnId: "turn_1" }),
    );

    const snapshot = projection.getSnapshot();
    assert.equal(snapshot.queue.autoDrain, false);
    assert.equal(snapshot.queue.items.length, 1);
    assert.equal(snapshot.queue.items[0]?.queueItemId, "queue_1");
    assert.deepEqual(snapshot.queue.items[0]?.delivery, {
      requested: "queue",
      admitted: "queue",
    });
    assert.deepEqual(snapshot.queue.items[0]?.order, {
      admissionSeq: 20,
      queuePosition: 0,
    });
  });

  it("keeps permission interaction and tool-row approval state linked", () => {
    const projection = startedProjection();
    projection.applyEvent(
      event(
        SessionEventType.ToolCallScheduled,
        { toolCallId: "tool_1", toolName: "Bash", input: { command: "ls" } },
        { turnId: "turn_1" },
      ),
    );
    projection.applyEvent(
      event(
        SessionEventType.PermissionRequested,
        {
          toolCallId: "tool_1",
          toolName: "Bash",
          riskLevel: "medium",
          reason: "needs approval",
          input: { command: "ls" },
        },
        { turnId: "turn_1" },
      ),
    );

    const pending = projection.getSnapshot().pendingInteractions;
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.interactionId, "perm-tool_1");
    assert.equal(pending[0]?.kind, "permission");
    assert.equal(pending[0]?.anchorRowId, 3);
    assert.equal(
      projection.getSnapshot().rows.window.find((row) => row.kind === "toolCall")?.status,
      "pendingApproval",
    );

    projection.applyEvent(
      event(
        SessionEventType.PermissionResolved,
        { toolCallId: "tool_1", decision: "allow" },
        { turnId: "turn_1" },
      ),
    );
    assert.deepEqual(projection.getSnapshot().pendingInteractions, []);
    assert.equal(
      projection.getSnapshot().rows.window.find((row) => row.kind === "toolCall")?.status,
      "running",
    );
  });

  it("upserts the same compact marker by operationId and updates activeWorks", () => {
    const projection = startedProjection();
    projection.applyEvent(
      event(
        SessionEventType.CompactStarted,
        { operationId: "compact_1", trigger: "manual", status: "started" },
        { turnId: "turn_1" },
      ),
    );

    let markers = projection
      .getSnapshot()
      .rows.window.filter((row) => row.kind === "timelineMarker");
    assert.equal(markers.length, 1);
    assert.deepEqual(markers[0]?.marker, {
      type: "compact",
      origin: "manual",
      status: "running",
    });
    assert.equal(
      projection.getSnapshot().control.activeWorks.some((work) => work.kind === "compact"),
      true,
    );

    projection.applyEvent(
      event(
        SessionEventType.CompactCompleted,
        { operationId: "compact_1", trigger: "manual", status: "completed" },
        { turnId: "turn_1" },
      ),
    );
    markers = projection.getSnapshot().rows.window.filter((row) => row.kind === "timelineMarker");
    assert.equal(markers.length, 1);
    assert.equal(markers[0]?.rowId, 3);
    assert.deepEqual(markers[0]?.marker, {
      type: "compact",
      origin: "manual",
      status: "success",
    });
    assert.equal(
      projection.getSnapshot().control.activeWorks.some((work) => work.kind === "compact"),
      false,
    );
  });

  it("keeps hydration replay additive and ends at the last event sequence", () => {
    const projection = new ProductProjection("session_projection", "epoch");
    assert.throws(
      () => projection.applyHydrationEvent(event(SessionEventType.SessionCreated, {})),
      {
        message: "hydration replay is not active",
      },
    );

    projection.beginHydrationReplay();
    assert.throws(() => projection.beginHydrationReplay(), {
      message: "hydration replay already active",
    });
    projection.applyHydrationEvent(
      event(
        SessionEventType.TurnStarted,
        { turnNumber: 1, input: "hello", messageId: "msg_user_1" },
        { turnId: "turn_1", sequenceNumber: 10 },
      ),
    );
    projection.applyHydrationEvent(
      event(
        SessionEventType.ModelStreaming,
        {
          kind: "text_start",
          delta: "",
          done: false,
          assistantMessageId: "msg_assistant_1",
          partId: "part_1",
        },
        { turnId: "turn_1", sequenceNumber: 11 },
      ),
    );

    assert.equal(projection.getSnapshot().seq, 11);
    const finalDeltas = projection.completeHydrationReplay();
    assert.equal(
      finalDeltas.every((delta) => delta.op === "row.upserted"),
      true,
    );
    assert.equal(projection.getSnapshot().seq, 11);
    assert.equal(projection.getSnapshot().rows.window.length, 3);
  });
});
