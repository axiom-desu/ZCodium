import type { SqliteMigrationsContract } from "./contract.js";
import { migrate } from "./runner.js";
import { restore } from "./restore.js";

export type {
  MigrationBackup,
  MigrationBackupTable,
  MigrationOptions,
  MigrationResult,
  SqliteMigration,
  SqliteMigrationsContract,
} from "./contract.js";
export { MigrationChecksumError } from "./contract.js";
export const sqliteMigrations: SqliteMigrationsContract = { migrate, restore };
