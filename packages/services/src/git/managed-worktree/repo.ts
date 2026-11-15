import { randomBytes } from "node:crypto";
import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  isManagedWorktreeBucket,
  parseManagedWorktreePath,
  resolveManagedWorktreeRoot,
} from "@zcode/shared/managed-worktree";
import type {
  ManagedWorktreeCommandProvider,
  ManagedWorktreeInfo,
  ManagedWorktreeRef,
  ManagedWorktreeRepo,
} from "./contract.js";

const outputLimit = 32 * 1024;
export function createManagedWorktreeRepo(options: {
  commandProvider: ManagedWorktreeCommandProvider;
  dataBaseDir: () => string;
}): ManagedWorktreeRepo {
  const run = async (cwd: string, args: string[]) =>
    options.commandProvider.run({ cwd, args, timeoutMs: 600_000, maxOutputBytes: outputLimit });
  const source = async (path: string) => {
    const result = await run(path, ["rev-parse", "--path-format=absolute", "--show-toplevel"]);
    if (result.exitCode !== 0) return null;
    return realpath(result.stdout.trim()).catch(() => null);
  };
  const listed = async (root: string) => {
    const result = await run(root, ["worktree", "list", "--porcelain"]);
    if (result.exitCode !== 0) return [];
    const records: Array<{ path: string; head: string | null; branch: string | null }> = [];
    let record: { path: string; head: string | null; branch: string | null } | null = null;
    for (const line of result.stdout.split(/\r?\n/)) {
      if (!line) {
        if (record) records.push(record);
        record = null;
        continue;
      }
      const split = line.indexOf(" ");
      const key = split < 0 ? line : line.slice(0, split);
      const value = split < 0 ? "" : line.slice(split + 1);
      if (key === "worktree") {
        if (record) records.push(record);
        record = { path: value, head: null, branch: null };
      } else if (record && key === "HEAD") record.head = value || null;
      else if (record && key === "branch") record.branch = value.replace(/^refs\/heads\//, "");
    }
    if (record) records.push(record);
    return records;
  };
  const dirty = async (path: string): Promise<boolean | null> => {
    const result = await run(path, ["status", "--porcelain", "-z", "--untracked-files=normal"]);
    return result.exitCode === 0 ? result.stdout.length > 0 : null;
  };
  const verified = async (sourceRoot: string, path: string) => {
    const managedRoot = resolveManagedWorktreeRoot(options.dataBaseDir());
    const realRoot = await realpath(managedRoot).catch(() => null);
    const realPath = await realpath(path).catch(() => path);
    if (!realRoot) return null;
    const parts = parseManagedWorktreePath(realRoot, realPath);
    if (!parts || parts.relativePath || !isManagedWorktreeBucket(parts.bucket)) return null;
    const entries = await listed(sourceRoot);
    const entry = entries.find((item) => resolve(item.path) === resolve(realPath));
    if (
      !entry ||
      !(await stat(join(realPath, ".git"))
        .then((value) => value.isFile())
        .catch(() => false))
    )
      return null;
    const common = await run(realPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (
      common.exitCode !== 0 ||
      resolve(common.stdout.trim()) !== resolve(join(sourceRoot, ".git"))
    )
      return null;
    return {
      ...parts,
      path: realPath,
      sourceRoot,
      head: entry.head,
      branch: entry.branch,
      dirty: await dirty(realPath),
    };
  };
  return {
    async list(sourcePath) {
      const root = await source(sourcePath);
      if (!root) return [];
      const managedRoot = await realpath(resolveManagedWorktreeRoot(options.dataBaseDir())).catch(
        () => null,
      );
      if (!managedRoot) return [];
      const result: ManagedWorktreeInfo[] = [];
      for (const entry of await listed(root)) {
        const item = await verified(root, entry.path);
        if (item) result.push(item);
      }
      return result;
    },
    async startRefs(sourcePath) {
      const root = await source(sourcePath);
      if (!root) return [];
      const result = await run(root, [
        "for-each-ref",
        "--format=%(refname:short)%00%(objectname)%00%(symref)",
        "refs/heads",
        "refs/remotes",
      ]);
      if (result.exitCode !== 0) return [];
      const refs: ManagedWorktreeRef[] = [{ name: "HEAD", commit: "", remote: false }];
      for (const row of result.stdout.split(/\r?\n/)) {
        const [name, commit] = row.split("\0");
        if (name && commit)
          refs.push({ name, commit, remote: name.includes("/") && !name.startsWith("HEAD") });
      }
      return refs;
    },
    async create(sourcePath, ref) {
      const root = await source(sourcePath);
      if (!root) return { ok: false, error: { code: "not-repository" } };
      const dataRoot = resolveManagedWorktreeRoot(options.dataBaseDir());
      await mkdir(dataRoot, { recursive: true });
      for (let attempt = 0; attempt < 64; attempt++) {
        const bucket = join(dataRoot, randomBytes(2).toString("hex"));
        try {
          await mkdir(bucket);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
          throw error;
        }
        const path = join(bucket, basename(root));
        const args = ["worktree", "add", "--detach", path];
        if (ref) args.push(ref);
        const added = await run(root, args);
        if (added.exitCode === 0) {
          const info = await verified(root, path);
          if (info) return { ok: true, value: info };
          // 安全修复：命令成功但受管反向链接校验失败时只回滚本次唯一新建的 bucket。
          const cleanup = await run(root, ["worktree", "remove", "--force", path]);
          if (cleanup.exitCode !== 0) {
            return {
              ok: false,
              error: {
                code: "git-failed",
                detail: `ownership verification failed; cleanup failed: ${(cleanup.stderr || cleanup.stdout).slice(0, 2000)}`,
              },
            };
          }
          await rm(bucket, { recursive: true, force: true });
          return {
            ok: false,
            error: { code: "git-failed", detail: "created worktree failed ownership verification" },
          };
        }
        await rm(bucket, { recursive: true, force: true });
        return {
          ok: false,
          error: { code: "git-failed", detail: (added.stderr || added.stdout).slice(0, 2000) },
        };
      }
      return {
        ok: false,
        error: { code: "git-failed", detail: "could not reserve a unique bucket" },
      };
    },
    async remove(sourcePath, path, gate) {
      const root = await source(sourcePath);
      if (!root) return { ok: false, error: { code: "not-repository" } };
      const info = await verified(root, path);
      if (!info) return { ok: false, error: { code: "not-managed" } };
      if (gate.hasSharedReferences) return { ok: false, error: { code: "shared-reference" } };
      if (gate.hasTasks && gate.force) return { ok: false, error: { code: "in-use" } };
      if (gate.hasTasks && info.dirty !== false)
        return { ok: false, error: { code: info.dirty ? "dirty" : "git-failed" } };
      const removed = await run(root, [
        "worktree",
        "remove",
        ...(gate.force ? ["--force"] : []),
        info.path,
      ]);
      if (removed.exitCode !== 0)
        return {
          ok: false,
          error: { code: "git-failed", detail: (removed.stderr || removed.stdout).slice(0, 2000) },
        };
      await rm(dirname(info.path), { recursive: true, force: true });
      return { ok: true, value: undefined };
    },
  };
}
