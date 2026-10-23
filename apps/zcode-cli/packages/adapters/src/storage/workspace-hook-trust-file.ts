import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  workspaceHookTrustStoreFileSchema,
  type WorkspaceHookTrustStoreFile,
} from "@zcode/contracts";
import { isNodeError } from "./workspace-hook-trust-codec.js";
import type {
  FileWorkspaceHookTrustStoreOptions,
  WorkspaceHookTrustStoreLoadResult,
} from "./workspace-hook-trust-types.js";

export const SECURITY_DIRECTORY = "security";
export const TRUST_STORE_FILE = "workspace-hook-trust-v1.json";
const DEFAULT_RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800] as const;

export class FileWorkspaceHookTrustFile {
  readonly filePath: string;
  private readonly now: () => number;
  private readonly beforeRename?: () => void | Promise<void>;
  private readonly renameFile: typeof rename;
  private readonly renameRetryDelaysMs: readonly number[];

  constructor(options: FileWorkspaceHookTrustStoreOptions) {
    this.filePath = resolve(options.filePath);
    this.now = options.now ?? Date.now;
    this.beforeRename = options.beforeRename;
    this.renameFile = options.renameFile ?? rename;
    this.renameRetryDelaysMs = options.renameRetryDelaysMs ?? DEFAULT_RENAME_RETRY_DELAYS_MS;
  }

  get lockPath(): string {
    return `${this.filePath}.lock`;
  }

  async ensureSecurityDirectory(): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }

  async readCurrent(recoverCorrupt: boolean): Promise<WorkspaceHookTrustStoreLoadResult> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return { status: "missing", records: [] };
      throw error;
    }

    try {
      const parsed = workspaceHookTrustStoreFileSchema.parse(JSON.parse(content) as unknown);
      // chmod 是权限加固副作用，不是 load 的核心职责。只读目录/异常所有权下
      // chmod 会抛 EPERM/EROFS，若任其冒泡，整个 load 都会失败——比一次加固失败
      // 应有的后果重得多。加固失败只降级为忽略：读出来的记录仍然有效，
      // 后续 mutate 的 atomicWrite 会再次尝试。
      await chmod(this.filePath, 0o600).catch(() => undefined);
      return { status: "ok", records: parsed.records };
    } catch (error) {
      if (!recoverCorrupt) throw error;
      const recoveredCorruptPath = `${this.filePath}.corrupt-${this.now()}`;
      // 损坏文件改名失败（只读目录等）若让错误冒泡，会绕过"返回 corrupt 状态"
      // 的设计路径——调用方看到的是意外异常而非 fail-closed 的 corrupt 状态。
      // 改名失败仍按 corrupt 返回：corrupt 语义即全部 Hook 不受信（fail-closed），
      // 原文件残留在原地不会让任何记录被当作可信。
      try {
        await rename(this.filePath, recoveredCorruptPath);
        await chmod(recoveredCorruptPath, 0o600).catch(() => undefined);
      } catch {
        // 改名失败：仍返回 corrupt 状态，原损坏文件留在原地（下次 load 仍判 corrupt）。
      }
      return { status: "corrupt", records: [], recoveredCorruptPath };
    }
  }

  async atomicWrite(store: WorkspaceHookTrustStoreFile): Promise<void> {
    const directory = dirname(this.filePath);
    const tempPath = join(
      directory,
      `.${basename(this.filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(tempPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(store, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.beforeRename?.();
      await renameWithRetry(this.renameFile, tempPath, this.filePath, this.renameRetryDelaysMs);
      await chmod(this.filePath, 0o600);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

async function renameWithRetry(
  renameFile: typeof rename,
  tempPath: string,
  filePath: string,
  retryDelaysMs: readonly number[],
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameFile(tempPath, filePath);
      return;
    } catch (error) {
      const delayMs = retryDelaysMs[attempt];
      if (delayMs === undefined || !isRetryableRenameError(error)) throw error;
      // Windows 杀软/索引器可能短暂占用目标文件，单次 rename 会让已完成
      // fsync 的 Trust mutation 误报失败。仅对已知短暂占用错误做有界异步重试。
      await sleep(delayMs);
    }
  }
}

function isRetryableRenameError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}
