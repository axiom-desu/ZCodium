import type { GitCommandProvider } from "../providers/gitCommandProvider.js";

export interface ManagedWorktreeRef {
  name: string;
  commit: string;
  remote: boolean;
}
export interface ManagedWorktreeInfo {
  path: string;
  sourceRoot: string;
  bucket: string;
  head: string | null;
  branch: string | null;
  dirty: boolean | null;
}
export type ManagedWorktreeErrorCode =
  | "not-repository"
  | "not-managed"
  | "dirty"
  | "in-use"
  | "shared-reference"
  | "git-failed";
export type ManagedWorktreeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: ManagedWorktreeErrorCode; detail?: string } };
export interface ManagedWorktreeRepo {
  list(sourcePath: string): Promise<ManagedWorktreeInfo[]>;
  startRefs(sourcePath: string): Promise<ManagedWorktreeRef[]>;
  create(
    sourcePath: string,
    ref: string | null,
  ): Promise<ManagedWorktreeResult<ManagedWorktreeInfo>>;
  remove(
    sourcePath: string,
    path: string,
    options: { force: boolean; hasTasks: boolean; hasSharedReferences: boolean },
  ): Promise<ManagedWorktreeResult<void>>;
}
export type ManagedWorktreeCommandProvider = GitCommandProvider;
