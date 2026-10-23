import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import type { CreateSessionInput, SessionId } from "@zcode/contracts";

import { softDeleteSession } from "../src/storage/session-store/repositories/sessions.js";
import { SqliteSessionStore } from "../src/storage/session-store/sqlite-session-store.js";

function sessionInput(id: string): CreateSessionInput {
  return {
    id: id as SessionId,
    projectID: "project-1" as CreateSessionInput["projectID"],
    slug: id,
    directory: "/tmp",
    title: id,
    version: "test",
  };
}

function columns(db: DatabaseSync): Set<string> {
  return new Set(
    (db.prepare("pragma table_info(session)").all() as { name: string }[]).map((row) => row.name),
  );
}

it("二次软删除保留首次删除时间，且默认列表永不返回软删除行", async () => {
  const store = new SqliteSessionStore({ dbPath: ":memory:" });
  try {
    await store.createSession(sessionInput("s1"));
    await store.createSession(sessionInput("s2"));
    await store.softDeleteSession("s1" as SessionId, 1_000);
    await store.softDeleteSession("s1" as SessionId, 9_000);

    const deleted = await store.getSession("s1" as SessionId);
    assert.equal(deleted?.time.deleted, 1_000);
    assert.deepEqual(
      (await store.listSessions()).map((session) => session.id),
      ["s2"],
    );
    // 显式 ID 的普通列表语义相同：软删除行不因 includeArchived 旧开关复活。
    assert.deepEqual(
      (await store.listSessions({ includeArchived: true })).map((session) => session.id),
      ["s2"],
    );
  } finally {
    store.close();
  }
});

it("软删除保留正文，且 createSession 的 upsert 不会复活删除行", async () => {
  const store = new SqliteSessionStore({ dbPath: ":memory:" });
  try {
    await store.createSession(sessionInput("s1"));
    await store.saveMessage({
      id: "msg-1" as never,
      sessionID: "s1" as SessionId,
      role: "user",
      time: { created: 1, updated: 1 },
      data: { role: "user" },
    } as never);
    await store.softDeleteSession("s1" as SessionId, 1_000);

    assert.equal((await store.messages({ sessionID: "s1" as SessionId })).length, 1);

    await store.createSession({ ...sessionInput("s1"), title: "renamed" });
    const after = await store.getSession("s1" as SessionId);
    assert.equal(after?.title, "renamed");
    assert.equal(after?.time.deleted, 1_000);
    assert.deepEqual(await store.listSessions(), []);
  } finally {
    store.close();
  }
});

it("lastOutcome 三值往返，未知历史值按缺失读取", async () => {
  const store = new SqliteSessionStore({ dbPath: ":memory:" });
  try {
    await store.createSession(sessionInput("s1"));
    for (const outcome of ["completed", "error", "interrupted"] as const) {
      await store.updateSession({ id: "s1" as SessionId, lastOutcome: outcome });
      assert.equal((await store.getSession("s1" as SessionId))?.lastOutcome, outcome);
    }
    // 旧版本/其它实现写入的自由文本不能被读成「成功」。
    store["db"].prepare("update session set last_outcome = 'cancelled_by_user'").run();
    assert.equal((await store.getSession("s1" as SessionId))?.lastOutcome, undefined);
  } finally {
    store.close();
  }
});

it("0023 在列已存在的历史库上幂等，并仍写账本行", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-migration-0023-"));
  const dbPath = join(dir, "db.sqlite");
  try {
    // 首次启动写入 0023；随后抹掉账本行，模拟「列已存在但账本缺失」（上游 apply 守卫场景）。
    const store = new SqliteSessionStore({ dbPath });
    store.close();
    const db = new DatabaseSync(dbPath);
    db.prepare("delete from schema_migration where id = '0023_session_soft_delete_outcome'").run();
    db.close();

    const reopened = new SqliteSessionStore({ dbPath });
    try {
      const ledger = new DatabaseSync(dbPath);
      const applied = ledger
        .prepare(
          "select checksum from schema_migration where id = '0023_session_soft_delete_outcome'",
        )
        .get() as { checksum: string } | undefined;
      assert.ok(applied?.checksum);
      assert.deepEqual(
        [...columns(ledger)].filter((name) => name === "time_deleted" || name === "last_outcome"),
        ["time_deleted", "last_outcome"],
      );
      ledger.close();
      assert.deepEqual(await reopened.listSessions(), []);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

it("软删除只写 time_deleted 一列，不覆盖并发标题与上次结果", async () => {
  const store = new SqliteSessionStore({ dbPath: ":memory:" });
  try {
    await store.createSession(sessionInput("s1"));
    db(store).prepare("update session set title = 'custom', last_outcome = 'error'").run();
    softDeleteSession(db(store), "s1" as SessionId, 5_000);
    const session = await store.getSession("s1" as SessionId);
    assert.equal(session?.title, "custom");
    assert.equal(session?.lastOutcome, "error");
    assert.equal(session?.time.deleted, 5_000);
  } finally {
    store.close();
  }
});

function db(store: SqliteSessionStore): DatabaseSync {
  return (store as unknown as { db: DatabaseSync }).db;
}
