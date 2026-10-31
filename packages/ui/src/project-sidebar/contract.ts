// project-sidebar 模块契约（spec：.agents/specs/upstream-3.16-project-integration.md）。
// 只放类型与稳定的只读视图；运行时实现经 index.ts 暴露。

import type { ReactNode } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { ProjectTask, ProjectTree, VirtualProject } from "@zcode/services";

export type {
  ProjectDirectories,
  ProjectTask,
  ProjectTaskGroup,
  ProjectTaskGroupColor,
  ProjectTaskGroupMember,
  ProjectTaskGroupMoveInput,
  ProjectTaskGroupNode,
  ProjectTaskGroupStructure,
  ProjectTaskGroupTopOrder,
  ProjectTaskRef,
  ProjectTree,
  SaveProjectInput,
  VirtualProject,
} from "@zcode/services";

export type ProjectSidebarViewMode = "projects" | "grouped" | "timeline" | "archive";

/** 侧栏只接受所属 Host 树的只读行；任务导航仍走 shell 现有回调。 */
export interface ProjectSidebarTaskRef {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  unreadAt?: number;
}

/**
 * 项目行“新建任务”：workspace 来自 prepareSession 校验后的真实 root，projectId 是 Host
 * readTree 已确认的归属。冻结执行目录由 Host 预占入口按 projectId 决定，UI 不另造目录。
 */
export interface ProjectSidebarCreateTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  projectId: string;
}

export interface ProjectSidebarFileTreeTarget {
  workspacePath: string;
  workspaceName: string;
  workspaceIdentity?: string;
  revealPath?: string;
}

/** 侧栏外壳通过该请求打开模块自己的编辑器；id 用于忽略重复的旧请求。 */
export interface ProjectSidebarActionRequest {
  id: number;
  type: "create" | "restore";
}

/** 项目行/任务行只从 Host readTree 派生；UI 偏好与草稿不在服务端。 */
export interface ProjectSidebarRowModel {
  project: VirtualProject;
  key: string;
  tasks: ProjectTask[];
  expanded: boolean;
  hasUnread: boolean;
  legacyReadOnly: boolean;
  primaryRootMissing: boolean;
}

/**
 * legacy workspace 行由 WorkspaceSidebar 继续渲染（保留文件树/重连/拖拽装配）。
 * 模块只给出“哪些 tab 已被项目行接管”和“哪些任务已有项目归属”，避免同任务双区出现。
 */
export interface ProjectSidebarTreeFacts {
  tree: ProjectTree | null;
  loading: boolean;
  error: string | null;
  /** 非软删项目；pinned 优先、Host position 次序。 */
  projects: VirtualProject[];
  /** 软删项目；仅恢复对话框消费。 */
  deletedProjects: VirtualProject[];
  /** 项目行任务：!archived && !pinned，按 CLI updatedAt 倒序。 */
  projectTasks(project: VirtualProject): ProjectTask[];
  /** 全局置顶区与项目行都不重复渲染 pinned/archived 任务。 */
  pinnedTasks(): ProjectTask[];
  /** 未归类任务：无 projectId、非 pinned/archived，且所属 workspace 没有 legacy tab 行。 */
  unassignedTasks(legacyWorkspaceKeys: ReadonlySet<string>): ProjectTask[];
  /** 本地项目 root 已接管该 workspace 时，旧 workspace 行不再渲染。 */
  isWorkspaceCoveredByProject(tab: ProjectSidebarWorkspaceRef): boolean;
  /** 精确 task 身份（hostId + workspaceKey + taskId）是否已归属项目。 */
  isTaskOwnedByProject(
    task: Pick<ZCodeTaskMeta, "workspacePath" | "workspaceIdentity" | "taskId">,
  ): boolean;
  refresh(): Promise<void>;
}

export interface ProjectSidebarWorkspaceRef {
  workspacePath: string;
  workspaceIdentity?: string | null;
  remoteSessionId?: string | null;
  remoteTarget?: unknown;
}

export interface ProjectSidebarSectionProps extends ProjectSidebarTaskNavigation {
  /** 当前 shell workspace；用于 active 高亮/只读提示，不参与项目归属。 */
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  activeTaskId: string | null;
  /** legacy workspace 行由外层继续渲染；模块负责提供过滤事实。 */
  children?: ReactNode;
  /** 旧 workspace 行集合；只用于判断未归类任务是否已有落点。 */
  legacyWorkspaceTabs?: readonly ProjectSidebarWorkspaceRef[];
  actionRequest?: ProjectSidebarActionRequest | null;
  onActionHandled?: (request: ProjectSidebarActionRequest) => void;
  /** 权威 ProjectTree 的未读投影；由宿主决定是否写任务栏/托盘角标。 */
  onUnreadTaskCountChange?: (count: number) => void;
  /**
   * 项目模块内的视图切换只影响本客户端偏好。外壳用 grouped/timeline 隐藏自己的
   * workspace 置顶区，避免与项目树置顶/时间线行重复；projects/archive 保持原样。
   */
  onViewModeChange?: (mode: ProjectSidebarViewMode) => void;
}

export interface ProjectSidebarTaskNavigation {
  onSelectTask: (
    workspacePath: string,
    taskId: string,
    workspaceIdentity?: string,
    remoteSessionId?: string,
    expectedUnreadAt?: number,
  ) => void;
  onCreateTask: (target: ProjectSidebarCreateTarget) => void;
  onOpenFileTree?: (target: ProjectSidebarFileTreeTarget) => void;
}
