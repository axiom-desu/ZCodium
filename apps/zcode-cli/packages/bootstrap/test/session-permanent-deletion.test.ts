import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, it } from "node:test";
import type { SessionId } from "@zcode/contracts";

import { createNodeSessionDataFiles } from "../../adapters/src/storage/session-data-files/index.js";
import { SqliteSessionStore } from "../../adapters/src/storage/session-store/sqlite-session-store.js";
import { NodeToolArtifactStore } from "../../adapters/src/storage/index.js";
import {
  executeSessionDeletionWith,
  previewSessionDeletionWith,
  type SessionDeletionHost,
} from "../src/zcode-protocol/session-data/index.js";

const cleanups: Array<() => Promise<void>> = [];
after(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const params = { sessionId: "root", workspace: { workspacePath: "/work/example" } };

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "zcode-permanent-deletion-"));
  const dbPath = join(root, "db.sqlite");
  const store = new SqliteSessionStore({ dbPath });
  const db = new DatabaseSync(dbPath);
  cleanups.push(async () => {
    db.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  for (const [id, parentID, taskType] of [
    ["root", undefined, "interactive"],
    ["child", "root", "subagent_child"],
    ["fork", "root", "interactive"],
  ] as const)
    await store.createSession({
      id: id as SessionId,
      projectID: "project" as never,
      slug: id,
      directory: params.workspace.workspacePath,
      title: id,
      version: "1",
      ...(parentID ? { parentID: parentID as SessionId } : {}),
      ...(taskType ? { taskType: taskType as never } : {}),
    });
  db.prepare(
    "INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES('m','fork',1,1,'{}')",
  ).run();
  db.prepare(
    "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES('p','m','fork',1,1,?)",
  ).run(JSON.stringify({ url: "zcode-artifact://root/shared" }));
  const dir = join(root, "artifacts", "root");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "shared.png"), "shared");
  await writeFile(join(dir, "private.txt"), "private");
  const files = createNodeSessionDataFiles({
    cliStorageRoot: root,
    memoryRoot: () => join(root, "memories", "projects", "unused", "memory"),
  });
  const busy = new Set<string>();
  const loaded = new Set(["root", "child"]);
  const host: SessionDeletionHost = {
    store,
    files,
    busy: (id) => busy.has(id),
    loaded: (id) => loaded.has(id),
    release: async () => {},
    forget: () => {},
  };
  const execute = async (revision: string) =>
    executeSessionDeletionWith(host, { ...params, revision, operationId: "op" });
  return { root, dbPath, db, store, dir, host, busy, loaded, execute };
}

it("保留 fork 和引用文件，物理删除正文，重复请求返回已完成", async () => {
  const { root, host, store, dir, execute, db } = await setup();
  for (const id of ["root", "child"]) {
    db.prepare("INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES(?,?,1,1,?)").run(
      `${id}-message`,
      id,
      '{"role":"user","text":"E2E_PRIVATE_BODY"}',
    );
    db.prepare(
      "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data) VALUES(?,?,?,1,1,?)",
    ).run(`${id}-part`, `${id}-message`, id, '{"type":"text","text":"E2E_PRIVATE_BODY"}');
  }
  db.exec(
    "INSERT INTO input_history(id,project_id,session_id,text,kind,time_created) VALUES('history','project','root','E2E_PRIVATE_INPUT','prompt',1)",
  );
  db.exec(
    "INSERT INTO dwf_run(id,parent_session_id,caps_max_concurrency,status,time_created,time_updated) VALUES('owned-run','root',1,'completed',1,1)",
  );
  db.exec(
    `INSERT INTO dwf_event(run_id,sequence,type,payload_json,time_created) VALUES('owned-run',1,'result','{"text":"E2E_PRIVATE_WORKFLOW"}',1)`,
  );
  await writeFile(join(root, "workspace-file.txt"), "E2E_KEEP_WORKSPACE");
  const preview = await previewSessionDeletionWith(host, params);
  assert.deepEqual(
    preview.forks.map((fork) => fork.sessionId),
    ["fork"],
  );
  assert.equal(preview.retainedArtifacts[0]?.fileName, "shared.png");
  assert.equal(preview.deletedFiles, 1);
  assert.equal((await execute(preview.revision)).status, "deleted");
  assert.equal(await store.getSession("root" as SessionId), null);
  assert.notEqual(await store.getSession("fork" as SessionId), null);
  assert.equal(await readFile(join(dir, "shared.png"), "utf8"), "shared");
  const artifacts = new NodeToolArtifactStore({
    rootDir: join(root, "artifacts"),
    imageCacheRootDir: join(root, "image-cache"),
    videoCacheRootDir: join(root, "video-cache"),
  });
  assert.equal(
    Buffer.from(
      (await artifacts.readToolResultBinaryArtifact({ uri: "zcode-artifact://root/shared" })).bytes,
    ).toString(),
    "shared",
  );
  await assert.rejects(readFile(join(dir, "private.txt")));
  assert.equal(
    db.prepare("SELECT 1 FROM session WHERE id IN ('root','child') LIMIT 1").get(),
    undefined,
  );
  for (const table of ["message", "part", "input_history"])
    assert.equal(
      db
        .prepare(`SELECT 1 FROM ${table} WHERE session_id IN ('root','child') LIMIT 1`)
        .get(),
      undefined,
      `${table} 必须物理删除`,
    );
  assert.equal(
    db.prepare("SELECT 1 FROM dwf_event WHERE run_id='owned-run'").get(),
    undefined,
  );
  assert.equal(await readFile(join(root, "workspace-file.txt"), "utf8"), "E2E_KEEP_WORKSPACE");
  assert.equal((await execute(preview.revision)).status, "deleted");
});

it("其他会话的工作流产物记录引用也保留附件", async () => {
  const { host, db } = await setup();
  db.exec(`UPDATE part SET data='{}';
    INSERT INTO dwf_run(id,parent_session_id,caps_max_concurrency,status,time_created,time_updated) VALUES('run','fork',1,'completed',1,1);
    INSERT INTO dwf_event(run_id,sequence,type,payload_json,time_created) VALUES('run',1,'artifact','{"uri":"zcode-artifact://root/shared"}',1);`);
  assert.deepEqual(
    (await previewSessionDeletionWith(host, params)).retainedArtifacts.map(
      (file) => file.fileName,
    ),
    ["shared.png"],
  );
});

it("运行中的 owned child 阻止整棵删除", async () => {
  const { host, busy, execute, store } = await setup();
  const preview = await previewSessionDeletionWith(host, params);
  busy.add("child");
  const result = await execute(preview.revision);
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "running");
  assert.notEqual(await store.getSession("root" as SessionId), null);
});

it("预检后新增文件要求重新确认", async () => {
  const { host, dir, execute, store } = await setup();
  const preview = await previewSessionDeletionWith(host, params);
  await writeFile(join(dir, "new.txt"), "new");
  const result = await execute(preview.revision);
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "changed");
  assert.notEqual(await store.getSession("root" as SessionId), null);
});

it("预检后新增外部引用要求重查，准入后拒绝迟到引用", async () => {
  const { host, db, store, execute } = await setup();
  const preview = await previewSessionDeletionWith(host, params);
  db.prepare("UPDATE part SET data=? WHERE id='p'").run(
    JSON.stringify({ url: "zcode-artifact://root/private" }),
  );
  const stale = await execute(preview.revision);
  assert.equal(stale.status, "blocked");
  assert.equal(stale.reason, "changed");
  assert.equal(db.prepare("SELECT 1 FROM session_purge").get(), undefined);
  const fresh = await store.inspectSessionDeletion("root" as SessionId);
  await store.beginSessionDeletion("root" as SessionId, fresh.revision, "op", []);
  assert.throws(
    () =>
      db.prepare("UPDATE part SET data=? WHERE id='p'").run(
        JSON.stringify({ url: "zcode-artifact://root/shared" }),
      ),
    /session-data\.deleting/,
  );
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO dwf_run(id,parent_session_id,caps_max_concurrency,status,time_created,time_updated) VALUES('late-run','root',1,'running',1,1)",
        )
        .run(),
    /session-data\.deleting/,
  );
});

it("文件清理后数据库失败，新存储连接凭持久凭据续删", async () => {
  const { host, store, dir, dbPath, execute } = await setup();
  const preview = await previewSessionDeletionWith(host, params);
  host.store = {
    inspectSessionDeletion: store.inspectSessionDeletion.bind(store),
    beginSessionDeletion: store.beginSessionDeletion.bind(store),
    completeSessionDeletion: async () => {
      throw new Error("injected SQL failure");
    },
  };
  assert.equal((await execute(preview.revision)).status, "incomplete");
  await assert.rejects(readFile(join(dir, "private.txt")));
  const reopened = new SqliteSessionStore({ dbPath });
  cleanups.push(async () => reopened.close());
  // 数据库步骤失败时正文行仍在（凭据已阻止新写入），但列表与普通读取投影必须隐藏。
  assert.notEqual(await reopened.getSession("root" as SessionId), null);
  assert.deepEqual(
    (await reopened.listSessions()).map((session) => session.id),
    ["fork"],
  );
  assert.equal((await reopened.inspectSessionDeletion("root" as SessionId)).deleting, true);
  host.store = reopened;
  assert.equal((await execute(preview.revision)).status, "deleted");
  assert.equal(await readFile(join(dir, "shared.png"), "utf8"), "shared");
});

it("部分失败留下写屏障，重试只完成余项", async () => {
  const { host, execute, store, db } = await setup();
  const preview = await previewSessionDeletionWith(host, params);
  const remove = host.files.removeSession;
  host.files.removeSession = async () => {
    throw Object.assign(new Error("locked"), { code: "EBUSY" });
  };
  assert.equal((await execute(preview.revision)).status, "incomplete");
  // 文件失败不删正文：行还在，重试仍能找到文件；但删除凭据已阻止新写入。
  assert.notEqual(await store.getSession("root" as SessionId), null);
  assert.equal(db.prepare("SELECT 1 FROM session WHERE id='root'").get() !== undefined, true);
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO message(id,session_id,time_created,time_updated,data) VALUES('late','root',1,1,'{}')",
        )
        .run(),
    /session-data\.deleting/,
  );
  host.files.removeSession = remove;
  assert.equal((await execute(preview.revision)).status, "deleted");
  assert.equal(await store.getSession("root" as SessionId), null);
});

it("跨连接运行态互斥且拒绝错误目录身份", async () => {
  const { host, store, dbPath, execute } = await setup();
  const other = new SqliteSessionStore({ dbPath });
  cleanups.push(async () => other.close());
  const preview = await previewSessionDeletionWith(host, params);
  await other.registerSessionRuntime("root" as SessionId);
  const blocked = await execute(preview.revision);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.reason, "in-use");
  await other.unregisterSessionRuntime("root" as SessionId);
  await assert.rejects(
    previewSessionDeletionWith(host, { ...params, workspace: { workspacePath: "/other" } }),
    /identity-mismatch/,
  );
  assert.notEqual(await store.getSession("root" as SessionId), null);
});

it("预检不存在的会话给出 not-found，而不是 0 字节成功", async () => {
  const { host } = await setup();
  const preview = await previewSessionDeletionWith(host, {
    sessionId: "missing",
    workspace: params.workspace,
  });
  assert.equal(preview.blockedReason, "not-found");
  assert.equal(preview.sessionIds.length, 0);
});
