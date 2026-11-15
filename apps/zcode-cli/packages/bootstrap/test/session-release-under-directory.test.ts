import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { releaseSessionsUnderDirectory } from "../src/zcode-protocol/server-operations.js";

const WORKTREE = join("/fixture", "worktrees", "3f2a", "repo");
const PROJECT = join("/fixture", "repo");

interface FakeRecord {
  workspace: { workspacePath: string; workspaceKey: string };
  legacyStreamSubscribed: boolean;
  residencyFinalizationCount: number;
  updatedAt: number;
  persistence: "immediate";
  busy: boolean;
  app: { runtime: { hasResidencyBlockingWork(): boolean }; close(): Promise<void> };
  eventStore: { deleteSession(): Promise<void> };
  unsubscribe(): void;
}

function createContext(records: Array<[string, FakeRecord]>) {
  const closed: string[] = [];
  const context = {
    sessions: new Map(records),
    v4Interactions: { hasPendingForSession: () => false },
    v4Gateway: {
      hasResidencyBlockingCommands: () => false,
      assertSessionRuntimeDeactivatable: () => {},
      deactivateSession: () => {},
      hasConversationSubscribers: () => false,
    },
    deps: { sessionStore: { unregisterSessionRuntime: async () => {} } },
    logger: { info: () => {}, warn: () => {} },
  };
  for (const [id, record] of records) {
    record.app.close = async () => {
      closed.push(id);
    };
  }
  return { context, closed };
}

function record(path: string, busy = false): FakeRecord {
  return {
    workspace: { workspacePath: path, workspaceKey: PROJECT },
    legacyStreamSubscribed: false,
    residencyFinalizationCount: 0,
    updatedAt: 0,
    persistence: "immediate",
    busy,
    app: {
      runtime: { hasResidencyBlockingWork: () => busy },
      close: async () => {},
    },
    eventStore: { deleteSession: async () => {} },
    unsubscribe: () => {},
  };
}

test("session/releaseUnderDirectory only releases idle sessions inside the directory", async () => {
  const { context, closed } = createContext([
    ["in-worktree", record(join(WORKTREE, "packages", "ui"))],
    ["in-project", record(PROJECT)],
  ]);
  assert.deepEqual(
    await releaseSessionsUnderDirectory(context as never, { directory: WORKTREE }),
    { released: ["in-worktree"], busy: [] },
  );
  assert.deepEqual(closed, ["in-worktree"]);
});

test("session/releaseUnderDirectory keeps every session resident when any is busy", async () => {
  const { context, closed } = createContext([
    ["busy", record(WORKTREE, true)],
    ["idle", record(join(WORKTREE, "src"))],
  ]);
  assert.deepEqual(
    await releaseSessionsUnderDirectory(context as never, { directory: WORKTREE }),
    { released: [], busy: ["busy"] },
  );
  assert.deepEqual(closed, []);
});

test("session/releaseUnderDirectory returns an empty ACK when no session is inside", async () => {
  const { context, closed } = createContext([["in-project", record(PROJECT)]]);
  assert.deepEqual(
    await releaseSessionsUnderDirectory(context as never, {
      directory: join("/fixture", "worktrees", "9999", "repo"),
    }),
    { released: [], busy: [] },
  );
  assert.deepEqual(closed, []);
});
