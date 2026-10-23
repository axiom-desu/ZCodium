import assert from "node:assert/strict";
import { it } from "node:test";
import type {
  CreateSessionInput,
  ForkCommitBundle,
  ModelUsageRecord,
  SessionId,
} from "@zcode/contracts";

import { SqliteSessionStore } from "../src/storage/session-store/sqlite-session-store.js";

function sessionInput(id: string, parentID?: SessionId): CreateSessionInput {
  return {
    id: id as SessionId,
    projectID: "project-1" as CreateSessionInput["projectID"],
    parentID,
    slug: id,
    directory: "/tmp",
    title: id,
    version: "test",
  };
}

it("fork bundle transaction rolls child and parent command fact back together", async () => {
  const store = new SqliteSessionStore({
    dbPath: ":memory:",
    forkCommitFaultAt: "afterChild",
  });
  try {
    const parent = await store.createSession(sessionInput("parent"));
    const childInput = sessionInput("child", parent.id);
    const bundle: ForkCommitBundle = {
      child: childInput,
      messages: [],
      entries: [],
      commandFact: {
        parentSessionId: String(parent.id),
        sourceCommandId: "command-1",
        ack: {
          commandId: "command-1",
          status: "accepted",
          revisionAtDecision: 0,
          result: { type: "forkAssistant", sessionId: String(childInput.id) },
        },
        metadata: {},
      },
    };

    await assert.rejects(store.commitForkBundle(bundle), /injected fork commit fault/);
    assert.equal(await store.getSession(childInput.id), null);
    assert.deepEqual(
      await store.sessionEntries({ sessionID: parent.id, type: "v4/command_fact" }),
      [],
    );
  } finally {
    store.close();
  }
});

it("task usage accumulates input deltas from per-source baseline, not raw row sums", async () => {
  const store = new SqliteSessionStore({ dbPath: ":memory:" });
  try {
    const session = await store.createSession(sessionInput("usage"));
    const base = {
      sessionID: session.id,
      logicalRequestId: "logical",
      querySource: "main_turn",
      providerId: "provider",
      modelId: "model",
      status: "completed" as const,
    };
    const startedAt = Date.now();
    const rows: ModelUsageRecord[] = [
      {
        ...base,
        id: "row-1",
        startedAt,
        inputTokens: 100,
        outputTokens: 20,
        computedTotalTokens: 120,
      },
      {
        ...base,
        id: "row-2",
        startedAt: startedAt + 1,
        inputTokens: 150,
        outputTokens: 30,
        computedTotalTokens: 180,
      },
      {
        ...base,
        id: "row-3",
        startedAt: startedAt + 2,
        inputTokens: 80,
        outputTokens: 10,
        computedTotalTokens: 90,
      },
    ];
    for (const row of rows) await store.recordModelUsage(row);

    const usage = await store.queryTaskUsage({ sessionID: session.id });
    assert.equal(usage.inputTokens, 150);
    assert.equal(usage.totalTokens, 210);
    assert.equal(usage.modelRequestCount, 3);
    assert.equal(usage.inputBaselineBySource.main_turn, 80);
  } finally {
    store.close();
  }
});
