import type {
  CreateWorktreeTaskResult,
  ForkWorktreeTaskResult,
  ManagedWorktreeForkTarget,
  ManagedWorktreeGroup,
  ManagedWorktreeStartRef,
  RemoveManagedWorktreeResult,
} from "@zcode/shared/managed-worktree";
import { createServiceDescriptor } from "#src/descriptors.js";
import { ServiceChannels } from "@zcode/shared";

/**
 * 受管 worktree 的唯一服务 owner（spec: .agents/specs/upstream-3.18-worktrees-remote-projects.md）。
 *
 * - worktree 事实：Git `worktree list` + 受管布局/git-common 验证（services/git/managed-worktree）。
 * - 任务关系：tasks-index `worktree_root`（由项目仓储的预占事务写入）。
 * - 忙闲：调用方注入 active-task 只读端口，服务不维护第二份运行状态。
 *
 * 本地模型：任务 workspace 就是 worktree 根目录；workspaceIdentity 必须为空。
 * 远端 Host 不注册此服务，Web/mobile 默认拒绝。
 */
export interface IManagedWorktreeService {
  /** 项目各 root 所属仓库的受管 worktree + 任务引用。 */
  listWorktrees(params: { projectId: string }): Promise<{ groups: ManagedWorktreeGroup[] }>;
  /** worktree 模式下分支胶囊候选；不执行 fetch。 */
  listStartRefs(params: { projectId: string }): Promise<ManagedWorktreeStartRef[] | null>;
  /**
   * 新建任务：在项目主 root 所属仓库创建受管 worktree，再经既有 Host 会话入口
   * （zcodeAgentService.createSession → 项目预占 → CLI CommandInbox）启动会话。
   * 会话启动失败时只清理本次新建的 worktree；清理失败如实返回，不伪装成功。
   */
  createTask(params: { projectId: string; ref: string | null }): Promise<CreateWorktreeTaskResult>;
  /**
   * fork 当前任务到新 worktree：复制父会话历史，经真实 CLI forkAssistant.targetCwd
   * 把子会话 cwd 放到新 worktree；预分配 childSessionId 与任务归属使用同一 ID。
   */
  forkTask(params: {
    projectId: string;
    sourceTaskId: string;
    sourceWorkspacePath: string;
    sourceWorkspaceIdentity?: string;
    target: ManagedWorktreeForkTarget;
    baseRevision: number;
    baseLogEpoch: string;
    ref?: string | null;
  }): Promise<ForkWorktreeTaskResult>;
  /** CLI 是否声明 worktreeCwd（forkAssistant.targetCwd）能力；旧 CLI 返回 false。 */
  supportsWorktreeCwd(params: { projectId: string }): Promise<boolean>;
  /** 删除前重新校验受管归属、任务、dirty、running、终端与共享引用。 */
  removeWorktree(params: {
    projectId: string;
    worktreeRoot: string;
    force?: boolean;
  }): Promise<RemoveManagedWorktreeResult>;
  /** 目录仍存在且仍是受管 worktree。 */
  isWorktreeAvailable(params: { worktreeRoot: string }): Promise<boolean>;
}

export const IManagedWorktreeService = createServiceDescriptor<IManagedWorktreeService>(
  ServiceChannels.ManagedWorktrees,
);
