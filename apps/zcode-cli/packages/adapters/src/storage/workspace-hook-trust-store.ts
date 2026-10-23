import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION,
  workspaceHookTrustRecordSchema,
  workspaceHookTrustStoreFileSchema,
  type WorkspaceHookTrustRecord,
  type WorkspaceHookTrustStoreFile,
} from "@zcode/contracts";
import { isNodeError, isRecord, recordTimestamp, trustKey } from "./workspace-hook-trust-codec.js";
import {
  FileWorkspaceHookTrustFile,
  SECURITY_DIRECTORY,
  TRUST_STORE_FILE,
} from "./workspace-hook-trust-file.js";
import { FileWorkspaceHookTrustLock } from "./workspace-hook-trust-lock.js";
import type {
  FileWorkspaceHookTrustStoreOptions,
  WorkspaceHookTrustStoreCompactOptions,
  WorkspaceHookTrustStoreLoadResult,
  WorkspaceHookTrustStorePathOptions,
  WorkspaceHookTrustStoreRevokeOptions,
} from "./workspace-hook-trust-types.js";

export type {
  FileWorkspaceHookTrustStoreOptions,
  WorkspaceHookTrustStoreCompactOptions,
  WorkspaceHookTrustStoreLoadResult,
  WorkspaceHookTrustStorePathOptions,
  WorkspaceHookTrustStoreRevokeOptions,
} from "./workspace-hook-trust-types.js";

export async function resolveWorkspaceHookTrustStorePath(
  options: WorkspaceHookTrustStorePathOptions = {},
): Promise<string> {
  const home = resolve(options.homeDir ?? homedir());
  const userConfigPath = resolve(
    options.userConfigPath ?? join(home, ".zcodium", "cli", "config.json"),
  );
  const config = await readUserConfig(userConfigPath);
  const storage = isRecord(config.storage) ? config.storage : {};
  const configured = typeof storage.dir === "string" ? storage.dir.trim() : "";
  const storageRoot = configured
    ? resolveTrustedUserPath(configured, home)
    : join(home, ".zcodium");
  return join(storageRoot, SECURITY_DIRECTORY, TRUST_STORE_FILE);
}

export async function createDefaultFileWorkspaceHookTrustStore(
  options: WorkspaceHookTrustStorePathOptions &
    Omit<FileWorkspaceHookTrustStoreOptions, "filePath"> = {},
): Promise<FileWorkspaceHookTrustStore> {
  return createFileWorkspaceHookTrustStore({
    ...options,
    filePath: await resolveWorkspaceHookTrustStorePath(options),
  });
}

export function createFileWorkspaceHookTrustStore(
  options: FileWorkspaceHookTrustStoreOptions,
): FileWorkspaceHookTrustStore {
  return new FileWorkspaceHookTrustStore(options);
}

export class FileWorkspaceHookTrustStore {
  private readonly file: FileWorkspaceHookTrustFile;
  private readonly lock: FileWorkspaceHookTrustLock;
  private readonly now: () => number;
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(options: FileWorkspaceHookTrustStoreOptions) {
    this.file = new FileWorkspaceHookTrustFile(options);
    this.now = options.now ?? Date.now;
    this.lock = new FileWorkspaceHookTrustLock({
      lockPath: this.file.lockPath,
      lockTimeoutMs: options.lockTimeoutMs,
      staleLockMs: options.staleLockMs,
      probeProcessStartTime: options.probeProcessStartTime,
      writeLockOwnerMetadata: options.writeLockOwnerMetadata,
    });
  }

  load(): Promise<WorkspaceHookTrustStoreLoadResult> {
    return this.enqueue(async () => {
      await this.file.ensureSecurityDirectory();
      return this.lock.runExclusive(() => this.file.readCurrent(true));
    });
  }

  grant(records: readonly WorkspaceHookTrustRecord[]): Promise<WorkspaceHookTrustStoreFile> {
    const validated = records.map((record) => workspaceHookTrustRecordSchema.parse(record));
    return this.mutate((current) => {
      const next = new Map(current.records.map((record) => [trustKey(record), record] as const));
      for (const record of validated) next.set(trustKey(record), record);
      return {
        schemaVersion: WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION,
        records: [...next.values()],
      };
    });
  }

  revoke(options: WorkspaceHookTrustStoreRevokeOptions): Promise<WorkspaceHookTrustStoreFile> {
    if (options.hookDeclarationDigests?.length === 0) {
      // 空数组会生成空 Set，filter 因而保留全部记录并静默成功，调用方无法
      // 区分“撤销全部”的 undefined 与“没有目标”的无效请求。三态固定为：undefined
      // 撤销 workspace 全部、非空数组精确撤销、空数组在任何 IO 前拒绝。
      return Promise.reject(new Error("hookDeclarationDigests must be undefined or non-empty"));
    }
    const selected = options.hookDeclarationDigests
      ? new Set(options.hookDeclarationDigests)
      : undefined;
    return this.mutate((current) => ({
      schemaVersion: WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION,
      records: current.records.filter(
        (record) =>
          record.workspaceIdentity !== options.workspaceIdentity ||
          (selected !== undefined && !selected.has(record.hookDeclarationDigest)),
      ),
    }));
  }

  touch(input: {
    workspaceIdentity: string;
    hookDeclarationDigests: readonly string[];
    usedAt?: string;
  }): Promise<WorkspaceHookTrustStoreFile> {
    const selected = new Set(input.hookDeclarationDigests);
    const usedAt = input.usedAt ?? new Date(this.now()).toISOString();
    return this.mutate((current) => ({
      schemaVersion: WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION,
      records: current.records.map((record) =>
        record.workspaceIdentity === input.workspaceIdentity &&
        selected.has(record.hookDeclarationDigest)
          ? { ...record, lastUsedAt: usedAt }
          : record,
      ),
    }));
  }

  compact(options: WorkspaceHookTrustStoreCompactOptions): Promise<WorkspaceHookTrustStoreFile> {
    if (!Number.isFinite(options.maxAgeMs) || options.maxAgeMs < 0) {
      throw new Error("maxAgeMs must be a nonnegative finite number");
    }
    if (!Number.isInteger(options.maxRecords) || options.maxRecords < 1) {
      throw new Error("maxRecords must be a positive integer");
    }
    const now = options.now ?? this.now();
    const current = new Set(
      options.current.map((entry) =>
        trustKey({
          workspaceIdentity: entry.workspaceIdentity,
          hookDeclarationDigest: entry.hookDeclarationDigest,
        }),
      ),
    );
    return this.mutate((store) => {
      const retained = store.records.filter((record) => {
        if (current.has(trustKey(record))) return true;
        const timestamp = Date.parse(record.lastUsedAt ?? record.grantedAt);
        return Number.isFinite(timestamp) && now - timestamp <= options.maxAgeMs;
      });
      const currentRecords = retained.filter((record) => current.has(trustKey(record)));
      const nonCurrent = retained
        .filter((record) => !current.has(trustKey(record)))
        .sort((left, right) => recordTimestamp(right) - recordTimestamp(left));
      const available = Math.max(0, options.maxRecords - currentRecords.length);
      return {
        schemaVersion: WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION,
        records: [...currentRecords, ...nonCurrent.slice(0, available)],
      };
    });
  }

  private mutate(
    update: (current: WorkspaceHookTrustStoreFile) => WorkspaceHookTrustStoreFile,
  ): Promise<WorkspaceHookTrustStoreFile> {
    return this.enqueue(async () => {
      await this.file.ensureSecurityDirectory();
      return this.lock.runExclusive(async () => {
        const loaded = await this.file.readCurrent(true);
        const current: WorkspaceHookTrustStoreFile = {
          schemaVersion: WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION,
          records: loaded.status === "ok" ? loaded.records : [],
        };
        const next = workspaceHookTrustStoreFileSchema.parse(update(current));
        await this.file.atomicWrite(next);
        return next;
      });
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

async function readUserConfig(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return {};
    throw new Error(`Unable to read trusted user config for Workspace Hook Trust store: ${path}`, {
      cause: error,
    });
  }
}

function resolveTrustedUserPath(path: string, home: string): string {
  if (path.startsWith("~/")) return join(home, path.slice(2));
  if (isAbsolute(path)) return resolve(path);
  // 安全原因：user config 中的相对 storage.dir 绑定用户目录，不能随 workspace cwd 漂移。
  return resolve(home, path);
}
