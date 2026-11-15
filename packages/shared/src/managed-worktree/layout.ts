import { basename, isAbsolute, join, relative, sep } from "node:path";

export const MANAGED_WORKTREE_HOME_SEGMENTS = [".zcode", "worktrees"] as const;
export const MANAGED_WORKTREE_BUCKET_LENGTH = 4;
export const MANAGED_WORKTREE_SPOTLIGHT_MARKER = ".metadata_never_index";
const BUCKET = /^[0-9a-f]{4}$/;

export interface ManagedWorktreePathParts {
  managedRoot: string;
  bucket: string;
  name: string;
  worktreeRoot: string;
  relativePath: string;
}

export function resolveManagedWorktreeRoot(dataBaseDir: string): string {
  return join(dataBaseDir, ...MANAGED_WORKTREE_HOME_SEGMENTS);
}
export function managedWorktreeDirectoryName(sourceRoot: string): string {
  return basename(sourceRoot);
}
export function isManagedWorktreeBucket(value: string): boolean {
  return BUCKET.test(value);
}
export function isSamePath(left: string, right: string): boolean {
  return relative(left, right) === "";
}
export function isPathInside(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
export function parseManagedWorktreePath(
  managedRoot: string,
  candidatePath: string,
): ManagedWorktreePathParts | null {
  if (!isPathInside(managedRoot, candidatePath)) return null;
  const rel = relative(managedRoot, candidatePath);
  if (!rel) return null;
  const [bucket, name, ...rest] = rel.split(sep).filter(Boolean);
  if (!bucket || !name || !isManagedWorktreeBucket(bucket)) return null;
  return {
    managedRoot,
    bucket,
    name,
    worktreeRoot: join(managedRoot, bucket, name),
    relativePath: rest.join(sep),
  };
}
export function mapProjectRootsIntoWorktree(
  roots: readonly string[],
  placement: { sourceRoot: string; worktreeRoot: string; cwd: string },
): string[] {
  const mapped = roots.map((root) =>
    isPathInside(placement.sourceRoot, root)
      ? join(placement.worktreeRoot, relative(placement.sourceRoot, root))
      : root,
  );
  return [...new Set(mapped)].filter((path) => !isSamePath(path, placement.cwd));
}
