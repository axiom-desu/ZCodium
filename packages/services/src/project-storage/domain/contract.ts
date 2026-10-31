import type { AppSettings, ZCodeTaskMeta } from "@zcode/shared";

export interface ProjectMigrationContext {
  /** 可信持库 Host 身份；不受客户端请求或旧 canonical route 影响。 */
  hostId?: string;
  backupDirectories: readonly string[];
  /** 首次项目 seed 的唯一旧事实；Host worker 必须注入，缺失时迁移显式失败而不是记账后永久丢失。 */
  settings: Pick<AppSettings, "lastWorkspaceSession" | "recentProjects">;
  now?: () => number;
  warn?: (message: string, details?: Record<string, unknown>) => void;
}

/** 旧远端合成项目 ID 前缀；升级时只允许入口版本 CAS 解析，不形成持久权威项目。 */
export const LEGACY_SINGLE_ROOT_PROJECT_PREFIX = "legacy-single-root:";

export interface ProjectRoot {
  rootPath: string;
  position: number;
  isPrimary: boolean;
}
export interface VirtualProject {
  id: string;
  hostId: string;
  name: string;
  nameOverridden: boolean;
  roots: ProjectRoot[];
  position: number;
  pinned: boolean;
  deleted: boolean;
  createdAt: number;
  updatedAt: number;
  /** 应用层用 stat 派生的主目录可用性；不写库、不缓存。 */
  primaryRootStatus?: "available" | "missing" | "unavailable";
  /** 仅旧远端单 root 读适配器；不是持久权威项目。 */
  legacySingleRoot?: boolean;
  /** 旧远端按 platform 规范化后的匹配值；不落库。 */
  directoryMatchPath?: string;
}
export interface ProjectTaskRef {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}

export type ProjectTaskGroupColor =
  | "gray"
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple";

/** taskIndexRepo 现有分组三张表的只读投影；不是第二份组织态。 */
export interface ProjectTaskGroup {
  id: string;
  title: string;
  color: ProjectTaskGroupColor;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectTaskGroupMember {
  groupId: string;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  sortOrder: number | null;
  addedAt: number;
}

export type ProjectTaskGroupTopOrder =
  | { type: "group"; groupId: string; sortOrder: number }
  | { type: "task"; workspaceKey: string; taskId: string; sortOrder: number };

/** 分组手势/菜单的单节点命令；任务引用带 Host 身份，跨 authority 在事务内拒绝。 */
export type ProjectTaskGroupNode =
  | { type: "group"; groupId: string }
  | { type: "task"; task: ProjectTaskRef & { hostId: string } };

export interface ProjectTaskGroupMoveInput {
  node: ProjectTaskGroupNode;
  /** 当前来源父组；null 表示顶层。与事务内事实不一致即 stale。 */
  sourceGroupId: string | null;
  /** 目标父组；null 表示顶层。 */
  groupId: string | null;
  /** 目标层级内的相对锚点；缺失时插入目标层级第一位。 */
  anchor?: { node: ProjectTaskGroupNode; side: "before" | "after" };
}

export interface ProjectTaskGroupStructure {
  groups: ProjectTaskGroup[];
  members: ProjectTaskGroupMember[];
  topLevelOrders: ProjectTaskGroupTopOrder[];
}

export type ProjectTask = ZCodeTaskMeta & {
  projectId: string | null;
  hostId: string;
  pinned: boolean;
  archived: boolean;
};
export interface ProjectTree {
  projects: VirtualProject[];
  tasks: ProjectTask[];
  /** 同一 tasks-index 快照里的任务组只读投影；旧库/旧远端缺表时不设置。 */
  taskGroups?: ProjectTaskGroupStructure;
  /** 旧远端单 root 读适配器标记；本地权威树不设置。 */
  legacySingleRoot?: boolean;
  /** 仅显式请求时返回删除事实；离线缺席不能替代这些引用。 */
  deletedTasks?: Array<ProjectTaskRef & { hostId: string }>;
}

export interface SaveProjectInput {
  id?: string;
  hostId?: string;
  name?: string;
  defaultName?: string;
  roots?: string[];
  primaryRoot?: string;
  pinned?: boolean;
  restoreProjectId?: string;
}
export interface ProjectDirectories {
  workspacePath: string;
  /** 远端装配层登记后的 attachment 身份；执行仍使用 workspacePath。 */
  workspaceIdentity?: string;
  additionalDirectories: string[];
  projectId: string | null;
}
export interface AutoArchiveInput {
  /** CLI updated_at 截止点；不使用 Host 收帧时间。 */
  cutoff: number;
  /** syncer 当前观察到的非终态任务；扫描不得归档活跃会话。 */
  activeTasks: readonly ProjectTaskRef[];
}
export interface ProjectTaskReservationSettlement {
  /** 只有 `cli-closed` 且行仍完全未被认领/整理时才为 true（本事务删掉了本次预留行）。 */
  released: boolean;
  reason:
    | "released"
    | "unavailable"
    | "not-reserved"
    | "task-missing"
    | "claimed"
    | "organized"
    | "input-forwarded";
}
export interface ProjectRepositoryContract {
  /** 可只取目录，并参与调用方已有的 SQLite 读快照。 */
  readTree(options?: {
    includeDeleted?: boolean;
    includeDeletedTasks?: boolean;
    includeTasks?: boolean;
  }): ProjectTree;
  saveProject(input: SaveProjectInput): VirtualProject;
  deleteProject(id: string): void;
  /** 在写事务内只为空项目初始化 root；并发编辑已添加的目录优先。 */
  initializeProjectRoot(id: string, path: string): VirtualProject;
  moveTask(input: { task: ProjectTaskRef; projectId: string; addMissingRoot?: boolean }): void;
  reorderProjects(ids: string[]): void;
  /** 单节点移动；来源/锚点在事务内复检，不覆盖不可见成员。 */
  moveTaskGroupNode(input: ProjectTaskGroupMoveInput): void;
  /** 只写 archived；只读取 CLI 事实与所属 Host，读取/点击路径不得调用。 */
  archiveInactive(input: AutoArchiveInput): ProjectTaskRef[];
  resolveSessionDirectories(task: ProjectTaskRef): ProjectDirectories;
  /** CLI 创建之前原子预留归属；无事实的预留行不进入列表，重试不覆盖组织操作。 */
  reserveCreatedTask(input: {
    task: ProjectTaskRef;
    projectId: string | null;
    /** Host 已固化的执行目录；首次预留持久化，重试不改。undefined 为普通新建。 */
    additionalDirectories?: string[];
    /**
     * 创建路径专用：additionalDirectories 缺席时把本次派生目录固化成快照（同一写事务）。
     * 之后编辑项目 roots / 移动任务不得改写已创建会话的恢复目录。
     */
    freezeAdditionalDirectories?: true;
  }): ProjectDirectories;
  /**
   * 预热/取消后的预留收口（receipt 唯一 owner）：
   * `input-forwarded` 只弃用 receipt；`cli-closed` 在 CLI 关闭回执后释放仍未认领的空行。
   * 已接受/用户整理/未知来源行一律保留，失败不得部分删除。
   */
  settleCreatedTaskReservation(input: {
    task: ProjectTaskRef;
    outcome: "cli-closed" | "input-forwarded";
  }): ProjectTaskReservationSettlement;
}
