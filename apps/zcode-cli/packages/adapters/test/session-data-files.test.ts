import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { CreateSessionInput, SessionId } from "@zcode/contracts";

import { createNodeSessionDataFiles } from "../src/storage/session-data-files/index.js";
import { SqliteSessionStore } from "../src/storage/session-store/sqlite-session-store.js";

function sessionInput(
  id: string,
  options: { parentId?: string; taskType?: CreateSessionInput["taskType"] } = {},
): CreateSessionInput {
  return {
    id: id as SessionId,
    projectID: "project-1" as CreateSessionInput["projectID"],
    slug: id,
    directory: "/tmp",
    title: id,
    version: "test",
    ...(options.parentId ? { parentID: options.parentId as SessionId } : {}),
    ...(options.taskType ? { taskType: options.taskType } : {}),
  };
}

async function tempRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "zcode-session-data-"));
}

it("owned 树只展开附属后代，fork 不随父会话删除", async () => {
  const store = new SqliteSessionStore({ dbPath: ":memory:" });
  try {
    await store.createSession(sessionInput("root"));
    await store.createSession(
      sessionInput("child", { parentId: "root", taskType: "subagent_child" }),
    );
    await store.createSession(
      sessionInput("nested", { parentId: "child", taskType: "nested_workflow_child" }),
    );
    await store.createSession(sessionInput("fork", { parentId: "root", taskType: "fork" }));

    const trees = await store.listOwnedSessionTrees!(["root", "missing"] as SessionId[]);
    assert.deepEqual(trees.get("root" as SessionId), ["root", "child", "nested"]);
    // 根不存在按空数组，调用方按自身 ID 兜底清理残留文件。
    assert.deepEqual(trees.get("missing" as SessionId), []);

    await store.purgeSessions!(["root"] as SessionId[]);
    assert.equal(await store.getSession("root" as SessionId), null);
    assert.equal(await store.getSession("child" as SessionId), null);
    assert.equal(await store.getSession("nested" as SessionId), null);
    assert.notEqual(await store.getSession("fork" as SessionId), null);
    // 幂等：已不存在的会话不再有行可删。
    await store.purgeSessions!(["root"] as SessionId[]);
  } finally {
    store.close();
  }
});

it("附件引用按 part 内容判定，覆盖按值复制的 fork", async () => {
  const store = new SqliteSessionStore({ dbPath: ":memory:" });
  try {
    await store.createSession(sessionInput("source"));
    await store.createSession(sessionInput("fork", { parentId: "source", taskType: "fork" }));
    await store.saveMessage({
      id: "m1" as Parameters<SqliteSessionStore["saveMessage"]>[0]["id"],
      sessionID: "fork" as SessionId,
      role: "assistant",
      time: { created: 1 },
    } as never);
    await store.savePart({
      id: "p1" as Parameters<SqliteSessionStore["savePart"]>[0]["id"],
      messageID: "m1" as Parameters<SqliteSessionStore["savePart"]>[0]["messageID"],
      sessionID: "fork" as SessionId,
      type: "text",
      text: "see zcode-artifact://source/img-1/shot.png",
      time: { start: 1 },
    } as never);

    const referrers = await store.listArtifactReferrers!(["source"] as SessionId[]);
    assert.deepEqual(referrers.get("source" as SessionId), ["fork"]);

    // 未删除的引用方被单独删除后，引用关系随行消失（不留过期保护）。
    await store.purgeSessions!(["fork"] as SessionId[]);
    assert.deepEqual(await store.listArtifactReferrers!(["source"] as SessionId[]), new Map());
  } finally {
    store.close();
  }
});

it("文件端口测量/删除会话与记忆，越界与重复删除均安全", async () => {
  const root = await tempRoot();
  try {
    const cli = join(root, "cli");
    const memoryRoot = join(cli, "memories", "projects", "site-abc", "memory");
    const files = createNodeSessionDataFiles({
      cliStorageRoot: cli,
      memoryRoot: () => memoryRoot,
    });
    await mkdir(join(cli, "artifacts", "s1"), { recursive: true });
    await mkdir(join(cli, "sessions", "s1"), { recursive: true });
    await mkdir(join(cli, "debug"), { recursive: true });
    await mkdir(memoryRoot, { recursive: true });
    await writeFile(join(cli, "artifacts", "s1", "a.png"), "12345");
    await writeFile(join(cli, "sessions", "s1", "store.db"), "123");
    await writeFile(join(cli, "debug", "model-io-s1.jsonl"), "12");
    await writeFile(join(memoryRoot, "note.md"), "1234567");

    assert.equal(await files.measureSession("s1"), 10);
    assert.equal(await files.measureMemory({ workspacePath: "/work/site" }), 7);
    // 首次删除返回删除前字节数，重复删除幂等 0。
    assert.equal(await files.removeSession("s1"), 10);
    assert.equal(await files.removeSession("s1"), 0);
    assert.equal(await files.removeMemory({ workspacePath: "/work/site" }), 7);
    assert.equal(await files.removeMemory({ workspacePath: "/work/site" }), 0);
    // 目录只能落在 memories/projects 的直接子目录，越界拒绝而不是删除别处。
    const escaping = createNodeSessionDataFiles({
      cliStorageRoot: cli,
      memoryRoot: () => join(cli, "sessions", "someone", "memory"),
    });
    await assert.rejects(escaping.removeMemory({ workspacePath: "/work/site" }));
    await assert.rejects(files.removeSession("../../etc"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
