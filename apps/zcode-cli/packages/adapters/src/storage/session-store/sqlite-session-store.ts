import { DatabaseSync } from "node:sqlite";
import type {
  CreateSessionInput,
  ForkChildSessionMetadata,
  ForkCommitBundle,
  InputHistoryStorePort,
  LocalSettingStorePort,
  ScriptWorkflowStorePort,
  SessionInfo,
  SessionStorePort,
  SharedContextImportCommitBundle,
  SharedContextImportTransition,
  UsageStorePort,
} from "@zcode/contracts";
import { maybeThrowStorageFsFault } from "../fs-fault-injection.js";
import { SqliteSessionMigrationError } from "./errors.js";
import {
  commitForkBundle,
  commitSharedContextImportBundle,
  createForkedSessionWithMetadata,
  validateForkBundle,
  validateForkChildMetadata,
  validateSharedContextImportBundle,
} from "./fork-commit.js";
import {
  DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS,
  runSqliteSessionMigrations,
  runSqliteSessionMigrationsAsync,
  type AsyncSqliteMigrationOptions,
} from "./migration-runner.js";
import type { ForkCommitFaultStage, SqliteSessionStoreOptions } from "./options.js";
import { ensureParentDir, getDefaultSessionDbPath } from "./paths.js";
import * as messageRepository from "./repositories/messages.js";
import * as sessionEntryRepository from "./repositories/session-entries.js";
import { UsageWorkflowSurface } from "./usage-workflow-surface.js";

const deferredStartup = Symbol("deferredSqliteStartup");

export class SqliteSessionStore
  extends UsageWorkflowSurface
  implements
    SessionStorePort,
    InputHistoryStorePort,
    LocalSettingStorePort,
    ScriptWorkflowStorePort,
    UsageStorePort
{
  private readonly forkCommitFaultAt?: ForkCommitFaultStage;

  constructor(options: SqliteSessionStoreOptions = {}, startupToken?: symbol) {
    const dbPath = options.dbPath ?? getDefaultSessionDbPath();
    const startupLockTimeoutMs =
      options.startupLockTimeoutMs ?? DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS;
    let db: DatabaseSync;
    try {
      ensureParentDir(dbPath);
      maybeThrowStorageFsFault({ operation: "sqliteOpen", path: dbPath });
      // 多个本地或远程 Agent 会共享同一个 session DB；timeout 必须在执行首条
      // PRAGMA 前生效，否则并发启动会在 migration prelude 直接抛 database is locked。
      db = new DatabaseSync(dbPath, { timeout: startupLockTimeoutMs });
    } catch (error) {
      throw new SqliteSessionMigrationError(`Failed to open SQLite session database at ${dbPath}`, {
        cause: error,
        dbPath,
        kind: "open_failed",
      });
    }
    super(db, dbPath);
    this.forkCommitFaultAt = options.forkCommitFaultAt;
    try {
      if (startupToken !== deferredStartup)
        runSqliteSessionMigrations(this.db, this.dbPath, startupLockTimeoutMs);
    } catch (error) {
      try {
        this.db.close();
      } catch {
        /* 保留原始迁移失败。 */
      }
      throw error;
    }
  }

  static async openStartup(
    options: SqliteSessionStoreOptions = {},
    migrationOptions: AsyncSqliteMigrationOptions = {},
  ): Promise<SqliteSessionStore> {
    // 未迁移的实例只保留在这个工厂内部；所有 Repo/业务只可能拿到 COMMIT 后的连接。
    const store = new SqliteSessionStore(options, deferredStartup);
    try {
      await runSqliteSessionMigrationsAsync(store.db, store.dbPath, migrationOptions);
      return store;
    } catch (error) {
      // close 也可能因 IO 失败；迁移的原始 cause 才是用户应处理的原因。
      try {
        store.close();
      } catch {
        /* 保留原始迁移失败。 */
      }
      throw error;
    }
  }

  getDatabasePath(): string {
    return this.dbPath;
  }

  close(): void {
    this.db.close();
  }

  private maybeThrowForkCommitFault(stage: ForkCommitFaultStage): void {
    if (this.forkCommitFaultAt === stage) {
      throw new Error(`injected fork commit fault: ${stage}`);
    }
  }

  // 本类仍是唯一事务边界：validation 在 begin 前完成，body helper 不自行 commit/rollback。
  // 同步 body（legacy fork）仍在同一调用栈内 commit，不额外让出事件循环。
  private runImmediateTransaction<T>(operation: () => T | Promise<T>): T | Promise<T> {
    this.db.exec("begin immediate");
    try {
      const result = operation();
      if (isPromise(result)) {
        return result.then(
          (value) => {
            try {
              this.db.exec("commit");
              return value;
            } catch (error) {
              this.db.exec("rollback");
              throw error;
            }
          },
          (error) => {
            this.db.exec("rollback");
            throw error;
          },
        );
      }
      this.db.exec("commit");
      return result;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  async createForkedSessionWithMetadata(
    input: CreateSessionInput,
    metadata: ForkChildSessionMetadata,
  ): Promise<SessionInfo> {
    this.throwBeforeWrite();
    const { entryId, parentID } = validateForkChildMetadata(input, metadata);
    return this.runImmediateTransaction(() =>
      createForkedSessionWithMetadata(this.db, input, metadata, entryId, parentID),
    );
  }

  async commitForkBundle(bundle: ForkCommitBundle): Promise<SessionInfo> {
    this.throwBeforeWrite();
    const { entryId, parentID } = validateForkBundle(bundle);
    return this.runImmediateTransaction(() =>
      commitForkBundle(this.db, bundle, entryId, parentID, (stage) =>
        this.maybeThrowForkCommitFault(stage),
      ),
    );
  }

  async commitSharedContextImportBundle(
    bundle: SharedContextImportCommitBundle,
  ): Promise<SessionInfo> {
    this.throwBeforeWrite();
    validateSharedContextImportBundle(bundle);
    return this.runImmediateTransaction(() => commitSharedContextImportBundle(this.db, bundle));
  }

  async transitionSharedContextImport(input: SharedContextImportTransition): Promise<boolean> {
    this.throwBeforeWrite();
    this.db.exec("begin immediate");
    try {
      const entry = sessionEntryRepository
        .sessionEntries(this.db, { sessionID: input.sessionID, type: "v4/shared_context_import" })
        .find((candidate) => {
          const data = candidate.data;
          return Boolean(
            data &&
            typeof data === "object" &&
            !Array.isArray(data) &&
            (data as Record<string, unknown>).contextId === input.contextId,
          );
        });
      if (!entry) {
        this.db.exec("rollback");
        return false;
      }
      const data = entry.data as Record<string, unknown>;
      const expected = Array.isArray(input.expectedStatus)
        ? input.expectedStatus
        : [input.expectedStatus];
      if (!expected.includes(data.status as SharedContextImportTransition["status"])) {
        this.db.exec("rollback");
        return false;
      }
      sessionEntryRepository.saveSessionEntry(this.db, {
        ...entry,
        time: { ...entry.time, updated: Date.now() },
        data: {
          ...data,
          status: input.status,
          ...(input.sourceId ? { sourceId: input.sourceId } : {}),
        },
      });
      const contextMessage = (
        await messageRepository.messages(this.db, { sessionID: input.sessionID })
      ).find((message) => {
        const metadata = message.info.metadata;
        return Boolean(
          metadata &&
          typeof metadata === "object" &&
          (metadata as Record<string, unknown>).contextId === input.contextId,
        );
      });
      if (contextMessage) {
        await messageRepository.saveMessage(this.db, {
          ...contextMessage.info,
          metadata: {
            ...contextMessage.info.metadata,
            sharedContextStatus: input.status,
          },
        });
      }
      this.db.exec("commit");
      return true;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return value instanceof Promise;
}

export function createSqliteSessionStore(
  options: SqliteSessionStoreOptions = {},
): SqliteSessionStore {
  return new SqliteSessionStore(options);
}

export function openStartupSqliteSessionStore(
  options: SqliteSessionStoreOptions = {},
): SqliteSessionStore {
  return new SqliteSessionStore(options);
}

export { getDefaultSessionDbPath };
