import type {
  ProjectTask,
  ProjectTaskGroup,
  ProjectTaskGroupStructure,
  ProjectTaskGroupTopOrder,
} from "./contract.js";
import { projectTaskWorkspaceKey } from "./view.js";

/** 组成员身份与 taskIndexRepo 一致：workspaceKey + taskId。 */
export function projectGroupTaskKey(
  task: Pick<ProjectTask, "workspacePath" | "workspaceIdentity" | "taskId">,
): string {
  return JSON.stringify([projectTaskWorkspaceKey(task), task.taskId]);
}

export type ProjectGroupedRow =
  | { type: "group"; key: string; group: ProjectTaskGroup }
  | { type: "task"; key: string; task: ProjectTask; groupId: string | null }
  | { type: "empty"; key: string; groupId: string };

function compareGroupedTasks(left: ProjectTask, right: ProjectTask): number {
  return (
    (right.updatedAt ?? 0) - (left.updatedAt ?? 0) ||
    (right.createdAt ?? 0) - (left.createdAt ?? 0) ||
    right.taskId.localeCompare(left.taskId)
  );
}

/**
 * 分组视图只消费 Host 树 + taskIndexRepo 结构：
 * - 任务存在性来自 tree.tasks，结构里的不可见成员（归档/置顶/已删除）保留但不渲染；
 * - 没进结构的未分组任务补在顶层，不能因结构缺序而丢行；
 * - pinned/archived 由调用方先行排除，本函数不写任何事实。
 */
export function buildProjectGroupedRows(
  tasks: readonly ProjectTask[],
  structure: ProjectTaskGroupStructure | undefined,
  collapsed: ReadonlySet<string>,
): ProjectGroupedRow[] {
  const visible = new Map(
    tasks
      .filter((task) => !task.pinned && !task.archived)
      .map((task) => [projectGroupTaskKey(task), task]),
  );
  if (!structure) {
    return [...visible.entries()]
      .map(
        ([key, task]): ProjectGroupedRow => ({
          type: "task",
          key: `task:${key}`,
          task,
          groupId: null,
        }),
      )
      .sort((left, right) =>
        left.type === "task" && right.type === "task"
          ? compareGroupedTasks(left.task, right.task)
          : 0,
      );
  }

  const groups = new Map(structure.groups.map((group) => [group.id, group]));
  const memberKeys = new Set<string>();
  const members = new Map<string, ProjectTask[]>();
  for (const member of [...structure.members].sort(
    (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0),
  )) {
    if (!groups.has(member.groupId)) continue;
    const key = JSON.stringify([member.workspaceKey, member.taskId]);
    memberKeys.add(key);
    const task = visible.get(key);
    if (!task) continue;
    const rows = members.get(member.groupId) ?? [];
    rows.push(task);
    members.set(member.groupId, rows);
  }

  const root: ProjectTaskGroupTopOrder[] = [...structure.topLevelOrders].sort(
    (a, b) => a.sortOrder - b.sortOrder,
  );
  const ordered = new Set(
    root.map((row) =>
      row.type === "group"
        ? `group:${row.groupId}`
        : `task:${JSON.stringify([row.workspaceKey, row.taskId])}`,
    ),
  );
  for (const group of structure.groups) {
    if (!ordered.has(`group:${group.id}`)) {
      root.push({ type: "group", groupId: group.id, sortOrder: 0 });
    }
  }
  for (const key of visible.keys()) {
    if (!ordered.has(`task:${key}`) && !memberKeys.has(key)) {
      root.push({
        type: "task",
        workspaceKey: JSON.parse(key)[0] as string,
        taskId: JSON.parse(key)[1] as string,
        sortOrder: 0,
      });
    }
  }

  return root.flatMap((node): ProjectGroupedRow[] => {
    if (node.type === "task") {
      const key = JSON.stringify([node.workspaceKey, node.taskId]);
      const task = visible.get(key);
      return task && !memberKeys.has(key)
        ? [{ type: "task", key: `task:${key}`, task, groupId: null }]
        : [];
    }
    const group = groups.get(node.groupId);
    if (!group) return [];
    const header: ProjectGroupedRow = { type: "group", key: `group:${group.id}`, group };
    if (collapsed.has(group.id)) return [header];
    const children = members.get(group.id) ?? [];
    return [
      header,
      ...(children.length
        ? children.map(
            (task): ProjectGroupedRow => ({
              type: "task",
              key: `task:${projectGroupTaskKey(task)}`,
              task,
              groupId: group.id,
            }),
          )
        : [{ type: "empty" as const, key: `empty:${group.id}`, groupId: group.id }]),
    ];
  });
}

/** 只统计当前可见行，供组头 badge；不把不可见成员算进 UI 数。 */
export function countTasksByGroup(rows: readonly ProjectGroupedRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.type !== "task" || !row.groupId) continue;
    counts.set(row.groupId, (counts.get(row.groupId) ?? 0) + 1);
  }
  return counts;
}

/** 只重排当前可见行；不可见成员由原仓储保留，不在 UI 侧复制组事实。 */
export function moveProjectGroupedTask(
  rows: readonly ProjectGroupedRow[],
  task: ProjectTask,
  targetGroupId: string | null,
): ProjectGroupedRow[] {
  const taskRowKey = `task:${projectGroupTaskKey(task)}`;
  const sourceIndex = rows.findIndex((row) => row.key === taskRowKey);
  if (sourceIndex < 0) return [...rows];
  const next = [...rows];
  const [taskRow] = next.splice(sourceIndex, 1);
  if (!taskRow) return [...rows];
  if (targetGroupId === null) {
    next.unshift({ ...taskRow, groupId: null } as ProjectGroupedRow);
    return next;
  }
  const groupIndex = next.findIndex(
    (row) => row.type === "group" && row.group.id === targetGroupId,
  );
  if (groupIndex < 0) return [...rows];
  next.splice(groupIndex + 1, 0, { ...taskRow, groupId: targetGroupId } as ProjectGroupedRow);
  return next;
}
