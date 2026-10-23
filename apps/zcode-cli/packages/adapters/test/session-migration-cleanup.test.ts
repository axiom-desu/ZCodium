import assert from "node:assert/strict";
import { it } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS,
  runSqliteSessionMigrationsAsync,
} from "../src/storage/session-store/migration-runner.js";

const ASYNC_BUSY_TIMEOUT_SQL = "pragma busy_timeout = 25";
const RESTORE_BUSY_TIMEOUT_SQL = `pragma busy_timeout = ${DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS}`;

/**
 * 迁移连接在 finally 里恢复 busy_timeout。这里让「迁移失败」和「恢复失败」同时发生，
 * 用来锁定 finally 中清理异常不得覆盖原迁移异常（清理只在原操作成功时才是首因）。
 */
function failingDb(primaryFailure: unknown, cleanupFailure: Error): DatabaseSync {
  return {
    exec(sql: string) {
      if (sql === ASYNC_BUSY_TIMEOUT_SQL) return;
      if (sql === RESTORE_BUSY_TIMEOUT_SQL) throw cleanupFailure;
      throw primaryFailure;
    },
  } as unknown as DatabaseSync;
}

async function captureRejection(run: () => Promise<void>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to reject");
}

it("finally 清理失败不能覆盖原迁移异常", async () => {
  const primaryFailure = new Error("primary migration failure");
  const cleanupFailure = new Error("busy_timeout restore failure");
  const db = failingDb(primaryFailure, cleanupFailure);

  const thrown = await captureRejection(() => runSqliteSessionMigrationsAsync(db, ":memory:"));

  // 迁移初始化会把原异常规范成 SqliteSessionMigrationError；首因保留在 cause 上。
  assert.ok(thrown instanceof Error);
  assert.equal((thrown as Error & { cause?: unknown }).cause, primaryFailure);
  assert.notEqual(thrown, cleanupFailure);
});

it("falsy 原迁移异常（throw null）仍然优先于 finally 清理失败", async () => {
  const cleanupFailure = new Error("busy_timeout restore failure");
  const db = failingDb(null, cleanupFailure);

  const thrown = await captureRejection(() => runSqliteSessionMigrationsAsync(db, ":memory:"));

  // 迁移初始化会把原始值规范成 SqliteSessionMigrationError，但其 cause 仍是原来的 null，
  // 而 finally 里的恢复失败只是清理异常，不能顶替首因。
  assert.ok(thrown instanceof Error);
  assert.match(thrown.message, /SQLite migration initialization failed/);
  assert.equal((thrown as Error & { cause?: unknown }).cause, null);
  assert.notEqual(thrown, cleanupFailure);
});
