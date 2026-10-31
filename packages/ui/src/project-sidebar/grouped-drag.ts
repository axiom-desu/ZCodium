import type { ProjectTaskGroupMoveInput, ProjectTaskGroupNode } from "./contract.js";
import type { ProjectGroupedRow } from "./grouped.js";

/** 拖拽来源只引用当前行；提交时才从同一行构造 typed group 命令。 */
export type ProjectGroupedDragSource =
  | { type: "group"; rowKey: string; groupId: string }
  | { type: "task"; rowKey: string };

/** 指针悬停的落点；side 由指针相对目标行中线决定。 */
export type ProjectGroupedDropTarget =
  | { zone: "task"; rowKey: string; side: "before" | "after" }
  | { zone: "group-header"; groupId: string; side: "before" | "after" }
  | { zone: "group-empty"; groupId: string };

function removeSource(
  rows: ProjectGroupedRow[],
  source: ProjectGroupedDragSource,
): { next: ProjectGroupedRow[]; row: ProjectGroupedRow | null } {
  const index = rows.findIndex((row) => row.key === source.rowKey);
  if (index < 0) return { next: rows, row: null };
  if (source.type === "task") {
    const next = [...rows];
    const [row] = next.splice(index, 1);
    return { next, row: row ?? null };
  }
  let end = index + 1;
  while (end < rows.length) {
    const row = rows[end];
    if (!row) break;
    if (row.type === "group") break;
    if (row.type === "task" && row.groupId === null) break;
    end += 1;
  }
  const block = rows.slice(index, end);
  return { next: [...rows.slice(0, index), ...rows.slice(end)], row: block[0] ?? null };
}

function groupBlockEnd(rows: readonly ProjectGroupedRow[], groupId: string): number {
  const start = rows.findIndex((row) => row.type === "group" && row.group.id === groupId);
  if (start < 0) return -1;
  let end = start + 1;
  while (end < rows.length) {
    const row = rows[end];
    if (!row) break;
    if (row.type === "group") break;
    if (row.type === "task" && row.groupId === null) break;
    end += 1;
  }
  return end;
}

function dropEmptyForGroup(rows: ProjectGroupedRow[], groupId: string): ProjectGroupedRow[] {
  return rows.filter((row) => !(row.type === "empty" && row.groupId === groupId));
}

function insertTaskPreview(
  rows: ProjectGroupedRow[],
  source: Extract<ProjectGroupedRow, { type: "task" }>,
  target: ProjectGroupedDropTarget,
): ProjectGroupedRow[] {
  const { next, row } = removeSource(rows, { type: "task", rowKey: source.key });
  if (!row || row.type !== "task") return rows;
  if (target.zone === "task") {
    const overIndex = next.findIndex((candidate) => candidate.key === target.rowKey);
    if (overIndex < 0) return rows;
    const over = next[overIndex];
    if (!over || over.type !== "task") return rows;
    const targetGroupId = over.groupId;
    const cleaned = targetGroupId === null ? next : dropEmptyForGroup(next, targetGroupId);
    const insertIndex = cleaned.findIndex((candidate) => candidate.key === target.rowKey);
    const moved = { ...source, groupId: targetGroupId };
    const result = [...cleaned];
    result.splice(insertIndex + (target.side === "after" ? 1 : 0), 0, moved);
    return result;
  }
  if (target.zone === "group-header") {
    const groupId = target.groupId;
    const headerIndex = next.findIndex(
      (candidate) => candidate.type === "group" && candidate.group.id === groupId,
    );
    if (headerIndex < 0) return rows;
    const cleaned = dropEmptyForGroup(next, groupId);
    const moved = target.side === "before" ? { ...source, groupId: null } : { ...source, groupId };
    const index = cleaned.findIndex(
      (candidate) => candidate.type === "group" && candidate.group.id === groupId,
    );
    const result = [...cleaned];
    result.splice(index + (target.side === "before" ? 0 : 1), 0, moved);
    return result;
  }
  const groupId = target.groupId;
  const headerIndex = next.findIndex(
    (candidate) => candidate.type === "group" && candidate.group.id === groupId,
  );
  if (headerIndex < 0) return rows;
  const cleaned = dropEmptyForGroup(next, groupId);
  const result = [...cleaned];
  const index = result.findIndex(
    (candidate) => candidate.type === "group" && candidate.group.id === groupId,
  );
  result.splice(index + 1, 0, { ...source, groupId });
  return result;
}

function insertGroupPreview(
  rows: ProjectGroupedRow[],
  source: ProjectGroupedDragSource,
  target: ProjectGroupedDropTarget,
): ProjectGroupedRow[] {
  if (source.type !== "group") return rows;
  const index = rows.findIndex((row) => row.key === source.rowKey);
  if (index < 0) return rows;
  let end = index + 1;
  while (end < rows.length) {
    const row = rows[end];
    if (!row) break;
    if (row.type === "group") break;
    if (row.type === "task" && row.groupId === null) break;
    end += 1;
  }
  const block = rows.slice(index, end);
  const next = [...rows.slice(0, index), ...rows.slice(end)];

  if (target.zone === "group-empty") {
    const targetIndex = next.findIndex(
      (row) => row.type === "group" && row.group.id === target.groupId,
    );
    if (targetIndex < 0) return rows;
    const insertIndex = groupBlockEnd(next, target.groupId);
    const result = [...next];
    result.splice(insertIndex < 0 ? result.length : insertIndex, 0, ...block);
    return result;
  }
  if (target.zone === "group-header") {
    const targetIndex = next.findIndex(
      (row) => row.type === "group" && row.group.id === target.groupId,
    );
    if (targetIndex < 0) return rows;
    const insertIndex =
      target.side === "before" ? targetIndex : groupBlockEnd(next, target.groupId);
    const result = [...next];
    result.splice(insertIndex < 0 ? result.length : insertIndex, 0, ...block);
    return result;
  }
  if (target.zone === "task") {
    const targetIndex = next.findIndex((row) => row.key === target.rowKey);
    if (targetIndex < 0) return rows;
    const targetRow = next[targetIndex];
    if (!targetRow) return rows;
    if (targetRow.type === "group") {
      const insertIndex =
        target.side === "before" ? targetIndex : groupBlockEnd(next, targetRow.group.id);
      const result = [...next];
      result.splice(insertIndex, 0, ...block);
      return result;
    }
    if (targetRow.type === "task" && targetRow.groupId) {
      const headerIndex = next.findIndex(
        (row) => row.type === "group" && row.group.id === targetRow.groupId,
      );
      if (headerIndex < 0) return rows;
      const insertIndex =
        target.side === "before" ? headerIndex : groupBlockEnd(next, targetRow.groupId);
      const result = [...next];
      result.splice(insertIndex, 0, ...block);
      return result;
    }
    const result = [...next];
    result.splice(targetIndex + (target.side === "after" ? 1 : 0), 0, ...block);
    return result;
  }
  return rows;
}

/** 只生成临时 hover 预览，不写持久化；Esc/取消时由调用方丢弃。 */
export function previewProjectGroupedDrag(
  rows: readonly ProjectGroupedRow[],
  source: ProjectGroupedDragSource,
  target: ProjectGroupedDropTarget,
): ProjectGroupedRow[] {
  const base = [...rows];
  if (source.type === "task") {
    const row = base.find((candidate) => candidate.key === source.rowKey);
    if (!row || row.type !== "task") return base;
    return insertTaskPreview(base, row, target);
  }
  return insertGroupPreview(base, source, target);
}

function siblingRows(
  rows: readonly ProjectGroupedRow[],
  groupId: string | null,
): ProjectGroupedRow[] {
  if (groupId === null) {
    return rows.filter(
      (row) => row.type === "group" || (row.type === "task" && row.groupId === null),
    );
  }
  return rows.filter((row) => row.type === "task" && row.groupId === groupId);
}

function rowGroupId(row: ProjectGroupedRow): string | null {
  return row.type === "task" ? row.groupId : null;
}

function nodeFromRow(row: ProjectGroupedRow): ProjectTaskGroupNode | null {
  if (row.type === "group") return { type: "group", groupId: row.group.id };
  if (row.type !== "task") return null;
  return {
    type: "task",
    task: {
      workspacePath: row.task.workspacePath,
      ...(row.task.workspaceIdentity ? { workspaceIdentity: row.task.workspaceIdentity } : {}),
      taskId: row.task.taskId,
      hostId: row.task.hostId,
    },
  };
}

/**
 * 从 origin 与 preview 提取“单节点 + 相邻锚点”命令。
 * 不提交整棵可见快照，因此不可见成员和其原有顺序不会被覆盖。
 */
export function buildProjectGroupedMoveCommand(
  origin: readonly ProjectGroupedRow[],
  preview: readonly ProjectGroupedRow[],
  source: ProjectGroupedDragSource,
): ProjectTaskGroupMoveInput | null {
  const beforeRow = origin.find((row) => row.key === source.rowKey);
  const afterRow = preview.find((row) => row.key === source.rowKey);
  if (!beforeRow || !afterRow) return null;
  const beforeGroupId = rowGroupId(beforeRow);
  const afterGroupId = rowGroupId(afterRow);
  const beforeSiblings = siblingRows(origin, beforeGroupId);
  const afterSiblings = siblingRows(preview, afterGroupId);
  const beforeIndex = beforeSiblings.findIndex((row) => row.key === source.rowKey);
  const afterIndex = afterSiblings.findIndex((row) => row.key === source.rowKey);
  if (beforeIndex < 0 || afterIndex < 0) return null;
  if (beforeGroupId === afterGroupId && beforeIndex === afterIndex) return null;

  const node = nodeFromRow(afterRow);
  if (!node) return null;
  const next = afterSiblings[afterIndex + 1];
  const previous = afterSiblings[afterIndex - 1];
  const anchorRow = next ?? previous;
  const anchorNode = anchorRow ? nodeFromRow(anchorRow) : null;
  return {
    node,
    sourceGroupId: beforeGroupId,
    groupId: afterGroupId,
    ...(anchorNode ? { anchor: { node: anchorNode, side: next ? "before" : "after" } } : {}),
  };
}

export function projectGroupedRowsSignature(rows: readonly ProjectGroupedRow[]): string {
  return rows
    .map((row) =>
      row.type === "task"
        ? `${row.key}@${row.groupId ?? ""}`
        : row.type === "group"
          ? `g:${row.group.id}`
          : `empty:${row.groupId}`,
    )
    .join("|");
}

/** 拖拽预览仍遵守当前折叠状态；折叠组只显示组头，不因预览擅自展开持久状态。 */
export function collapseProjectGroupedRows(
  rows: readonly ProjectGroupedRow[],
  collapsed: ReadonlySet<string>,
): ProjectGroupedRow[] {
  const result: ProjectGroupedRow[] = [];
  let groupId: string | null = null;
  let visibleTasks = 0;
  const flush = () => {
    if (groupId && !collapsed.has(groupId) && visibleTasks === 0) {
      result.push({ type: "empty", key: `empty:${groupId}`, groupId });
    }
  };
  for (const row of rows) {
    if (row.type === "group") {
      flush();
      result.push(row);
      groupId = row.group.id;
      visibleTasks = 0;
      continue;
    }
    if (row.type === "empty") continue;
    if (row.groupId) {
      if (collapsed.has(row.groupId)) {
        visibleTasks += 1;
        continue;
      }
      visibleTasks += 1;
    }
    result.push(row);
  }
  flush();
  return result;
}
