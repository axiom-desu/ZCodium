import type { ZCodeTaskMeta } from "@zcode/shared";
import type {
  ProjectTask,
  ProjectTree,
  VirtualProject,
  ProjectSidebarRowModel,
  ProjectSidebarWorkspaceRef,
} from "./contract.js";

type ProjectRowSelection =
  | { kind: "project"; projectId: string | null; hostId?: string }
  | { kind: "pinned" }
  | { kind: "unassigned" };

export function projectRowKey(project: Pick<VirtualProject, "id" | "hostId">): string {
  return JSON.stringify([project.hostId, project.id]);
}

/** 任务身份按 Host + workspace key + taskId 精确比较；同路径不同远端不得合并。 */
export function projectTaskKey(
  task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
  hostId?: string,
): string {
  return JSON.stringify([
    hostId ?? "",
    task.workspaceIdentity?.trim() || task.workspacePath,
    task.taskId,
  ]);
}

function compareProjectTasks(left: ProjectTask, right: ProjectTask): number {
  return (
    (right.updatedAt ?? 0) - (left.updatedAt ?? 0) ||
    (right.createdAt ?? 0) - (left.createdAt ?? 0) ||
    right.taskId.localeCompare(left.taskId)
  );
}

/** pinned 只改变显示分组，不改变组内 Host position 的相对次序。 */
export function selectVisibleProjects(tree: ProjectTree): VirtualProject[] {
  return tree.projects
    .filter((project) => !project.deleted)
    .sort((left, right) => {
      if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
      return left.position - right.position || left.id.localeCompare(right.id);
    });
}

export function selectDeletedProjects(tree: ProjectTree): VirtualProject[] {
  return tree.projects
    .filter((project) => project.deleted)
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
}

/** 行集合全部来自 Host readTree；pinned/archived 在项目行与置顶区之间只出现一次。 */
export function selectProjectRows(
  tree: ProjectTree,
  selection: ProjectRowSelection,
): ProjectTask[] {
  return tree.tasks
    .filter((task) => {
      if (selection.kind === "pinned") return task.pinned && !task.archived;
      if (task.archived || task.pinned) return false;
      if (selection.kind === "unassigned") return task.projectId === null;
      return (
        task.projectId === selection.projectId &&
        (!selection.hostId || task.hostId === selection.hostId)
      );
    })
    .sort(compareProjectTasks);
}

/** 旧 workspace 行仍由 sidebar 渲染；未归类任务只在没有对应 tab 行时补位。 */
export function selectUnassignedTasks(
  tree: ProjectTree,
  legacyWorkspaceKeys: ReadonlySet<string>,
): ProjectTask[] {
  return selectProjectRows(tree, { kind: "unassigned" }).filter(
    (task) => !legacyWorkspaceKeys.has(task.workspaceIdentity?.trim() || task.workspacePath),
  );
}

export function isProjectLegacyReadOnly(project: VirtualProject): boolean {
  return project.legacySingleRoot === true;
}

export function isTaskInLegacyReadOnlyProject(tree: ProjectTree, task: ProjectTask): boolean {
  if (task.projectId === null) return false;
  const project = tree.projects.find(
    (candidate) => candidate.id === task.projectId && candidate.hostId === task.hostId,
  );
  return project ? isProjectLegacyReadOnly(project) : false;
}

export function isProjectPrimaryRootMissing(project: VirtualProject): boolean {
  return project.primaryRootStatus !== undefined && project.primaryRootStatus !== "available";
}

function projectHasUnread(tree: ProjectTree, project: VirtualProject): boolean {
  return tree.tasks.some(
    (task) =>
      task.projectId === project.id &&
      task.hostId === project.hostId &&
      !task.archived &&
      Boolean(task.unreadAt),
  );
}

/**
 * 任务栏/托盘角标的未读总数：与侧栏蓝点同源（Host readTree 的权威树），
 * 过滤条件与 projectHasUnread 一致（非归档 + 有 unreadAt），按 host+workspace+task 去重。
 * 不能改读 renderer 的 taskListCache/taskQueryCache：它们只装载活跃 workspace 的列表，
 * 背景工作区有蓝点时这两份缓存是空的，角标会丢数。
 *
 * 只统计侧栏实际渲染的任务：置顶任务跨项目可见；无项目任务进入未归类区；
 * 其余任务必须归属非软删项目。项目行与 legacy 行可能携带同一任务，使用
 * projectTaskKey（identity.trim() || path）去重，避免同一蓝点被计两次。
 */
export function countProjectTreeUnreadTasks(tree: ProjectTree): number {
  const renderedProjectKeys = new Set(
    tree.projects.filter((project) => !project.deleted).map((project) => projectRowKey(project)),
  );
  const seen = new Set<string>();

  for (const task of tree.tasks) {
    if (task.archived || !task.unreadAt) {
      continue;
    }

    const visible =
      task.pinned ||
      task.projectId === null ||
      renderedProjectKeys.has(projectRowKey({ id: task.projectId, hostId: task.hostId }));
    if (!visible) {
      continue;
    }

    seen.add(projectTaskKey(task, task.hostId));
  }

  return seen.size;
}

export function buildProjectRowModels(
  tree: ProjectTree,
  expandedKeys: ReadonlySet<string>,
): ProjectSidebarRowModel[] {
  return selectVisibleProjects(tree).map((project) => {
    const key = projectRowKey(project);
    return {
      project,
      key,
      tasks: selectProjectRows(tree, {
        kind: "project",
        projectId: project.id,
        hostId: project.hostId,
      }),
      expanded: expandedKeys.has(key),
      hasUnread: projectHasUnread(tree, project),
      legacyReadOnly: isProjectLegacyReadOnly(project),
      primaryRootMissing: isProjectPrimaryRootMissing(project),
    };
  });
}

/** 本地项目 root 接管后，旧本地 workspace 行让位；远程行不受本地 root 匹配影响。 */
function isWorkspaceTabCoveredByProject(
  tab: ProjectSidebarWorkspaceRef,
  projects: readonly VirtualProject[],
): boolean {
  const remote = Boolean(tab.workspaceIdentity || tab.remoteSessionId || tab.remoteTarget);
  if (remote) return false;
  return projects.some(
    (project) =>
      !project.deleted &&
      !project.legacySingleRoot &&
      project.roots.some((root) => root.rootPath === tab.workspacePath),
  );
}

export function filterLegacyWorkspaceTabs<T extends ProjectSidebarWorkspaceRef>(
  tabs: readonly T[],
  projects: readonly VirtualProject[],
): T[] {
  return tabs.filter((tab) => !isWorkspaceTabCoveredByProject(tab, projects));
}

export function isTaskOwnedByProject(
  tree: ProjectTree,
  task: Pick<ZCodeTaskMeta, "workspacePath" | "workspaceIdentity" | "taskId">,
  hostId: string,
): boolean {
  return tree.tasks.some(
    (candidate) =>
      candidate.projectId !== null &&
      candidate.hostId === hostId &&
      projectTaskKey(candidate, candidate.hostId) === projectTaskKey(task, hostId),
  );
}

/** 跨置顶边界拖动不改 pinned；只在同一 pinned 分组内产生新顺序。 */
export function reorderProjectIds(
  projects: readonly VirtualProject[],
  activeKey: string,
  overKey: string,
): string[] | null {
  const active = projects.find((project) => projectRowKey(project) === activeKey);
  const over = projects.find((project) => projectRowKey(project) === overKey);
  if (!active || !over || active.pinned !== over.pinned) {
    return null;
  }
  const group = projects.filter((project) => project.pinned === active.pinned);
  const fromIndex = group.findIndex((project) => projectRowKey(project) === activeKey);
  const toIndex = group.findIndex((project) => projectRowKey(project) === overKey);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
    return null;
  }
  const moved = [...group];
  moved.splice(toIndex, 0, moved.splice(fromIndex, 1)[0]!);
  let cursor = 0;
  const next = projects.map((project) =>
    project.pinned === active.pinned ? moved[cursor++]!.id : project.id,
  );
  return next;
}

export function splitRoots(project: VirtualProject): {
  roots: string[];
  primaryRoot: string;
} {
  const roots = project.roots.map((root) => root.rootPath);
  return {
    roots,
    primaryRoot: project.roots.find((root) => root.isPrimary)?.rootPath ?? roots[0] ?? "",
  };
}

export function projectTaskWorkspaceKey(
  task: Pick<ProjectSidebarWorkspaceRef, "workspacePath" | "workspaceIdentity">,
): string {
  return task.workspaceIdentity?.trim() || task.workspacePath;
}

function compareTimelineTasks(left: ProjectTask, right: ProjectTask): number {
  // 与上游 timeline 一致：不把运行态置顶，只按 CLI 时间与稳定身份排序。
  if (right.updatedAt !== left.updatedAt) return right.updatedAt - left.updatedAt;
  if (right.createdAt !== left.createdAt) return right.createdAt - left.createdAt;
  if (right.taskId !== left.taskId) return right.taskId.localeCompare(left.taskId);
  return JSON.stringify([right.hostId, projectTaskWorkspaceKey(right)]).localeCompare(
    JSON.stringify([left.hostId, projectTaskWorkspaceKey(left)]),
  );
}

/** 时间线：同一棵树里的全部未归档任务（含置顶与软删项目历史）。 */
export function selectTimelineTasks(
  tree: ProjectTree,
  excludedWorkspaceKeys: ReadonlySet<string> = new Set(),
): ProjectTask[] {
  return tree.tasks
    .filter((task) => !task.archived && !excludedWorkspaceKeys.has(projectTaskWorkspaceKey(task)))
    .sort(compareTimelineTasks);
}

export interface ProjectTimelineDateHeading {
  key: string;
  id: string;
  values?: { days: string };
}

// 日期段按本地日历日计算；夏令时的一天可能为 23/25 小时，不能直接用毫秒差取整。
function calendarDay(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
}

/** 只给已有顺序插入标题；分页、行集合与时间排序仍归调用方。 */
export function timelineDateHeadings(
  timestamps: readonly number[],
  now: number,
  locale: "en-US" | "zh-CN",
): Array<ProjectTimelineDateHeading | null> {
  const today = calendarDay(now);
  const date = new Date(now);
  const weekStart = today - ((date.getDay() + (locale === "en-US" ? 0 : 6)) % 7);
  const monthStart = calendarDay(new Date(date.getFullYear(), date.getMonth(), 1).getTime());
  const lastMonthStart = calendarDay(
    new Date(date.getFullYear(), date.getMonth() - 1, 1).getTime(),
  );
  let previousKey: string | undefined;
  return timestamps.map((timestamp) => {
    const day = calendarDay(timestamp);
    const daysAgo = today - day;
    const kind =
      daysAgo <= 0
        ? "today"
        : daysAgo === 1
          ? "yesterday"
          : daysAgo <= 3
            ? "daysAgo"
            : day >= weekStart
              ? "thisWeek"
              : day >= weekStart - 7
                ? "lastWeek"
                : day >= monthStart
                  ? "thisMonth"
                  : day >= lastMonthStart
                    ? "lastMonth"
                    : "older";
    const key = kind === "daysAgo" ? `${kind}:${daysAgo}` : kind;
    if (key === previousKey) return null;
    previousKey = key;
    return {
      key,
      id: `taskTimeline.${kind}`,
      ...(kind === "daysAgo" ? { values: { days: String(daysAgo) } } : {}),
    };
  });
}

export type ProjectArchiveSort = "updated" | "created";

export interface ProjectArchiveGroup {
  key: string;
  hostId: string;
  projectId: string | null;
  project?: VirtualProject;
  tasks: ProjectTask[];
}

const projectArchiveTaskKey = (task: ProjectTask) =>
  JSON.stringify([task.hostId, projectTaskWorkspaceKey(task), task.taskId]);

function archiveGroupKey(hostId: string, id: string | null): string {
  return JSON.stringify([hostId, id]);
}

/** 归档按 Host + project ID 分组；同 cwd 的不同项目绝不按目录叶名合并。 */
export function buildProjectArchiveGroups(
  tree: ProjectTree,
  filter: { query?: string; sort?: ProjectArchiveSort; project?: string } = {},
): ProjectArchiveGroup[] {
  const query = filter.query?.trim().toLocaleLowerCase() ?? "";
  const projects = new Map(
    tree.projects.map((project) => [archiveGroupKey(project.hostId, project.id), project]),
  );
  const groups = new Map<string, ProjectArchiveGroup>();
  for (const task of tree.tasks) {
    if (!task.archived || !task.title.toLocaleLowerCase().includes(query)) continue;
    const key = archiveGroupKey(task.hostId, task.projectId);
    if (filter.project && filter.project !== "all" && key !== filter.project) continue;
    const group = groups.get(key) ?? {
      key,
      hostId: task.hostId,
      projectId: task.projectId,
      project: projects.get(key),
      tasks: [],
    };
    group.tasks.push(task);
    groups.set(key, group);
  }
  const time = filter.sort === "created" ? "createdAt" : "updatedAt";
  for (const group of groups.values()) {
    group.tasks.sort(
      (a, b) =>
        b[time] - a[time] || projectArchiveTaskKey(a).localeCompare(projectArchiveTaskKey(b)),
    );
  }
  return [...groups.values()].sort((a, b) => {
    const left = a.tasks[0]?.[time] ?? 0;
    const right = b.tasks[0]?.[time] ?? 0;
    return right - left || a.key.localeCompare(b.key);
  });
}
