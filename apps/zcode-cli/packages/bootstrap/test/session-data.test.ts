import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionId } from "@zcode/contracts";
import {
  measureSessionDataWith,
  purgeSessionDataWith,
  type SessionDataHost,
} from "../src/zcode-protocol/session-data/index.js";

/** 纯内存宿主：store/files 行为按用例注入，断言删除顺序与幂等语义（不读写真实用户数据）。 */
function harness(
  options: {
    busy?: string[];
    loaded?: string[];
    failFiles?: string[];
    referrers?: Record<string, string[]>;
  } = {},
) {
  const trees: Record<string, string[]> = {
    sess_a: ["sess_a", "sess_a_child"],
    sess_b: ["sess_b"],
    sess_c: ["sess_c"],
  };
  const sizes: Record<string, number> = { sess_a: 10, sess_a_child: 5, sess_b: 7, sess_gone: 3 };
  const calls: string[] = [];
  const host: SessionDataHost = {
    store: {
      listOwnedSessionTrees: async (ids) =>
        new Map(ids.map((id) => [id, trees[id] ?? []] as const)) as never,
      listArtifactReferrers: async (ids) =>
        new Map(
          ids.flatMap((id) =>
            options.referrers?.[id] ? [[id, options.referrers[id]] as const] : [],
          ),
        ) as never,
      purgeSessions: async (ids) => {
        calls.push(`purge:${ids.join(",")}`);
      },
    },
    files: {
      measureSession: async (id) => sizes[id] ?? 0,
      removeSession: async (id) => {
        if (options.failFiles?.includes(id))
          throw Object.assign(new Error("busy"), { code: "EBUSY" });
        calls.push(`files:${id}`);
        return sizes[id] ?? 0;
      },
      measureMemory: async () => 4,
      removeMemory: async ({ workspacePath }) => {
        calls.push(`memory:${workspacePath}`);
        return 4;
      },
    },
    residency: (id) =>
      options.busy?.includes(id) ? "busy" : options.loaded?.includes(id) ? "idle" : null,
    release: async (id) => {
      calls.push(`release:${id}`);
    },
    forgetIndexed: (id) => {
      calls.push(`forget:${id}`);
    },
  };
  return { host, calls };
}

const directories = [{ workspacePath: "/work/a" }];

describe("session data", () => {
  it("measures each root with its owned children and each directory's memory", async () => {
    const { host } = harness();
    assert.deepEqual(
      await measureSessionDataWith(host, { sessionIds: ["sess_a", "sess_b"], directories }),
      {
        sessions: [
          { sessionId: "sess_a", bytes: 15 },
          { sessionId: "sess_b", bytes: 7 },
        ],
        memory: [{ workspacePath: "/work/a", bytes: 4 }],
      },
    );
  });

  it("releases loaded idle sessions, removes files before rows, then drops them from the index", async () => {
    const { host, calls } = harness({ loaded: ["sess_a_child"] });
    const result = await purgeSessionDataWith(host, { sessionIds: ["sess_a"], directories });
    assert.deepEqual(result, {
      deleted: [{ sessionId: "sess_a", bytes: 15 }],
      kept: [],
      failed: [],
      memory: [{ workspacePath: "/work/a", bytes: 4 }],
    });
    assert.deepEqual(calls, [
      "release:sess_a_child",
      "files:sess_a",
      "files:sess_a_child",
      "purge:sess_a",
      "forget:sess_a",
      "forget:sess_a_child",
      "memory:/work/a",
    ]);
  });

  it("keeps a tree whose root or child is running, without touching its files", async () => {
    const { host, calls } = harness({ busy: ["sess_a_child"] });
    const result = await purgeSessionDataWith(host, {
      sessionIds: ["sess_a", "sess_b"],
      directories: [],
    });
    assert.deepEqual(result.kept, [{ sessionId: "sess_a", reason: "running" }]);
    assert.deepEqual(result.deleted, [{ sessionId: "sess_b", bytes: 7 }]);
    assert.equal(
      calls.some((call) => call.includes("sess_a")),
      false,
    );
  });

  it("leaves the rows when a file cannot be removed so a retry can find them", async () => {
    const { host, calls } = harness({ failFiles: ["sess_a_child"] });
    const result = await purgeSessionDataWith(host, { sessionIds: ["sess_a"], directories: [] });
    assert.deepEqual(result.failed, [{ sessionId: "sess_a", code: "EBUSY" }]);
    assert.deepEqual(result.deleted, []);
    assert.equal(calls.includes("purge:sess_a"), false);
    // 删除没完成：不能先从列表投影移除，否则 Host 会把仍存在的会话当作已删除。
    assert.equal(
      calls.some((call) => call.startsWith("forget:")),
      false,
    );
  });

  it("keeps a tree whose attachments a session outside the request still uses", async () => {
    const { host, calls } = harness({ referrers: { sess_a_child: ["sess_fork_elsewhere"] } });
    const result = await purgeSessionDataWith(host, {
      sessionIds: ["sess_a", "sess_b"],
      directories: [],
    });
    assert.deepEqual(result.kept, [{ sessionId: "sess_a", reason: "referenced" }]);
    assert.deepEqual(result.deleted, [{ sessionId: "sess_b", bytes: 7 }]);
    assert.equal(
      calls.some((call) => call.includes("sess_a")),
      false,
    );
  });

  it("deletes a source together with a fork that is deleted in the same request", async () => {
    const { host } = harness({ referrers: { sess_a: ["sess_b"] } });
    const result = await purgeSessionDataWith(host, {
      sessionIds: ["sess_a", "sess_b"],
      directories: [],
    });
    assert.deepEqual(result.kept, []);
    assert.deepEqual(
      result.deleted.map((entry) => entry.sessionId),
      ["sess_a", "sess_b"],
    );
  });

  it("keeps every tree in a chain once one link is kept", async () => {
    // sess_c 正在运行并引用 sess_b，sess_b 又引用 sess_a：三棵都不能删（不动点迭代）。
    const { host } = harness({
      busy: ["sess_c"],
      referrers: { sess_a: ["sess_b"], sess_b: ["sess_c"] },
    });
    const result = await purgeSessionDataWith(host, {
      sessionIds: ["sess_a", "sess_b", "sess_c"],
      directories: [],
    });
    assert.deepEqual(result.kept, [
      { sessionId: "sess_a", reason: "referenced" },
      { sessionId: "sess_b", reason: "referenced" },
      { sessionId: "sess_c", reason: "running" },
    ]);
    assert.deepEqual(result.deleted, []);
  });

  it("treats a session that no longer exists as deleted, still clearing leftover files", async () => {
    const { host, calls } = harness();
    const result = await purgeSessionDataWith(host, { sessionIds: ["sess_gone"], directories: [] });
    assert.deepEqual(result.deleted, [{ sessionId: "sess_gone", bytes: 3 }]);
    assert.deepEqual(calls, ["files:sess_gone", "purge:sess_gone", "forget:sess_gone"]);
  });

  it("keeps a locally busy session instead of deleting its rows", async () => {
    const { host, calls } = harness({ busy: ["sess_b"] });
    const result = await purgeSessionDataWith(host, { sessionIds: ["sess_b"], directories: [] });
    assert.deepEqual(result.kept, [{ sessionId: "sess_b" as SessionId, reason: "running" }]);
    assert.deepEqual(result.deleted, []);
    assert.deepEqual(calls, []);
  });
});
