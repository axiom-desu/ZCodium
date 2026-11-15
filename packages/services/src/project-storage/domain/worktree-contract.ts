import type { ProjectTaskRef } from "#src/project-storage/domain/contract.js";

/** 绑定到某个受管 worktree 的任务行（tasks-index 的唯一受管关系记录）。 */
export interface ProjectWorktreeTask {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  projectId: string | null;
  title: string;
  archived: boolean;
}

/** 目录引用行：用于删除前发现未被 worktree_root 标记的同目录/附加目录使用者。 */
export interface ProjectDirectoryReference extends ProjectTaskRef {
  cwd: string;
  /** cwd + 附加目录；调用方用共享布局工具做精确包含判断。 */
  directories: string[];
  worktreeRoot?: string;
}

/**
 * 受管 worktree 的任务事实端口（与项目组织态同库同 owner，但独立子契约便于保持上限）。
 * 仅 services/managed-worktree-tasks 使用；UI 不直接消费。
 */
export interface ProjectWorktreeRepositoryContract {
  /** 精确读取绑定到某个受管 worktree 的任务行（删除闸门/列表的唯一任务事实）。 */
  listTasksByWorktree(input: { worktreeRoot: string }): ProjectWorktreeTask[];
  /**
   * 读取 cwd 或附加目录位于 directory 内的任务行，用于识别未被 worktree_root 标记的共享引用。
   * 只做候选查询；精确路径包含判断由调用方用共享布局工具完成。
   */
  listDirectoryReferencingTasks(input: { directory: string }): ProjectDirectoryReference[];
}
