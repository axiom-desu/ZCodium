/**
 * managed-worktree-tasks 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const managedWorktreeTasksModule = {
  id: "managed-worktree-tasks",
  requires: ["shared", "services", "project-storage"],
  provides: ["managed-worktree-tasks"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
