import assert from "node:assert/strict";
import { it } from "node:test";
import type { CreateSessionInput, SessionId, SessionInfo } from "@zcode/contracts";

import { SqliteSessionStore } from "@zcode/adapters/storage";
import { listSessions } from "../src/zcode-protocol/server-operations.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

/**
 * 显式 ID 查询的归属证明：只有持久 parentID + 每层严格路径/身份校验能把由子 runtime
 * 写入（只带 cwd）的辅助子会话归入远端 workspace；普通分页仍按 workspace key 隔离。
 * 这里用真实临时 SQLite 行，不 mock store 语义。
 */
function context(store: SqliteSessionStore): ZCodeProtocolAgentServerContext {
  return {
    deps: { sessionStore: store },
    sessions: new Map(),
  } as unknown as ZCodeProtocolAgentServerContext;
}

async function create(
  store: SqliteSessionStore,
  input: {
    id: string;
    taskType?: CreateSessionInput["taskType"];
    parentID?: string;
    path?: string;
    workspaceID?: CreateSessionInput["workspaceID"];
  },
) {
  return store.createSession({
    id: input.id as SessionId,
    projectID: "proj" as CreateSessionInput["projectID"],
    workspaceID: input.workspaceID,
    parentID: input.parentID as SessionId | undefined,
    taskType: input.taskType ?? "interactive",
    slug: input.id,
    directory: input.path ?? "/w",
    path: input.path ?? "/w",
    title: input.id,
    version: "test",
  });
}

const REMOTE = {
  workspacePath: "/w",
  workspaceKey: "remote:ssh:h:/w",
  workspaceIdentity: "remote:ssh:h:/w",
} as const;

async function withStore(run: (store: SqliteSessionStore) => Promise<void>) {
  const store = new SqliteSessionStore({ dbPath: ":memory:" });
  try {
    await create(store, { id: "root", workspaceID: REMOTE.workspaceIdentity as never });
    await run(store);
  } finally {
    store.close();
  }
}

async function ids(
  store: SqliteSessionStore,
  params: { sessionIds?: string[]; workspace?: typeof REMOTE },
): Promise<string[]> {
  const result = (await listSessions(context(store), params)) as { sessions: SessionInfo[] };
  return result.sessions.map((session) => String(session.sessionId));
}

it("workflow_child 显式 ID 凭持久父链归入同 workspace", () =>
  withStore(async (store) => {
    for (const kind of [
      "workflow_child",
      "nested_workflow_child",
      "subagent_child",
      "selection_side_chat",
    ] as const) {
      await create(store, { id: kind, taskType: kind, parentID: "root" });
      assert.deepEqual(await ids(store, { workspace: REMOTE, sessionIds: [kind] }), [kind], kind);
      // 普通分页仍只按 workspace key：只有带 identity 的 root 出现。
      assert.deepEqual(await ids(store, { workspace: REMOTE }), ["root"], kind);
    }
  }));

it("任一层路径不同或身份冲突都拒绝，fork/workflow_parent 不沿父链", () =>
  withStore(async (store) => {
    await create(store, {
      id: "other_root",
      path: "/other",
      workspaceID: REMOTE.workspaceIdentity as never,
    });
    await create(store, { id: "cross", taskType: "workflow_child", parentID: "other_root" });
    assert.deepEqual(await ids(store, { workspace: REMOTE, sessionIds: ["cross"] }), []);

    await create(store, {
      id: "foreign",
      taskType: "workflow_child",
      parentID: "root",
      workspaceID: "remote:ssh:x:/w" as never,
    });
    assert.deepEqual(await ids(store, { workspace: REMOTE, sessionIds: ["foreign"] }), []);

    for (const kind of ["fork", "workflow_parent"] as const) {
      await create(store, { id: kind, taskType: kind, parentID: "root" });
      assert.deepEqual(await ids(store, { workspace: REMOTE, sessionIds: [kind] }), [], kind);
      assert.deepEqual(await ids(store, { sessionIds: [kind] }), [kind], kind);
    }
  }));

it("已删除的会话在显式查询与分页里都不返回", () =>
  withStore(async (store) => {
    await create(store, { id: "child", taskType: "workflow_child", parentID: "root" });
    await store.softDeleteSession("root" as SessionId, 5_000);
    assert.deepEqual(await ids(store, { workspace: REMOTE, sessionIds: ["child"] }), []);
    assert.deepEqual(await ids(store, { workspace: REMOTE, sessionIds: ["root"] }), []);
    assert.deepEqual(await ids(store, { workspace: REMOTE }), []);
  }));
