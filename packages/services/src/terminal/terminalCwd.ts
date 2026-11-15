import { readdir, readFile, readlink } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export function isPathWithin(parent: string, candidate: string): boolean {
  const rel = relative(resolve(parent), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

interface TerminalProcessSnapshot {
  /** PTY 根进程仍在 /proc 中可见；false 表示进程已退出或无法观察。 */
  sawRoot: boolean;
  /** 根进程与其全部后代的真实 cwd（仅 Linux 可读）。 */
  cwds: string[];
  /** 存在读不到 cwd 的存活进程（权限等）；无法证明其不在目标目录。 */
  unreadable: boolean;
}

type ProcessCwd = { kind: "cwd"; cwd: string } | { kind: "gone" } | { kind: "unknown" };

async function readProcessCwd(pid: number): Promise<ProcessCwd> {
  try {
    return { kind: "cwd", cwd: await readlink(`/proc/${pid}/cwd`) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ESRCH" ? { kind: "gone" } : { kind: "unknown" };
  }
}

async function readParentPid(pid: number): Promise<number | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    // comm 字段可能包含空格/括号，ppid 位于最后一个 ')' 之后。
    const close = stat.lastIndexOf(")");
    if (close < 0) return null;
    const ppid = Number(
      stat
        .slice(close + 2)
        .trim()
        .split(/\s+/)[1],
    );
    return Number.isInteger(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

/**
 * 读取 PTY 根进程及其后代的真实 cwd。
 *
 * 终端创建时记录的只是初始 cwd；用户在 shell 里 `cd` 进受管 worktree 后，
 * 只有读进程自身的 cwd 才能发现占用。非 Linux 或 /proc 不可用时返回 null，
 * 调用方必须按“无法证明”保守处理。脱离进程树的后台孤儿进程仍无法观察（已知限制）。
 */
export async function snapshotTerminalProcess(
  rootPid: number,
): Promise<TerminalProcessSnapshot | null> {
  if (process.platform !== "linux") return null;
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return null;
  }
  const children = new Map<number, number[]>();
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const ppid = await readParentPid(pid);
    if (ppid === null) continue;
    const list = children.get(ppid);
    if (list) list.push(pid);
    else children.set(ppid, [pid]);
  }
  const cwds: string[] = [];
  let sawRoot = false;
  let unreadable = false;
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    const cwd = await readProcessCwd(pid);
    if (pid === rootPid && cwd.kind !== "gone") sawRoot = true;
    if (cwd.kind === "cwd") cwds.push(cwd.cwd);
    if (cwd.kind === "unknown") unreadable = true;
    queue.push(...(children.get(pid) ?? []));
  }
  return { sawRoot, cwds, unreadable };
}

/**
 * 终端是否占用/可能占用 directory。
 * - 初始 cwd 命中：占用；
 * - 非 Linux 或 /proc 不可读：无法证明 shell 没有 cd 进去 → 视为占用；
 * - 根进程不可见或读不到任何 cwd：同样无法证明 → 视为占用。
 */
export function isTerminalHoldingDirectory(input: {
  platform: NodeJS.Platform;
  initialCwd: string;
  directory: string;
  snapshot: TerminalProcessSnapshot | null;
}): boolean {
  if (isPathWithin(input.directory, input.initialCwd)) return true;
  if (input.platform !== "linux" || input.snapshot === null) return true;
  if (!input.snapshot.sawRoot || input.snapshot.unreadable || input.snapshot.cwds.length === 0)
    return true;
  return input.snapshot.cwds.some((cwd) => isPathWithin(input.directory, cwd));
}
