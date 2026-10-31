/**
 * sqlite-migrations 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { DatabaseSync } from "node:sqlite";
import type { SqliteMigrationsContract } from "./contract.js";

export async function exampleSqliteMigration(
  port: SqliteMigrationsContract,
  db: DatabaseSync,
  backupDirectory: string,
): Promise<string[]> {
  const result = await port.migrate(
    db,
    [
      {
        id: "0001_example",
        appVersion: "3.16.2",
        sql: "create table if not exists example(id text primary key)",
        touchedTables: ["example"],
      },
    ],
    { database: "example", backupDirectories: [backupDirectory] },
  );
  return result.applied;
}
