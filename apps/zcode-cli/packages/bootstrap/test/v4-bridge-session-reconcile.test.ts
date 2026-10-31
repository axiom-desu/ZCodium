import assert from "node:assert/strict";
import test from "node:test";
import { createGatewaySessionReconcile } from "../src/zcode-protocol/v4-bridge-session-reconcile.js";

function ports(sessions: Record<string, Record<string, unknown>>) {
  return {
    context: {
      deps: {
        sessionStore: {
          getSession: async (id: string) => sessions[id] ?? null,
        },
      },
    },
  } as unknown as Parameters<typeof createGatewaySessionReconcile>[0];
}

test("reconcile reports persisted CLI facts and explicit deletion", async () => {
  const { reconcileSessions } = createGatewaySessionReconcile(
    ports({
      kept: {
        id: "kept",
        directory: "/repo",
        title: "Kept",
        titleSource: "custom",
        time: { created: 10, updated: 20 },
        lastOutcome: "completed",
      },
      removed: {
        id: "removed",
        directory: "/repo",
        title: "Gone",
        time: { created: 1, updated: 2, deleted: 3 },
      },
      other: { id: "other", directory: "/elsewhere", title: "x", time: { created: 1, updated: 2 } },
    }),
  );
  const result = await reconcileSessions!({
    workspaceId: "/repo",
    sessionIds: ["kept", "removed", "other", "missing"],
  });
  assert.deepEqual(result.sessions, [
    {
      sessionId: "kept",
      exists: true,
      deleted: false,
      title: "Kept",
      titleSource: "custom",
      createdAt: 10,
      updatedAt: 20,
      lastOutcome: "completed",
    },
    {
      sessionId: "removed",
      exists: true,
      deleted: true,
      title: "Gone",
      titleSource: "generated",
      createdAt: 1,
      updatedAt: 2,
    },
    { sessionId: "other", exists: false, deleted: false },
    { sessionId: "missing", exists: false, deleted: false },
  ]);
});

test("reconcile keeps remote identities isolated by workspace id", async () => {
  const identity = "remote:ssh:example.test:22:user:/repo";
  const { reconcileSessions } = createGatewaySessionReconcile(
    ports({
      local: { id: "local", directory: "/repo", title: "local", time: { created: 1, updated: 2 } },
      remote: {
        id: "remote",
        directory: "/repo",
        workspaceID: identity,
        title: "remote",
        time: { created: 1, updated: 2 },
      },
    }),
  );
  const result = await reconcileSessions!({
    workspaceId: identity,
    sessionIds: ["local", "remote"],
  });
  assert.deepEqual(
    result.sessions.map((session) => [session.sessionId, session.exists]),
    [
      ["local", false],
      ["remote", true],
    ],
  );
});
