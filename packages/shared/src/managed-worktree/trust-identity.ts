import { dirname, isAbsolute, join, resolve } from "node:path";
import { isSamePath, parseManagedWorktreePath, resolveManagedWorktreeRoot } from "./layout.js";

export interface WorkspaceHookTrustIdentityFs {
  readFile(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean } | null>;
}
export interface ResolveWorkspaceHookTrustIdentityInput {
  workspacePath: string;
  workspaceIdentity?: string;
  dataBaseDir: string;
}
const GIT_DIR = ".git";

export async function resolveWorkspaceHookTrustIdentity(
  input: ResolveWorkspaceHookTrustIdentityInput,
  fs: WorkspaceHookTrustIdentityFs,
): Promise<string> {
  const identity = input.workspaceIdentity?.trim();
  if (identity) return identity;
  try {
    return (
      (await resolveManagedWorktreeSourcePath(input.workspacePath, input.dataBaseDir, fs)) ??
      input.workspacePath
    );
  } catch {
    // 校验任一环节失败都只信任当前目录，不继承可能错误归属的源仓库授权。
    return input.workspacePath;
  }
}
export async function resolveManagedWorktreeSourcePath(
  workspacePath: string,
  dataBaseDir: string,
  fs: WorkspaceHookTrustIdentityFs,
): Promise<string | null> {
  const root = await fs.realpath(resolveManagedWorktreeRoot(dataBaseDir));
  const workspace = await fs.realpath(workspacePath);
  const parts = parseManagedWorktreePath(root, workspace);
  if (!parts) return null;
  const dotGit = join(parts.worktreeRoot, GIT_DIR);
  if (!(await fs.stat(dotGit))?.isFile) return null;
  const adminDir = await fs.realpath(
    resolvePointer(parts.worktreeRoot, await fs.readFile(dotGit), "gitdir:"),
  );
  const worktreesDir = dirname(adminDir);
  if (!isSamePath(join(dirname(worktreesDir), "worktrees"), worktreesDir)) return null;
  const common = dirname(worktreesDir);
  const backlink = await fs.realpath(
    resolvePointer(adminDir, await fs.readFile(join(adminDir, "gitdir")), ""),
  );
  if (!isSamePath(backlink, await fs.realpath(dotGit))) return null;
  const commondir = await fs.realpath(
    resolvePointer(adminDir, await fs.readFile(join(adminDir, "commondir")), ""),
  );
  if (!isSamePath(commondir, common)) return null;
  const sourceRoot = dirname(common);
  if (!(await fs.stat(join(sourceRoot, GIT_DIR)))?.isDirectory) return null;
  if (!isSamePath(await fs.realpath(join(sourceRoot, GIT_DIR)), common)) return null;
  return parts.relativePath ? join(sourceRoot, parts.relativePath) : sourceRoot;
}
function resolvePointer(base: string, content: string, prefix: string): string {
  const line = content.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const value = prefix ? (line.startsWith(prefix) ? line.slice(prefix.length).trim() : "") : line;
  if (!value) throw new Error("invalid git pointer");
  return isAbsolute(value) ? value : resolve(base, value);
}
