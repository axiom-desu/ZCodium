import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { sqliteMigrations, type SqliteMigration } from "@zcode/shared/sqlite-migrations";

const resources: Array<{ db: DatabaseSync; directory: string }> = [];
afterEach(async () => {
  for (const { db, directory } of resources.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "zcode-migration-rollback-"));
  const db = new DatabaseSync(join(directory, "db.sqlite"));
  resources.push({ db, directory });
  db.exec("CREATE TABLE seed(id TEXT PRIMARY KEY)");
  return { db, directory };
}

function migrations(apply: () => void): SqliteMigration[] {
  return [
    {
      id: "0001_fixture",
      appVersion: "1.0.0",
      sql: "CREATE TABLE fixture(id TEXT PRIMARY KEY);",
      touchedTables: ["seed"],
      apply,
    },
  ];
}

describe("sqlite migration failure ownership", () => {
  it("keeps the migration error when rollback also fails", async () => {
    const { db, directory } = await fixture();
    const original = db.exec.bind(db);
    db.exec = ((sql: string) => {
      if (sql.toLowerCase() === "rollback")
        throw Object.assign(new Error("rollback eio"), { code: "EIO" });
      return original(sql);
    }) as typeof db.exec;
    const primary = Object.assign(new Error("migration enospc"), { migrationId: "0001_fixture" });
    const rejection = await sqliteMigrations
      .migrate(
        db,
        migrations(() => {
          throw primary;
        }),
        { database: "fixture", backupDirectories: [join(directory, "backup")] },
      )
      .catch((error: unknown) => error);
    expect(rejection).toBe(primary);
    expect((rejection as { rollbackFailure?: string }).rollbackFailure).toBe("EIO");
  });

  it("rethrows falsy primary values without substituting the rollback error", async () => {
    const { db, directory } = await fixture();
    const original = db.exec.bind(db);
    db.exec = ((sql: string) => {
      if (sql.toLowerCase() === "rollback") throw new Error("rollback failure");
      return original(sql);
    }) as typeof db.exec;
    const rejection = await sqliteMigrations
      .migrate(
        db,
        migrations(() => {
          throw 0;
        }),
        { database: "fixture", backupDirectories: [join(directory, "backup")] },
      )
      .catch((error: unknown) => error);
    expect(rejection).toBe(0);
  });
});
