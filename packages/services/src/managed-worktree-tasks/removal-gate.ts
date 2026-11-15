import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/** 受管 worktree 生命周期租约的两种语义：创建中与删除中，同一目录互斥。 */
type WorktreeLeaseKind = "creating" | "removing";

interface WorktreeLease {
  acquired: true;
  kind: WorktreeLeaseKind;
  release(): Promise<void>;
}

interface WorktreeLeaseHeld {
  acquired: false;
  /** 持有者类型；无法解析/无法证明已死的租约返回 null（保守拒绝）。 */
  heldBy: WorktreeLeaseKind | null;
}

type WorktreeLeaseResult = WorktreeLease | WorktreeLeaseHeld;

/**
 * 跨 Host（跨进程）的 worktree 创建/删除租约。
 *
 * 每个窗口 Host 是独立进程，进程内 Set 不是全局事实：另一个窗口可以删除刚建好、
 * 还没来得及登记任务的目录。这里用 `<dataBaseDir>/.zcode/worktree-leases` 下的
 * 文件锁实现真正的跨进程互斥：
 * - per-worktree：`creating` 与 `removing` 互斥；
 * - per-source：create 的“建目录 → 取得 per-worktree 租约”窗口与 remove 互斥，
 *   防止另一个 Host 删除尚未登记的新目录。
 *
 * 锁文件用“临时文件写完整 JSON → link() 原子发布”，因此读到的一定是完整持有者信息。
 * 残留租约只在持有 pid 已退出时回收；没有超时/重试猜测，无法证明时按持有处理。
 */
export interface WorktreeLeaseGate {
  acquireWorktree(input: {
    worktreeRoot: string;
    kind: WorktreeLeaseKind;
  }): Promise<WorktreeLeaseResult>;
  acquireSource(input: {
    sourceRoot: string;
    kind: WorktreeLeaseKind;
  }): Promise<WorktreeLeaseResult>;
  /** 只读：当前是否有活着的进程持有该目录租约； stale/不存在返回 null。 */
  readWorktree(worktreeRoot: string): Promise<{ kind: WorktreeLeaseKind; pid: number } | null>;
}

interface LeaseFile {
  pid: number;
  token: string;
  kind: WorktreeLeaseKind;
  key: string;
  at: number;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM 说明进程存在但不是同一用户可发信号的权限；仍按存活处理。
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function leaseKinds(value: unknown): WorktreeLeaseKind | null {
  return value === "creating" || value === "removing" ? value : null;
}

export function createWorktreeLeaseGate(options: { dataBaseDir: () => string }): WorktreeLeaseGate {
  const leaseDirectory = () => join(options.dataBaseDir(), ".zcode", "worktree-leases");

  /** 同一路径在不同 Host 必须得到同一个 key；Windows 大小写不敏感路径统一小写。 */
  const normalizeKey = (key: string): string => {
    const resolved = resolve(key);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const leaseFile = (key: string) =>
    join(leaseDirectory(), `${createHash("sha256").update(key).digest("hex")}.lease`);

  const readLease = async (path: string): Promise<LeaseFile | null> => {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<LeaseFile>;
      if (
        typeof parsed.pid !== "number" ||
        typeof parsed.token !== "string" ||
        typeof parsed.at !== "number"
      )
        return null;
      return {
        pid: parsed.pid,
        token: parsed.token,
        kind: leaseKinds(parsed.kind) ?? "creating",
        key: typeof parsed.key === "string" ? parsed.key : "",
        at: parsed.at,
      };
    } catch {
      return null;
    }
  };

  const acquire = async (key: string, kind: WorktreeLeaseKind): Promise<WorktreeLeaseResult> => {
    const path = leaseFile(key);
    try {
      await mkdir(leaseDirectory(), { recursive: true });
    } catch {
      // 无法建立租约目录时不能假装取得租约；按“无法证明”保守拒绝。
      return { acquired: false, heldBy: null };
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = randomUUID();
      const tempPath = `${path}.${process.pid}.${token}.tmp`;
      try {
        await writeFile(
          tempPath,
          JSON.stringify({
            pid: process.pid,
            token,
            kind,
            key,
            at: Date.now(),
          } satisfies LeaseFile),
        );
        let conflict = false;
        try {
          await link(tempPath, path);
        } catch (error) {
          conflict = true;
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "EEXIST") {
            // 不支持硬链接的文件系统：退化为排他创建 + 写入；读者把不完整内容按持有处理。
            try {
              const handle = await open(path, "wx");
              try {
                await handle.writeFile(
                  JSON.stringify({
                    pid: process.pid,
                    token,
                    kind,
                    key,
                    at: Date.now(),
                  } satisfies LeaseFile),
                );
              } finally {
                await handle.close();
              }
              conflict = false;
            } catch (fallbackError) {
              if ((fallbackError as NodeJS.ErrnoException).code !== "EEXIST") {
                // 无法写入租约：不释放、不猜测，交给调用方按保守拒绝处理。
                return { acquired: false, heldBy: null };
              }
              // 竞争失败：走与 link EEXIST 相同的持有者判断，不能删除别人的锁。
              conflict = true;
            }
          }
        }
        if (conflict) {
          const holder = await readLease(path);
          if (holder && isPidAlive(holder.pid)) {
            return { acquired: false, heldBy: holder.kind };
          }
          if (!holder) {
            // 锁文件在 EEXIST 与读取之间消失：重新竞争。
            continue;
          }
          // 持有进程已退出：回收残留租约后重试（不是超时，而是进程事实）。
          await rm(path, { force: true }).catch(() => undefined);
          continue;
        }
        return {
          acquired: true,
          kind,
          release: async () => {
            const current = await readLease(path);
            // 只释放自己持有的租约；被回收后重新取得的租约不能误删。
            if (current?.token === token) await rm(path, { force: true }).catch(() => undefined);
          },
        };
      } finally {
        await rm(tempPath, { force: true }).catch(() => undefined);
      }
    }
    return { acquired: false, heldBy: null };
  };

  return {
    acquireWorktree: (input) => acquire(normalizeKey(input.worktreeRoot), input.kind),
    acquireSource: (input) => acquire(`source:${normalizeKey(input.sourceRoot)}`, input.kind),
    async readWorktree(worktreeRoot) {
      // 只读：残留租约由下一次 acquire 按 pid 存活性回收，列表路径不写文件系统。
      const holder = await readLease(leaseFile(normalizeKey(worktreeRoot)));
      if (!holder || !isPidAlive(holder.pid)) return null;
      return { kind: holder.kind, pid: holder.pid };
    },
  };
}
