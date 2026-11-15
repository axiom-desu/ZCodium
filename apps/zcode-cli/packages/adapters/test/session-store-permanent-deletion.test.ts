import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, it } from "node:test";
import type { CreateSessionInput, SessionId } from "@zcode/contracts";

import { SQLITE_MIGRATIONS } from "../src/storage/session-store/migrations.js";
import { SqliteSessionStore } from "../src/storage/session-store/sqlite-session-store.js";

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempDb(): Promise<{ root: string; dbPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "zcode-session-deletion-"));
  roots.push(root);
  return { root, dbPath: join(root, "db.sqlite") };
}

function sessionInput(id: string, parentId?: string, taskType?: string): CreateSessionInput {
  return {
    id: id as SessionId,
    projectID: "project" as CreateSessionInput["projectID"],
    slug: id,
    directory: "/work/example",
    title: id,
    version: "1",
    ...(parentId ? { parentID: parentId as SessionId } : {}),
    ...(taskType ? { taskType: taskType as CreateSessionInput["taskType"] } : {}),
  };
}

async function setup(dbPath: string) {
  const store = new SqliteSessionStore({ dbPath });
  await store.createSession(sessionInput("root"));
  await store.createSession(sessionInput("child", "root", "subagent_child"));
  await store.createSession(sessionInput("fork", "root"));
  return store;
}

it("0025 与上游同 id/checksum，结构已存在但未记账时只补缺失对象并保留数据", async () => {
  const { dbPath } = await tempDb();
  const migration = SQLITE_MIGRATIONS.find(
    (candidate) => candidate.id === "0025_session_permanent_deletion",
  );
  assert.ok(migration, "0025 必须在迁移账本里");
  assert.equal(migration.appVersion, "0.17.1");
  const store = new SqliteSessionStore({ dbPath });
  store.close();
  const db = new DatabaseSync(dbPath);
  try {
    assert.equal(
      db.prepare("select checksum from schema_migration where id=?").get(migration.id)?.checksum,
      "608f3ea3aad458679a4b377968413575749f2231c88133765a088564fc20691e",
    );
    db.exec(`
      insert into session(id,project_id,slug,directory,title,version,time_created,time_updated)
        values('kept','project','kept','/work/example','保留会话','1',1,1);
      insert into message(id,session_id,time_created,time_updated,data)
        values('message','kept',1,1,'{"text":"保留正文"}');
      insert into session_purge values('root','root','operation','["artifact"]','/work/example',null,'deleting');
      insert into session_runtime_presence values('kept','owner',123);
      insert into part(id,message_id,session_id,time_created,time_updated,data)
        values('kept-part','message','kept',1,1,'{}');
    `);
    const schema = () =>
      db.prepare("select type,name,sql from sqlite_master where sql is not null order by name").all();
    const before = schema();
    // 模拟“结构已被其它实现建过、但本仓账本行缺失”：只删一个触发器与账本行。
    db.exec(
      "drop trigger session_purge_message_insert; delete from schema_migration where id='" +
        migration.id +
        "';",
    );
    const reopened = new SqliteSessionStore({ dbPath });
    reopened.close();
    assert.deepEqual(schema(), before, "幂等 apply 只补缺失对象，不重建已有结构");
    assert.equal(
      db.prepare("select checksum from schema_migration where id=?").get(migration.id)?.checksum,
      "608f3ea3aad458679a4b377968413575749f2231c88133765a088564fc20691e",
    );
    assert.equal(
      db.prepare("select state from session_purge where session_id='root'").get()?.state,
      "deleting",
      "删除凭据不能因重跑迁移而丢失",
    );
    assert.equal(db.prepare("select count(*) as n from message").get()?.n, 1);
    // 缺失的触发器被补回：删除期间写正文必须被拒绝。
    assert.throws(
      () =>
        db
          .prepare(
            "insert into message(id,session_id,time_created,time_updated,data) values('late','root',1,1,'{}')",
          )
          .run(),
      /session-data\.deleting/,
    );
    assert.throws(
      () =>
        db
          .prepare("insert into session_runtime_presence values('root','other',1)")
          .run(),
      /session-data\.deleting/,
    );
    assert.throws(
      () =>
        db
          .prepare("update part set data=? where id='kept-part'")
          .run(JSON.stringify({ url: "zcode-artifact://root/late" })),
      /session-data\.deleting/,
    );
  } finally {
    db.close();
  }
});

it("预检按 owned 树、fork 与附件引用给出稳定 revision", async () => {
  const { dbPath } = await tempDb();
  const store = await setup(dbPath);
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(
      "insert into message(id,session_id,time_created,time_updated,data) values('m','fork',1,1,'{}')",
    ).run();
    db.prepare(
      "insert into part(id,message_id,session_id,time_created,time_updated,data) values('p','m','fork',1,1,?)",
    ).run(JSON.stringify({ url: "zcode-artifact://root/shared" }));
    const preview = await store.inspectSessionDeletion("root" as SessionId);
    assert.deepEqual([...preview.sessionIds].sort(), ["child", "root"]);
    assert.deepEqual(
      preview.forks.map((fork) => fork.sessionId),
      ["fork"],
    );
    assert.deepEqual(preview.references, [
      {
        sessionId: "root",
        artifactId: "shared",
        referrers: [{ sessionId: "fork", title: "fork" }],
      },
    ]);
    assert.equal(preview.workspacePath, "/work/example");
    assert.equal(preview.completed, false);
    // 新子会话改变 owned 树 → revision 必须变化（确认后出现新内容不接受旧计划）。
    await store.createSession(sessionInput("late", "root", "subagent_child"));
    const next = await store.inspectSessionDeletion("root" as SessionId);
    assert.notEqual(next.revision, preview.revision);
    await assert.rejects(
      store.beginSessionDeletion("root" as SessionId, preview.revision, "op", []),
      /session-data\.changed/,
    );
  } finally {
    db.close();
    store.close();
  }
});

it("准入后拒绝运行态登记与正文重写；完成后正文消失、fork 与附件元数据保留", async () => {
  const { dbPath } = await tempDb();
  const store = await setup(dbPath);
  const db = new DatabaseSync(dbPath);
  try {
    const preview = await store.inspectSessionDeletion("root" as SessionId);
    await store.beginSessionDeletion("root" as SessionId, preview.revision, "op", [
      { sessionId: "root" as SessionId, artifactId: "shared" },
    ]);
    await assert.rejects(store.registerSessionRuntime("root" as SessionId), /session-data\.deleting/);
    assert.throws(
      () =>
        db
          .prepare(
            "insert into message(id,session_id,time_created,time_updated,data) values('late','child',1,1,'{}')",
          )
          .run(),
      /session-data\.deleting/,
    );
    assert.deepEqual(
      (await store.listSessions()).map((session) => session.id),
      ["fork"],
      "删除凭据写入后列表必须立刻隐藏，即使正文尚未删除",
    );
    await store.completeSessionDeletion("root" as SessionId);
    assert.equal(await store.getSession("root" as SessionId), null);
    assert.equal(await store.getSession("child" as SessionId), null);
    assert.notEqual(await store.getSession("fork" as SessionId), null);
    assert.equal(
      db.prepare("select count(*) as n from input_history").get()?.n,
      0,
      "没有级联外键的表也要显式清理",
    );
    // 重复完成/重复请求幂等。
    await store.completeSessionDeletion("root" as SessionId);
    const after = await store.inspectSessionDeletion("root" as SessionId);
    assert.equal(after.completed, true);
    assert.equal(after.sessionIds.length, 2);
    assert.deepEqual(
      after.references.map((ref) => ref.artifactId),
      ["shared"],
    );
  } finally {
    db.close();
    store.close();
  }
});

it("跨连接运行态互斥，关闭连接清理本 owner 的残留", async () => {
  const { dbPath } = await tempDb();
  const store = await setup(dbPath);
  const other = new SqliteSessionStore({ dbPath });
  try {
    await other.registerSessionRuntime("child" as SessionId);
    const blocked = await store.inspectSessionDeletion("root" as SessionId);
    assert.equal(blocked.foreignRuntime, true);
    await assert.rejects(
      store.beginSessionDeletion("root" as SessionId, blocked.revision, "op", []),
      /session-data\.running/,
    );
    await other.unregisterSessionRuntime("child" as SessionId);
    const free = await store.inspectSessionDeletion("root" as SessionId);
    assert.equal(free.foreignRuntime, false);
    await other.registerSessionRuntime("child" as SessionId);
    other.close();
    const cleared = await store.inspectSessionDeletion("root" as SessionId);
    assert.equal(cleared.foreignRuntime, false, "close 必须清掉本 owner 的运行态行");
  } finally {
    store.close();
  }
});
