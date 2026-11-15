import type { ProjectTree, VirtualProject } from "./contract.js";
import { projectRowKey } from "./view.js";

const DAY = 86_400_000;
/** 空项目创建后的宽限期：刚建的项目还没来得及开会话，不算不再使用。 */
const EMPTY_GRACE_DAYS = 7;
const IDLE_DAYS = 90;

export type ProjectUnusedReason = "missing" | "empty" | "idle";
export type ProjectManagementFilter = "all" | "unused";
export type ProjectManagementSort = "lastActive" | "name" | "sessions";
/** delete = 本机 Host 软删除；null = 本页不能移除（远程项目只读展示）。 */
export type ProjectRemoval = "delete" | null;

export interface ProjectManagementRow {
  key: string;
  project: VirtualProject;
  /** 离线/旧远端的项目没有任务事实；本机树始终可统计。 */
  sessions: number;
  lastActiveAt: number | null;
  reason?: ProjectUnusedReason;
  idleMonths?: number;
  removal: ProjectRemoval;
}

/**
 * 只从 Host readTree 快照派生，不读第二份目录、不缓存项目事实。
 * 本页只管理本机项目；远程项目保留展示，但移除入口不属于 Renderer（由连接 registry 管理）。
 */
export function buildProjectManagementRows(input: {
  tree: Pick<ProjectTree, "projects" | "tasks">;
  now: number;
}): ProjectManagementRow[] {
  const stats = new Map<string, { sessions: number; lastActiveAt: number | null }>();
  for (const task of input.tree.tasks) {
    if (!task.projectId) continue;
    const key = projectRowKey({ id: task.projectId, hostId: task.hostId });
    const current = stats.get(key) ?? { sessions: 0, lastActiveAt: null };
    current.sessions += 1;
    current.lastActiveAt = Math.max(current.lastActiveAt ?? 0, task.updatedAt);
    stats.set(key, current);
  }
  return input.tree.projects
    .filter((project) => !project.deleted)
    .map((project) => {
      const key = projectRowKey(project);
      const fact = stats.get(key) ?? { sessions: 0, lastActiveAt: null };
      const removal: ProjectRemoval =
        project.hostId === "local" && !project.legacySingleRoot ? "delete" : null;
      return {
        key,
        project,
        sessions: fact.sessions,
        lastActiveAt: fact.lastActiveAt,
        removal,
        // 建议只针对本页能移除的行；置顶表示用户明确要保留。
        ...(removal && !project.pinned ? unusedReason(project, fact, input.now) : {}),
      };
    });
}

function unusedReason(
  project: VirtualProject,
  fact: { sessions: number; lastActiveAt: number | null },
  now: number,
): Pick<ProjectManagementRow, "reason" | "idleMonths"> {
  if (project.primaryRootStatus === "missing") return { reason: "missing" };
  if (!fact.sessions)
    return project.createdAt > 0 && now - project.createdAt > EMPTY_GRACE_DAYS * DAY
      ? { reason: "empty" }
      : {};
  const idleDays = (now - (fact.lastActiveAt ?? now)) / DAY;
  return idleDays > IDLE_DAYS ? { reason: "idle", idleMonths: Math.floor(idleDays / 30) } : {};
}

export function selectProjectManagementRows(
  rows: readonly ProjectManagementRow[],
  options: { query: string; filter: ProjectManagementFilter; sort: ProjectManagementSort },
): ProjectManagementRow[] {
  const query = options.query.trim().toLowerCase();
  const byName = (left: ProjectManagementRow, right: ProjectManagementRow) =>
    left.project.name.localeCompare(right.project.name) || left.key.localeCompare(right.key);
  return rows
    .filter((row) => options.filter === "all" || row.reason)
    .filter(
      (row) =>
        !query ||
        [row.project.name, ...row.project.roots.map((root) => root.rootPath)].some((text) =>
          text.toLowerCase().includes(query),
        ),
    )
    .sort((left, right) => {
      if (options.sort === "sessions") return right.sessions - left.sessions || byName(left, right);
      if (options.sort === "lastActive")
        return (right.lastActiveAt ?? -1) - (left.lastActiveAt ?? -1) || byName(left, right);
      return byName(left, right);
    });
}

export function summarizeUnusedProjects(rows: readonly ProjectManagementRow[]) {
  const count = (reason: ProjectUnusedReason) => rows.filter((row) => row.reason === reason).length;
  const summary = { missing: count("missing"), empty: count("empty"), idle: count("idle") };
  return { total: summary.missing + summary.empty + summary.idle, ...summary };
}

/** 确认对话框按设备拆分：本机项目软删除，远程项目只读展示、不在本页移除。 */
export function summarizeProjectRemoval(rows: readonly ProjectManagementRow[]) {
  const devices = new Map<string, { hostId: string; count: number }>();
  for (const row of rows) {
    const device = devices.get(row.project.hostId) ?? {
      hostId: row.project.hostId,
      count: 0,
    };
    device.count++;
    devices.set(row.project.hostId, device);
  }
  return {
    sessions: rows.reduce((sum, row) => sum + row.sessions, 0),
    devices: [...devices.values()].sort(
      (left, right) => Number(left.hostId !== "local") - Number(right.hostId !== "local"),
    ),
  };
}

/** 数据删除只针对本机、可移除且已软删除的项目；远程项目的数据在其设备上。 */
export const isProjectDataCandidate = (row: ProjectManagementRow) =>
  row.removal === "delete" && row.project.hostId === "local";

/** 可恢复的只有本 Host 的软删除项目；远程入口移除不保留恢复事实。 */
export function selectRemovedProjects(tree: Pick<ProjectTree, "projects">): VirtualProject[] {
  return tree.projects
    .filter((project) => project.deleted && project.hostId === "local" && !project.legacySingleRoot)
    .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
}

/** 简易 intl 不支持复数；数量为 1 时改用 `<id>One` 文案，其余共用 `{count}` 文案。 */
export function formatCountMessage(
  intl: {
    formatMessage(descriptor: { id: string }, values?: Record<string, string | number>): string;
  },
  id: string,
  count: number,
  values: Record<string, string | number> = {},
): string {
  return intl.formatMessage({ id: count === 1 ? `${id}One` : id }, { count, ...values });
}
