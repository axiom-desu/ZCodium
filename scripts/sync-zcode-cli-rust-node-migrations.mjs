// Keep Rust's embedded historical SQL byte-identical to the CLI Node migration ledger.
import { readFile, writeFile } from "node:fs/promises";
import { SQLITE_MIGRATIONS } from "../apps/zcode-cli/packages/adapters/src/storage/session-store/migrations.ts";

const migrationDirectory = new URL(
  "../apps/zcode-cli-rust/crates/state/src/node/migrations/",
  import.meta.url,
);
for (const migration of SQLITE_MIGRATIONS) {
  const path = new URL(`${migration.id}.sql`, migrationDirectory);
  if (process.argv.includes("--check")) {
    if ((await readFile(path, "utf8")) !== migration.sql)
      throw new Error(`${migration.id}.sql differs from TS; regenerate it`);
  } else await writeFile(path, migration.sql);
}
