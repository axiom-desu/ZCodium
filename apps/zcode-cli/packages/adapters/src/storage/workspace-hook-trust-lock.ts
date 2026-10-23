import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, readFile, rm, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { uptime } from "node:os";
import { promisify } from "node:util";
import { isNodeError } from "./workspace-hook-trust-codec.js";

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const LOCK_RETRY_MS = 10;
// 进程启动时间的比较容差：ps/proc 的秒级精度 + 调度延迟，2s 足以覆盖且不放过复用。
const LOCK_START_TIME_TOLERANCE_MS = 2_000;
const PROC_CLOCK_TICKS_PER_SECOND = 100;

const execFileAsync = promisify(execFile);

interface LockOwnerMetadata {
  pid: number;
  token: string;
  /** 进程实例启动时间（墙钟 ms）；上一版锁格式无此字段（undefined）。 */
  startTime?: number;
}

interface FileWorkspaceHookTrustLockOptions {
  lockPath: string;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  probeProcessStartTime?: (pid: number) => Promise<number | null>;
  writeLockOwnerMetadata?: (handle: FileHandle, content: string) => Promise<void>;
}

async function defaultWriteLockOwnerMetadata(handle: FileHandle, content: string): Promise<void> {
  await handle.writeFile(content, "utf8");
}

/** 本进程启动时间的墙钟毫秒（惰性缓存：进程生命周期内不变）。 */
let ownStartTimeMs: number | undefined;
function currentProcessStartTimeMs(): number {
  if (ownStartTimeMs === undefined) {
    ownStartTimeMs = Math.round(Date.now() - uptime() * 1_000);
  }
  return ownStartTimeMs;
}

async function probeProcessStartTimeDefault(pid: number): Promise<number | null> {
  if (pid === process.pid) return currentProcessStartTimeMs();
  try {
    if (process.platform === "linux") {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      if (close < 0) return null;
      // ')' 之后 token[0] 是 state（字段 3）；starttime 是字段 22 → token[19]。
      const tokens = stat.slice(close + 2).split(" ");
      const ticks = Number(tokens[19]);
      if (!Number.isFinite(ticks)) return null;
      const bootMs = Date.now() - uptime() * 1_000;
      return Math.round(bootMs + (ticks * 1_000) / PROC_CLOCK_TICKS_PER_SECOND);
    }
    if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)]);
      const parsed = Date.parse(stdout.trim());
      return Number.isFinite(parsed) ? parsed : null;
    }
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-Command",
        `[DateTimeOffset]::new((Get-Process -Id ${pid}).StartTime).ToUnixTimeMilliseconds()`,
      ]);
      const parsed = Number(stdout.trim());
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  } catch {
    return null;
  }
}

export class FileWorkspaceHookTrustLock {
  private readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly probeProcessStartTime: (pid: number) => Promise<number | null>;
  private readonly writeLockOwnerMetadata: (handle: FileHandle, content: string) => Promise<void>;

  constructor(options: FileWorkspaceHookTrustLockOptions) {
    this.lockPath = options.lockPath;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    this.probeProcessStartTime = options.probeProcessStartTime ?? probeProcessStartTimeDefault;
    this.writeLockOwnerMetadata = options.writeLockOwnerMetadata ?? defaultWriteLockOwnerMetadata;
  }

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const { handle, token } = await this.acquireLock();
    try {
      return await operation();
    } finally {
      await handle.close().catch(() => undefined);
      // 释放前必须验证所有权。本进程的锁可能已被 stale 回收并归属
      // 新持有者；无条件 unlink 会删掉新持有者的锁，让后续 writer 与之并发
      // 进入临界区，造成基于旧快照的 read-modify-write 覆盖已提交的 revoke/grant。
      await this.releaseLockIfOwned(token);
    }
  }

  private async acquireLock(): Promise<{ handle: FileHandle; token: string }> {
    const startedAt = Date.now();
    while (true) {
      let handle: FileHandle | undefined;
      try {
        handle = await open(this.lockPath, "wx", 0o600);
        // 锁内容写入 pid + 进程启动时间 + 不可预测 owner token。
        // startTime 是进程实例标识——裸 pid 会被系统复用，仅凭
        // process.kill(pid, 0) 判活会把「崩溃后 pid 被复用」的锁误判为
        // 活 owner 而永不回收，revoke/grant 全部卡死。回收侧用 probe 比对
        // 当前实例启动时间与锁内记录来区分原 owner 与复用者。
        const token = randomUUID();
        const owner = `${JSON.stringify({
          pid: process.pid,
          startTime: currentProcessStartTimeMs(),
          token,
        })}\n`;
        await this.writeLockOwnerMetadata(handle, owner);
        return { handle, token };
      } catch (error) {
        // open(wx) 成功但 metadata 写失败（磁盘满等）时，必须关闭句柄
        // 并删除自己刚创建的锁——残留空锁会被后续 writer 当作无主锁回收，
        // 破坏互斥；这里只可能删掉自己 wx 独占创建的文件，无越权风险。
        if (handle) {
          await handle.close().catch(() => undefined);
          await unlink(this.lockPath).catch(() => undefined);
        }
        if (!isNodeError(error, "EEXIST")) throw error;
        await this.removeStaleLock();
        if (Date.now() - startedAt >= this.lockTimeoutMs) {
          throw new Error(`Timed out acquiring Workspace Hook Trust store lock: ${this.lockPath}`);
        }
        await delay(LOCK_RETRY_MS);
      }
    }
  }

  private async releaseLockIfOwned(token: string): Promise<void> {
    const owner = await this.readLockOwner();
    if (!owner || owner.token !== token) return;
    await unlink(this.lockPath).catch(() => undefined);
  }

  private async readLockOwner(): Promise<LockOwnerMetadata | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.lockPath, "utf8"));
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as { pid?: unknown }).pid === "number" &&
        typeof (parsed as { token?: unknown }).token === "string"
      ) {
        return {
          pid: (parsed as { pid: number }).pid,
          token: (parsed as { token: string }).token,
          startTime:
            typeof (parsed as { startTime?: unknown }).startTime === "number"
              ? (parsed as { startTime: number }).startTime
              : undefined,
        };
      }
      return null;
    } catch {
      // 旧版本空锁/损坏锁 → 无主。
      return null;
    }
  }

  private isProcessAlive(pid: number): boolean {
    if (pid === process.pid) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return isNodeError(error, "EPERM");
    }
  }

  private async removeStaleLock(): Promise<void> {
    try {
      const lockStats = await stat(this.lockPath);
      if (Date.now() - lockStats.mtimeMs <= this.staleLockMs) return;
      // 超龄但持有进程仍存活（休眠/调试暂停/杀毒拖慢 IO）→ 不回收。
      // mtime 无法区分"持有者死亡"与"持有者暂停或慢"；pid 存活检测可以。
      // 无法解析的锁（旧版空文件）无 pid 可查 → 按死亡回收。
      const owner = await this.readLockOwner();
      if (!owner) {
        await rm(this.lockPath, { force: true });
        return;
      }
      if (owner.pid === process.pid) return;
      if (!this.isProcessAlive(owner.pid)) {
        await rm(this.lockPath, { force: true });
        return;
      }
      // pid 存活 ≠ 原 owner 存活。pid 会被系统复用——原 owner 崩溃后
      // 其 pid 若被分配给无关长命进程，纯 kill(0) 判活会让锁永不回收，
      // revoke/grant 全部卡死。用进程实例启动时间核验：锁内记录的 startTime
      // 与该 pid 当前实例的实际启动时间一致 → 原 owner 确实活着（不回收）；
      // 不一致 → 原 owner 已死、pid 已易主（安全回收）。probe 不可用（平台
      // 不支持/查询失败）或锁记录无 startTime（上一版格式混存窗口）→ 保守
      // 视为原 owner 存活，不回收。
      const currentStart = await this.probeProcessStartTime(owner.pid);
      if (currentStart === null || owner.startTime === undefined) return;
      if (Math.abs(currentStart - owner.startTime) > LOCK_START_TIME_TOLERANCE_MS) {
        await rm(this.lockPath, { force: true });
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
