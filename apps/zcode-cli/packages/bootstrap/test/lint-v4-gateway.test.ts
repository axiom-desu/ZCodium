import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import type { ZCodeWorkspaceRef } from "@zcode/shared";
import { ConversationV4Gateway, type V4GatewayHost } from "../src/zcode-protocol-v4/v4-gateway.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const sourceDir = path.resolve(testDir, "../src/zcode-protocol-v4");
const sequenceFile = path.join(sourceDir, "v4-gateway-sequence.ts");
const ingestFile = path.join(sourceDir, "v4-gateway-ingest.ts");

function event(
  id: string,
  sequenceNumber: number,
  type: SessionEvent["type"],
  payload: unknown,
  sessionId = "session-a",
): SessionEvent {
  return {
    id,
    sessionId,
    turnId: "turn-1",
    type,
    timestamp: new Date(1_000),
    sequenceNumber,
    payload,
  } as SessionEvent;
}

function host(overrides: Partial<V4GatewayHost> = {}): V4GatewayHost {
  return {
    sessionExists: () => true,
    emitWireFrame: () => {},
    executeCommand: async () => undefined,
    ...overrides,
  } as V4GatewayHost;
}

function titleEvent(title: string, sequenceNumber: number, sessionId = "session-a"): SessionEvent {
  return event(
    `title-${title}`,
    sequenceNumber,
    SessionEventType.SessionTitleUpdated,
    { previousTitle: "", source: "generated", title },
    sessionId,
  );
}

test("gateway public surface stays callable after domain split", () => {
  const gateway = new ConversationV4Gateway(host());
  const publicMethods = [
    "updateSharedContextImport",
    "setConnectionFlowState",
    "ingest",
    "waitForProjectionEventCommit",
    "waitForPermissionGrantCommit",
    "ingestDetachedLiveSession",
    "pruneDetachedChildPublishers",
    "subscribeSessionsIndex",
    "subscribeSessionsIndexReserved",
    "subscribeWorkspaceConfig",
    "subscribeWorkspaceConfigReserved",
    "publishWorkspaceConfig",
    "subscribe",
    "subscribeReserved",
    "resyncReserved",
    "rowsRange",
    "plans",
    "workflowRunEvents",
    "workflowRuns",
    "workflowRunArtifacts",
    "workflowRunArtifactData",
    "workflowRunArtifactRead",
    "workflowRunWorkspace",
    "workflowRunNodeResult",
    "fileChanges",
    "backgroundBashOutput",
    "fileRewindPreview",
    "attachmentBegin",
    "attachmentChunk",
    "attachmentCommit",
    "attachmentAbort",
    "attachmentRead",
    "conversationAttachmentRead",
    "conversationAttachmentStat",
    "attachmentPreviewSource",
    "unsubscribe",
    "handleCommand",
    "queryCommands",
    "getQueueItem",
    "hasQueueItemKind",
    "hasQueuedDelivery",
    "getQueueLength",
    "hasResidencyBlockingCommands",
    "getQueueHead",
    "getInputRoutingMode",
    "getSessionFollowupMode",
    "getMessageIdForRow",
    "resolveRowActionTarget",
    "getMessageIdsForTurnRow",
    "isLatestAssistantSegmentRow",
    "resolveStableForkCandidate",
    "isLatestRetryAssistantRow",
    "isLatestEditableUserRow",
    "getTurnIdForRow",
    "getTurnRewindAnchor",
    "disposeSession",
    "deactivateSession",
    "assertSessionRuntimeDeactivatable",
    "hasConversationSubscribers",
    "collectMemoryDiagnostics",
    "dispose",
    "flushNow",
  ] as const;
  for (const name of publicMethods) {
    assert.equal(typeof gateway[name], "function", `${name} must stay public`);
  }
  assert.equal(gateway.getQueueLength("session-a"), 0);
  assert.deepEqual(gateway.collectMemoryDiagnostics(), {
    publishers: 0,
    detachedLive: 0,
    detachedTerminal: 0,
    rawSeqStates: 0,
  });
  gateway.dispose();
});

test("desktop continuous flushes live deltas while web replayable resumes or snapshots", async () => {
  const gateway = new ConversationV4Gateway(host());
  try {
    const desktop = await gateway.subscribe({
      topic: "conversation/session-a",
      connectionId: "desktop-live",
      clientMode: "desktop-continuous",
    });
    desktop.commit();
    assert.equal(desktop.ack.mode, "snapshot");
    assert.equal(desktop.initialFrame?.payload.kind, "snapshot");

    gateway.ingest("session-a", titleEvent("one", 1));
    const live = gateway.flushNow(desktop.ack.subscriptionId);
    assert.equal(live?.payload.kind, "deltas");
    assert.equal(live?.toSeq, 1);

    const resumed = await gateway.subscribe({
      topic: "conversation/session-a",
      connectionId: "web-replayable",
      clientMode: "web-remote-replayable",
      base: { logEpoch: desktop.ack.logEpoch, seq: 0 },
    });
    resumed.commit();
    assert.equal(resumed.ack.mode, "resume");
    assert.equal(resumed.initialFrame?.payload.kind, "deltas");
    assert.equal(resumed.initialFrame?.fromSeq, 0);

    const gap = await gateway.subscribe({
      topic: "conversation/session-a",
      connectionId: "web-gap",
      clientMode: "web-remote-replayable",
      base: { logEpoch: "older-epoch", seq: 0 },
    });
    gap.commit();
    assert.equal(gap.ack.mode, "snapshot");
    assert.equal(gap.initialFrame?.payload.kind, "snapshot");
  } finally {
    gateway.dispose();
  }
});

test("TopicClosed unsubscribe matches topic, connection and subscription precisely", async () => {
  const gateway = new ConversationV4Gateway(host());
  try {
    const first = await gateway.subscribe({
      topic: "conversation/session-a",
      connectionId: "conn-a",
      clientMode: "desktop-continuous",
    });
    first.commit();
    const second = await gateway.subscribe({
      topic: "conversation/session-b",
      connectionId: "conn-b",
      clientMode: "desktop-continuous",
    });
    second.commit();
    assert.equal(gateway.hasConversationSubscribers("session-a"), true);
    assert.equal(gateway.hasConversationSubscribers("session-b"), true);

    // 裸 subscriptionId 或连接 id 单独命中都不能误删别的 topic/connection owner。
    gateway.unsubscribe({
      topic: "conversation/session-a",
      subscriptionId: second.ack.subscriptionId,
      connectionId: "conn-b",
    });
    gateway.unsubscribe({
      topic: "conversation/session-a",
      subscriptionId: first.ack.subscriptionId,
      connectionId: "conn-b",
    });
    assert.equal(gateway.hasConversationSubscribers("session-a"), true);
    assert.equal(gateway.hasConversationSubscribers("session-b"), true);

    gateway.ingest("session-b", titleEvent("still-owned", 1, "session-b"));
    assert.equal(gateway.flushNow(second.ack.subscriptionId)?.payload.kind, "deltas");

    gateway.unsubscribe({
      topic: "conversation/session-b",
      subscriptionId: second.ack.subscriptionId,
      connectionId: "conn-b",
    });
    assert.equal(gateway.hasConversationSubscribers("session-b"), false);
    assert.equal(gateway.hasConversationSubscribers("session-a"), true);
    gateway.unsubscribe({
      topic: "conversation/session-a",
      subscriptionId: first.ack.subscriptionId,
      connectionId: "conn-a",
    });
    assert.equal(gateway.hasConversationSubscribers("session-a"), false);
  } finally {
    gateway.dispose();
  }
});

test("persistent command facts invalidate before live queue pins are released", async () => {
  const order: string[] = [];
  let gateway!: ConversationV4Gateway;
  const fake = host({
    invalidatePersistentCommandFacts: (sessionId) => {
      // queue item 已被投影删除；此刻仍 resident 只可能来自 inbox live pin。
      order.push(`invalidate:${sessionId}:${gateway.getQueueLength(sessionId)}`);
      assert.equal(gateway.getQueueLength(sessionId), 0);
      assert.equal(gateway.hasResidencyBlockingCommands(sessionId), true);
    },
  });
  gateway = new ConversationV4Gateway(fake);
  try {
    gateway.ingest(
      "session-a",
      event("queued", 1, SessionEventType.TurnSteerQueued, {
        pendingInputId: "pending-1",
        inputId: "cmd-queued",
        input: "queued text",
        sourceCommandId: "cmd-queued",
      }),
    );
    assert.equal(gateway.getQueueLength("session-a"), 1);
    const pinned = await gateway.queryCommands({
      commands: [{ sessionId: "session-a", commandId: "cmd-queued" }],
    });
    assert.equal(
      pinned.results[0]?.result === "unknown" ? "unknown" : pinned.results[0]?.result.status,
      "accepted",
    );

    gateway.ingest(
      "session-a",
      event("drained", 2, SessionEventType.TurnSteerDrained, {
        pendingInputIds: ["pending-1"],
      }),
    );
    assert.deepEqual(order, ["invalidate:session-a:0"]);
    assert.equal(gateway.getQueueLength("session-a"), 0);
    assert.equal(gateway.hasResidencyBlockingCommands("session-a"), false);
  } finally {
    gateway.dispose();
  }
});

test("cold READY shares one resume flight and keeps same-path identities independent", async () => {
  const active = new Set<string>();
  const resumed: Array<{ sessionId: string; workspace?: ZCodeWorkspaceRef }> = [];
  const gateway = new ConversationV4Gateway(
    host({
      sessionExists: (sessionId) => active.has(sessionId),
      resumePersistedSession: async (sessionId, _thought, workspace) => {
        resumed.push({ sessionId, workspace });
        active.add(sessionId);
        return { status: "resumed" as const };
      },
      loadPersistedEvents: async () => ({
        events: [],
        synthesized: false,
        sourceEventSeq: 5,
      }),
    }),
    { createLogEpoch: (sessionId) => `epoch-${sessionId}` },
  );
  const workspaceA: ZCodeWorkspaceRef = {
    workspacePath: "/same/project",
    workspaceIdentity: "remote-a",
    remoteSessionId: "remote-session-1",
    workspaceKey: "remote-a",
  };
  const workspaceB: ZCodeWorkspaceRef = {
    workspacePath: "/same/project",
    workspaceIdentity: "remote-b",
    remoteSessionId: "remote-session-2",
    workspaceKey: "remote-b",
  };
  try {
    // subscribe 与 rowsRange 同时触发同一 session 的 cold READY：只允许一次 resume。
    const [subscribed, rowsDuringCold] = await Promise.all([
      gateway.subscribe({
        topic: "conversation/session-a",
        connectionId: "conn-a",
        clientMode: "desktop-continuous",
        workspace: workspaceA,
      }),
      gateway.rowsRange({ sessionId: "session-a", limit: 1 }),
    ]);
    subscribed.commit();
    assert.equal(
      resumed.filter((item) => item.sessionId === "session-a").length,
      1,
      "cold READY must share the same activation flight",
    );
    assert.deepEqual(rowsDuringCold.rows, []);

    const other = await gateway.subscribe({
      topic: "conversation/session-b",
      connectionId: "conn-b",
      clientMode: "web-remote-replayable",
      workspace: workspaceB,
    });
    other.commit();
    assert.equal(resumed.length, 2);
    assert.notEqual(
      resumed[0]?.workspace?.workspaceIdentity,
      resumed[1]?.workspace?.workspaceIdentity,
    );
    assert.notEqual(resumed[0]?.workspace?.remoteSessionId, resumed[1]?.workspace?.remoteSessionId);
    assert.equal(resumed[0]?.workspace?.workspacePath, "/same/project");
    assert.equal(resumed[1]?.workspace?.workspacePath, "/same/project");

    gateway.ingest("session-a", titleEvent("a-only", 6));
    await gateway.waitForProjectionEventCommit("session-a", "title-a-only");
    const rowsA = await gateway.rowsRange({ sessionId: "session-a", limit: 1 });
    const rowsB = await gateway.rowsRange({ sessionId: "session-b", limit: 1 });
    assert.equal(rowsA.atSeq, 1);
    assert.equal(rowsB.atSeq, 0);
  } finally {
    gateway.dispose();
  }
});

test("cold READY failure releases the flight and hydration sequence rejects aborted commit waiters", async () => {
  let resumeCalls = 0;
  let failOnce = true;
  const active = new Set<string>();
  const gateway = new ConversationV4Gateway(
    host({
      sessionExists: (sessionId) => active.has(sessionId),
      resumePersistedSession: async (sessionId) => {
        resumeCalls += 1;
        if (failOnce) {
          failOnce = false;
          throw new Error("temporary resume failure");
        }
        active.add(sessionId);
        return { status: "resumed" as const };
      },
      loadPersistedEvents: async () => ({
        events: [],
        synthesized: false,
        sourceEventSeq: 5,
      }),
    }),
  );
  try {
    await assert.rejects(
      gateway.subscribe({
        topic: "conversation/session-a",
        connectionId: "conn-a",
        clientMode: "desktop-continuous",
      }),
      /resumeFailed/,
    );
    const retried = await gateway.subscribe({
      topic: "conversation/session-a",
      connectionId: "conn-a",
      clientMode: "desktop-continuous",
    });
    retried.commit();
    assert.equal(resumeCalls, 2);

    // raw seq 7 先到，sourceEventSeq=5 仍有 6 的 gap：waiter 必须保持 pending。
    gateway.ingest("session-a", titleEvent("seven", 7));
    const controller = new AbortController();
    const pending = gateway.waitForProjectionEventCommit("session-a", "title-seven", {
      signal: controller.signal,
    });
    controller.abort(new Error("client cancelled"));
    await assert.rejects(pending, /aborted/);
    // 异常必须固化在 sequence state 中，后续 gap 补齐也不能让失败事件进入 projection。
    await assert.rejects(
      gateway.waitForProjectionEventCommit("session-a", "title-seven"),
      /aborted/,
    );
    gateway.ingest("session-a", titleEvent("six", 6));
    await gateway.waitForProjectionEventCommit("session-a", "title-six");
    await assert.rejects(
      gateway.waitForProjectionEventCommit("session-a", "title-seven"),
      /aborted/,
    );
  } finally {
    gateway.dispose();
  }
});

test("projection commit waiters settle from the registered snapshot, not a live collection", async () => {
  const gateway = new ConversationV4Gateway(host());
  try {
    const settled: string[] = [];
    // 同一 eventId 上并发登记 3 个 waiter：settle 时必须各 callback 恰好一次。
    const pending = ["w1", "w2", "w3"].map((token) =>
      gateway.waitForProjectionEventCommit("session-a", "title-snapshot").then(() => {
        settled.push(token);
      }),
    );
    gateway.ingest("session-a", titleEvent("snapshot", 1));
    await Promise.all(pending);
    assert.deepEqual(settled, ["w1", "w2", "w3"], "每个已登记 waiter 恰好 settle 一次");

    // 说明：上面只是 callback 级检查，不是完整 runtime proof。settle 发生在 Promise
    // 微任务里，公开 API 无法在同步 settle 过程中重入登记新 waiter，所以再用源码属性
    // 守卫锁定「先取快照再遍历」的形态——拆分前 gateway 私有实现即为 `[...waiters]`，
    // 为消除 spread 告警换成 live iterator 会改变未来的重入语义。
    const sequenceSource = fs.readFileSync(sequenceFile, "utf8");
    assert.equal(sequenceSource.includes("of Array.from(waiters)"), true);
    assert.equal(sequenceSource.includes("of [...waiters]"), false);
    const ingestSource = fs.readFileSync(ingestFile, "utf8");
    assert.equal(ingestSource.includes("of Array.from(ctx.detachedTerminalAt)"), true);
    assert.equal(ingestSource.includes("of [...ctx.detachedTerminalAt]"), false);
  } finally {
    gateway.dispose();
  }
});
