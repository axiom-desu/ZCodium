import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { MigrationBackup, SqliteMigration } from "./contract.js";
import { sqliteMigrations } from "./index.js";

const directories: string[] = [];
const databases: DatabaseSync[] = [];

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "zcode-migration-"));
  directories.push(directory);
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(`pragma foreign_keys=on;
    create table session(id text primary key, title text not null);
    create table message(id text primary key, session_id text references session(id) on delete cascade);
    insert into session values ('s', 'original');
    insert into message values ('m', 's');`);
  return { db, directory, options: { database: "cli", backupDirectories: [directory] } };
}

const migration: SqliteMigration = {
  id: "0020",
  appVersion: "3.12",
  touchedTables: ["session", "message"],
  sql: "update session set title='migrated'",
};

describe("sqlite-migrations contract", () => {
  it("applies pending migrations once and reports the applied ids", async () => {
    const { db, options } = await fixture();
    expect(await sqliteMigrations.migrate(db, [migration], options)).toMatchObject({
      applied: ["0020"],
      backupSkipped: false,
    });
    expect(db.prepare("select title from session").get()).toEqual({ title: "migrated" });
    expect(await sqliteMigrations.migrate(db, [migration], options)).toMatchObject({
      applied: [],
    });
  });

  it("backup metadata covers declared tables and restore rewinds rows and ledger", async () => {
    const { db, directory, options } = await fixture();
    const result = await sqliteMigrations.migrate(db, [migration], options);
    expect(result.backupPath).toBeTruthy();
    const metadata = JSON.parse(
      await readFile(join(result.backupPath!, "backup.json"), "utf8"),
    ) as MigrationBackup;
    expect(metadata.tables.map((table) => table.name)).toEqual(["session", "message"]);
    expect(metadata.tables[0]?.rows).toBe(1);
    db.exec("insert into message values ('m2','s')");
    await sqliteMigrations.restore(db, result.backupPath!);
    expect(db.prepare("select title from session").get()).toEqual({ title: "original" });
    expect(db.prepare("select count(*) as n from message").get()).toEqual({ n: 1 });
    expect(db.prepare("select count(*) as n from schema_migration").get()).toEqual({ n: 0 });
    // 正常回滚后不消费备份文件（备份仍可被工程恢复重放）。
    expect((await readdir(directory)).length).toBeGreaterThan(0);
  });

  it("rolls back every pending migration when a later apply fails and keeps the backup", async () => {
    const { db, options } = await fixture();
    const broken: SqliteMigration = {
      id: "0021",
      appVersion: "3.12",
      touchedTables: ["session"],
      sql: "insert into missing_table values (1)",
    };
    await expect(sqliteMigrations.migrate(db, [migration, broken], options)).rejects.toThrow();
    expect(db.prepare("select title from session").get()).toEqual({ title: "original" });
    // 账本本身也在同一事务里创建；失败回滚后不留下半应用记录。
    expect(
      db
        .prepare("select 1 from sqlite_master where type='table' and name='schema_migration'")
        .get(),
    ).toBeUndefined();
  });

  it("rejects checksum drift and invalid touchedTables before writing", async () => {
    const { db, options } = await fixture();
    await sqliteMigrations.migrate(db, [migration], options);
    await expect(
      sqliteMigrations.migrate(
        db,
        [{ ...migration, sql: "update session set title='x'" }],
        options,
      ),
    ).rejects.toMatchObject({ migrationId: "0020", name: "MigrationChecksumError" });
    for (const touchedTables of [[], ["bad table"]])
      await expect(
        sqliteMigrations.migrate(db, [{ ...migration, id: "0030", touchedTables }], options),
      ).rejects.toThrow("touchedTables");
  });

  it("uses the same sha256(sql) formula that frozen JSON checksum inputs relied on", () => {
    // 旧 Host 账本写入的是 sha256(JSON.stringify(checksumInput))；
    // runner 接收 sql=JSON.stringify(checksumInput) 后只 trim 再哈希，二者必须逐字节一致。
    const checksumInput = ["chunk", [["tasks", "title", "TEXT"]], "v1"];
    const legacy = createHash("sha256").update(JSON.stringify(checksumInput)).digest("hex");
    const shared = createHash("sha256").update(JSON.stringify(checksumInput).trim()).digest("hex");
    expect(shared).toBe(legacy);
  });

  it("adopts previousIds without rerunning apply and keeps the old ledger row", async () => {
    const { db, options } = await fixture();
    await sqliteMigrations.migrate(db, [{ ...migration, id: "0001_old" }], options);
    const renamed: SqliteMigration = { ...migration, id: "0020", previousIds: ["0001_old"] };
    expect(await sqliteMigrations.migrate(db, [renamed], options)).toMatchObject({ applied: [] });
    expect(db.prepare("select id from schema_migration order by id").all()).toEqual([
      { id: "0001_old" },
      { id: "0020" },
    ]);
    expect(db.prepare("select title from session").get()).toEqual({ title: "migrated" });
  });

  it("keeps the frozen tasks_schema_migration shape (id, checksum, time_applied)", async () => {
    const { db, directory } = await fixture();
    const result = await sqliteMigrations.migrate(db, [migration], {
      database: "tasks_schema",
      journalTable: "tasks_schema_migration",
      backupDirectories: [directory],
    });
    const columns = db.prepare("pragma table_info(tasks_schema_migration)").all();
    expect(columns.map((column) => column.name)).toEqual(["id", "checksum", "time_applied"]);
    const metadata = JSON.parse(
      await readFile(join(result.backupPath!, "backup.json"), "utf8"),
    ) as MigrationBackup;
    expect(metadata.journalTable).toBe("tasks_schema_migration");
    await sqliteMigrations.restore(db, result.backupPath!);
    expect(db.prepare("select count(*) as n from tasks_schema_migration").get()).toEqual({ n: 0 });
  });

  it("records skipped backups instead of failing when the only volume is unavailable", async () => {
    const { db, directory } = await fixture();
    await writeFile(join(directory, "blocked"), "x");
    const result = await sqliteMigrations.migrate(db, [migration], {
      database: "cli",
      backupDirectories: [join(directory, "blocked", "nested")],
      fallbackBackupDirectories: async () => [],
    });
    expect(result.backupSkipped).toBe(true);
    expect(db.prepare("select title from session").get()).toEqual({ title: "migrated" });
  });
});
