import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEvent } from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import { CommandInbox } from "../src/zcode-protocol-v4/command-inbox.js";
import { mergeColdConversationEvents } from "../src/zcode-protocol-v4/cold-event-merge.js";
import { ConversationTelemetryFactNormalizer } from "../src/zcode-protocol-v4/conversation-telemetry-facts.js";
import { ConversationTopicPublisher } from "../src/zcode-protocol-v4/conversation-topic-publisher.js";
// executor 必须先于 handler 加载：goal-compact 经 input-intent 回到 executor，
// 直接以 handler 为入口会触发 index 注册表的 TDZ。
import "../src/zcode-protocol-v4/commands/executor.js";
import {
  startManualCompact,
  V4GoalCompactRejectedError,
} from "../src/zcode-protocol-v4/commands/handlers/goal-compact.js";
import type {
  V4CommandCoreHost,
  V4SessionRecordView,
} from "../src/zcode-protocol-v4/commands/types.js";

function envelope(commandId: string, sessionId: string, text = "hello") {
  return {
    commandId,
    clientId: "test",
    sessionId,
    type: "sendText" as const,
    payload: { text },
    issuedAt: 1,
  };
}

function event(
  type: SessionEvent["type"],
  payload: unknown,
  overrides: Partial<SessionEvent> = {},
): SessionEvent {
  return {
    id: overrides.id ?? (`event-${type}` as SessionEvent["id"]),
    sessionId: (overrides.sessionId ?? "session") as SessionEvent["sessionId"],
    ...(overrides.turnId ? { turnId: overrides.turnId } : {}),
    type,
    timestamp: overrides.timestamp ?? new Date(1),
    traceId: (overrides.traceId ?? "trace") as SessionEvent["traceId"],
    sequenceNumber: overrides.sequenceNumber ?? 1,
    payload,
  };
}

test("CommandInbox shares one final for in-flight key and serializes session admission", async () => {
  const admitted: string[] = [];
  const inbox = new CommandInbox({
    getRevision: () => 7,
    getLogEpoch: () => "epoch",
  });
  const first = await inbox.handle(envelope("cmd-1", "session"));
  assert.equal(first.kind, "execute");
  if (first.kind !== "execute") return;
  admitted.push(first.envelope.commandId);

  const duplicate = inbox.handle(envelope("cmd-1", "session")).then((outcome) => {
    admitted.push("duplicate");
    return outcome;
  });
  const second = inbox.handle(envelope("cmd-2", "session")).then((outcome) => {
    admitted.push("second");
    return outcome;
  });

  await Promise.resolve();
  assert.deepEqual(admitted, ["cmd-1"]);

  first.settle({ status: "accepted", revisionAtDecision: 7 });
  const duplicateOutcome = await duplicate;
  const secondOutcome = await second;
  assert.equal(duplicateOutcome.kind, "ack");
  assert.equal(duplicateOutcome.kind === "ack" && duplicateOutcome.ack.status, "duplicate");
  assert.equal(secondOutcome.kind, "execute");
  if (secondOutcome.kind === "execute") {
    assert.equal(secondOutcome.admissionSeq, 2);
    secondOutcome.settle({ status: "accepted", revisionAtDecision: 7 });
  }
  assert.deepEqual(admitted, ["cmd-1", "duplicate", "second"]);
});

test("CommandInbox keeps stale revision and log epoch decisions ahead of execute", async () => {
  const inbox = new CommandInbox({
    getRevision: () => 3,
    getLogEpoch: () => "epoch-new",
  });
  const staleRevision = await inbox.handle({
    ...envelope("cmd-stale", "session"),
    baseRevision: 2,
    baseLogEpoch: "epoch-new",
    payload: { queueItemId: "queue-1", newText: "hello" },
    type: "editQueueItem",
  });
  assert.equal(staleRevision.kind, "ack");
  assert.equal(staleRevision.kind === "ack" && staleRevision.ack.reasonCode, "proto.staleRevision");

  const staleEpoch = await inbox.handle({
    ...envelope("cmd-epoch", "session"),
    baseRevision: 3,
    baseLogEpoch: "epoch-old",
    type: "retryTurn",
    payload: { target: { rowId: 1, entityId: "row-1" } },
  });
  assert.equal(staleEpoch.kind, "ack");
  assert.equal(staleEpoch.kind === "ack" && staleEpoch.ack.reasonCode, "proto.staleLogEpoch");
});

test("cold merge preserves target authority, queue settlement and unknown-event ordering", () => {
  const merged = mergeColdConversationEvents({
    sessionId: "session",
    memoryEvents: [
      event(SessionEventType.TargetChanged, { action: "set", target: { objective: "old" } }),
      event(SessionEventType.TurnSteerQueued, { pendingInputId: "queue-1" }),
      event(SessionEventType.TurnSteerDrained, { pendingInputIds: ["queue-1"] }),
      event(SessionEventType.PermissionRequested, { toolCallId: "tool-1" }),
      event(SessionEventType.PluginUiResourceUpdated, { uri: "plugin://panel" }),
      event("future_event" as SessionEvent["type"], { value: true }),
    ],
    messages: [],
    target: null,
  });

  assert.deepEqual(
    merged.events.map((item) => item.type),
    ["session_created", "permission_requested", "future_event"],
  );
  assert.deepEqual(
    merged.events.map((item) => item.sequenceNumber),
    [1, 2, 3],
  );
  assert.deepEqual(
    Object.fromEntries(merged.diagnostics.map((diagnostic) => [diagnostic.code, diagnostic.count])),
    {
      "cold_merge.settled_queue_event_suppressed": 2,
      "cold_merge.durable_event_suppressed": 1,
      "cold_merge.non_product_event_suppressed": 1,
      "cold_merge.unclassified_event_preserved": 1,
    },
  );
  assert.equal(merged.usedDurableTranscript, true);
});

test("telemetry carries admission source through the turn then clears it", () => {
  const normalizer = new ConversationTelemetryFactNormalizer();
  const started = normalizer.normalize(
    "session",
    event(
      SessionEventType.TurnStarted,
      { inputId: "cmd-1", executionKind: "agent" },
      { turnId: "turn-1" as SessionEvent["turnId"] },
    ),
  );
  assert.equal(started?.kind, "turn.started");
  assert.equal(started?.sourceCommandId, "cmd-1");

  const completed = normalizer.normalize(
    "session",
    event(
      SessionEventType.ModelComplete,
      {
        querySource: "main_turn",
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      },
      { turnId: "turn-1" as SessionEvent["turnId"], sequenceNumber: 2 },
    ),
  );
  assert.equal(completed?.kind, "usage.delta");
  assert.equal(completed?.sourceCommandId, "cmd-1");

  const terminal = normalizer.normalize(
    "session",
    event(
      SessionEventType.TurnComplete,
      { resultType: "success", duration: 10, tokenCount: 5, toolCallCount: 1 },
      { turnId: "turn-1" as SessionEvent["turnId"], sequenceNumber: 3 },
    ),
  );
  assert.equal(terminal?.kind, "turn.terminal");
  assert.equal(terminal?.sourceCommandId, "cmd-1");

  const afterClear = normalizer.normalize(
    "session",
    event(
      SessionEventType.ModelComplete,
      {
        querySource: "main_turn",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      },
      { turnId: "turn-1" as SessionEvent["turnId"], sequenceNumber: 4 },
    ),
  );
  assert.equal(afterClear?.sourceCommandId, undefined);
});

test("publisher keeps snapshot, retained resume and gap recovery on one sequence waterline", () => {
  const publisher = new ConversationTopicPublisher("session", "epoch", {
    now: () => 10,
    retention: 1,
  });
  const initial = publisher.subscribe({ connectionId: "desktop-live" });
  assert.equal(initial.ack.mode, "snapshot");
  const initialFrame = initial.frame;
  assert.equal(initialFrame?.payload.kind, "snapshot");
  const baseSeq = initialFrame?.toSeq ?? 0;

  publisher.ingest(
    event(
      SessionEventType.SessionTitleUpdated,
      { previousTitle: "", source: "generated", title: "one" },
      { sequenceNumber: 1 },
    ),
  );
  const descriptor = initial.ack.subscriptionId;
  const delta = publisher.flush(descriptor);
  assert.equal(delta?.payload.kind, "deltas");
  assert.equal(delta?.fromSeq, baseSeq);
  assert.equal(delta?.toSeq, 1);

  const resumed = publisher.subscribe({
    connectionId: "web-replayable",
    base: { logEpoch: "epoch", seq: 0 },
  });
  assert.equal(resumed.ack.mode, "resume");
  assert.equal(resumed.frame?.payload.kind, "deltas");
  assert.equal(resumed.frame?.fromSeq, 0);

  publisher.ingest(
    event(
      SessionEventType.SessionTitleUpdated,
      { previousTitle: "one", source: "generated", title: "two" },
      { sequenceNumber: 2 },
    ),
  );
  const gap = publisher.subscribe({
    connectionId: "web-gap",
    base: { logEpoch: "epoch", seq: 0 },
  });
  assert.equal(gap.ack.mode, "snapshot");
  assert.equal(gap.frame?.payload.kind, "snapshot");
});

test("publisher overflow marks resync and emits a recovery snapshot, not a delta tail", () => {
  const publisher = new ConversationTopicPublisher("session", "epoch", {
    now: () => 10,
    subscriberBufferMaxOps: 0,
  });
  const subscription = publisher.subscribe({ connectionId: "slow" });
  assert.equal(subscription.frame?.payload.kind, "snapshot");
  publisher.ingest(
    event(
      SessionEventType.SessionTitleUpdated,
      { previousTitle: "", source: "generated", title: "one" },
      { sequenceNumber: 1 },
    ),
  );
  const recovery = publisher.flush(subscription.ack.subscriptionId);
  assert.equal(recovery?.payload.kind, "snapshot");
  assert.equal(recovery?.fromSeq, 0);
});

test("manual compact failure releases the active lock and records the timeline fact", async () => {
  const facts: Array<{ lifecycleStatus: unknown }> = [];
  const mutations: string[] = [];
  let rejectSubmit: ((error: Error) => void) | undefined;
  const record = {
    app: {
      sessionId: "session",
      runtime: { releaseForegroundPromotionLease: () => {} },
      submitPrompt: () =>
        new Promise((_resolve, reject) => {
          rejectSubmit = reject;
        }),
      setQueueAutoDrain: async () => {},
    },
    workspace: { workspacePath: "/workspace" },
    traceContext: {},
  } as unknown as V4SessionRecordView;
  const host = {
    recordPersistentCommandFact: async (
      _sessionId: string,
      _source: string,
      _ack: unknown,
      metadata: { lifecycleStatus: unknown },
    ) => {
      facts.push(metadata);
    },
    afterLegacyStateMutation: async (_record: V4SessionRecordView, reason: string) => {
      mutations.push(reason);
    },
  } as unknown as V4CommandCoreHost;

  await startManualCompact(host, record, "compact-1");
  assert.ok(record.activeAbortController);
  rejectSubmit?.(new Error("provider failed"));
  for (let i = 0; i < 5 && record.activeAbortController; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(record.activeAbortController, undefined);
  assert.deepEqual(facts, [{ lifecycleStatus: "failed" }]);
  assert.deepEqual(mutations, ["session_compact_failed"]);
  assert.throws(
    () => {
      throw new V4GoalCompactRejectedError("compactOperationLock", "locked");
    },
    (error) =>
      error instanceof V4GoalCompactRejectedError && error.reasonCode === "compactOperationLock",
  );
});
