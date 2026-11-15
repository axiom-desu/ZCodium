import type { IManagedWorktreeService } from "#src/managed-worktree-tasks/contract.js";

/** 最小消费者示例：只消费合同事实，不导入 git/FS 实现。 */
export async function listProjectWorktrees(service: IManagedWorktreeService, projectId: string) {
  const { groups } = await service.listWorktrees({ projectId });
  return groups.flatMap((group) => group.worktrees);
}
