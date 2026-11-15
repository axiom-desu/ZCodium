/**
 * 受管 worktree 的跨进程合同（spec: .agents/specs/upstream-3.18-worktrees-remote-projects.md）。
 *
 * Host 是 worktree 生命周期的唯一 owner；UI 只消费事实与命令结果，不推算归属。
 * 本地模型：任务 workspace 就是 worktree 根目录（workspaceIdentity 为空），
 * projectId 记录任务所属项目，tasks-index 的 worktree_root 记录受管关系。
 */
export interface ManagedWorktreeTaskRef {
  taskId: string;
  /** 任务的执行 workspace；受管任务等于 worktree 根目录。 */
  workspacePath: string;
  projectId: string | null;
  title: string;
  archived: boolean;
}

export interface ManagedWorktreeEntry {
  path: string;
  sourceRoot: string;
  bucket: string;
  head: string | null;
  branch: string | null;
  dirty: boolean | null;
  /** 正在进行创建/会话启动的 worktree；删除一律拒绝。 */
  creating: boolean;
  tasks: ManagedWorktreeTaskRef[];
}

export interface ManagedWorktreeGroup {
  sourceRoot: string;
  worktrees: ManagedWorktreeEntry[];
}

export interface ManagedWorktreeStartRef {
  name: string;
  commit: string;
  remote: boolean;
}

export type ManagedWorktreeErrorCode =
  | "not-local"
  | "not-repository"
  | "not-managed"
  | "dirty"
  | "in-use"
  | "shared-reference"
  | "git-failed"
  | "session-failed"
  | "session-close-failed"
  | "unsupported-agent";

export interface ManagedWorktreeError {
  code: ManagedWorktreeErrorCode;
  detail?: string;
}

export interface CreatedWorktreeTask {
  /** 本次创建记录 id；创建同步完成即结束，只用于诊断与幂等重试。 */
  creationId: string;
  taskId: string;
  /** 任务执行 workspace，等于 worktree 根目录。 */
  workspacePath: string;
  worktreeRoot: string;
  projectId: string;
}

export type CreateWorktreeTaskResult =
  | { ok: true; value: CreatedWorktreeTask }
  | { ok: false; error: ManagedWorktreeError };

/** fork 到新 worktree 的目标行（与 v4 ConversationRowTarget 同形）。 */
export interface ManagedWorktreeForkTarget {
  rowId: number;
  entityId: string;
}

export type ForkWorktreeTaskResult =
  | { ok: true; value: CreatedWorktreeTask }
  | { ok: false; error: ManagedWorktreeError };

export type RemoveManagedWorktreeResult =
  | { ok: true; value: undefined }
  | { ok: false; error: ManagedWorktreeError };

export interface ManagedWorktreeWorkspace {
  workspacePath: string;
  workspaceIdentity?: string;
}
