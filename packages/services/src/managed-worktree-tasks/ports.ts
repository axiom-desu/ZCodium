import type { ManagedWorktreeRepo } from "#src/git/managed-worktree/contract.js";
import type { ManagedWorktreeForkTarget } from "@zcode/shared/managed-worktree";
import type { ProjectRepositoryContract, ProjectTaskRef } from "#src/project-storage/contract.js";
import type { WorktreeLeaseGate } from "#src/managed-worktree-tasks/removal-gate.js";

/** 受管 worktree 服务的注入端口（由 node.ts 装配；服务自身不执行 git/FS 之外的业务）。 */
export interface ManagedWorktreeTaskPorts {
  /** 仅本地桌面 Host 为 true；远端 Source Server 一律拒绝。 */
  isLocalHost: boolean;
  repository(): Promise<ProjectRepositoryContract>;
  git: ManagedWorktreeRepo;
  /** 受管根目录由 composition 注入，服务不自行推算用户数据目录。 */
  dataBaseDir(): string;
  agent: {
    /**
     * 既有 Host 会话入口：prepareSessionCreation 在同一事务里记录 projectId/worktreeRoot，
     * 之后才发 CLI createSession。返回值只用于拿真实 sessionId。
     */
    createSession(params: {
      workspacePath: string;
      projectId: string;
      worktreeRoot: string;
      additionalDirectories: string[];
      /** Host 预分配；用于失败时证明“CLI 是否已接受该会话”，不新增 admission。 */
      sessionId: string;
    }): Promise<{ sessionId: string }>;
    /**
     * 真实 v4 forkAssistant：父会话 cwd 只用于选择 CLI 进程，targetCwd 决定子会话 cwd。
     * 返回 CLI 实际创建的子会话 ID（必须等于预分配 childSessionId）。
     */
    forkSession(params: {
      parent: ProjectTaskRef;
      target: ManagedWorktreeForkTarget;
      targetCwd: { cwd: string; childSessionId: string };
      baseRevision: number;
      baseLogEpoch: string;
    }): Promise<{ sessionId: string }>;
    /** 现有 syncer live active-set；服务不缓存第二份运行状态。 */
    isTaskActive(task: ProjectTaskRef): boolean;
    /** CLI 的 worktreeCwd 能力；旧 CLI 不支持 targetCwd。 */
    supportsWorktreeCwd(target: ProjectTaskRef): Promise<boolean>;
    /** 只由 CLI 驻留表选择并卸载；返回 busy 时不得删除 worktree。 */
    releaseSessionsUnder(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      directory: string;
    }): Promise<{ released: string[]; busy: string[] }>;
  };
  /** 终端服务是终端 cwd 的唯一持有者；只读查询，不关闭其他 workspace 的终端。 */
  terminals: {
    listIdsUnder(path: string): Promise<string[]>;
  };
  /** 跨进程 per-worktree/per-source 租约（不能退化为进程内 Set）。 */
  leases: WorktreeLeaseGate;
}
