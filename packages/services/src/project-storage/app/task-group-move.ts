import type { DatabaseSync } from "node:sqlite";
import { resolveWorkspaceKey } from "@zcode/shared";
import type {
  ProjectTaskGroupMoveInput,
  ProjectTaskGroupNode,
  ProjectTaskGroupStructure,
} from "#src/project-storage/domain/contract.js";
import { tableExists } from "#src/project-storage/app/schema.js";
import {
  readProjects,
  readTask,
  readTaskGroupStructure,
} from "#src/project-storage/project-repository-read.js";

/**
 * 分组手势/菜单的单节点事务内核。
 *
 * 这里只写被移动节点与目标层级的相对位置，不接收“当前可见快照”：
 * - 任务的来源 group 与目标锚点都在同一 SQLite 事务内复检，任一过期即拒绝；
 * - 不可见成员（其它 Host/项目、被过滤、归档、无 CLI 事实）继续保留在原 group/order，不因本次拖拽被删除；
 * - 与 readTree 共用 task_groups / task_group_members / task_group_view_node_orders。
 *
 * 排序写集是**完整原始层级**（`visibleOnly=false` 的全部行 + 缺 order 行的 group），不是某个视图的可见快照。
 * 旧实现按可见集合重新编号，视图外的 group/任务行保留旧 ordinal，与本次新号段碰撞后会按
 * `ORDER BY sort_order,workspace_key,task_id` 换位；因此可见性只用于授权，不参与写集。
 */
const GROUP_ORDER_STEP = 1000;

interface TaskIndexMoveRow {
  workspace_key: string;
  workspace_path: string;
  workspace_identity: string | null;
  host_id: string;
  deleted: number;
  archived: number;
  cli_deleted: number | null;
}

type OrderedNode =
  | { type: "group"; groupId: string; key: string }
  | { type: "task"; workspaceKey: string; taskId: string; key: string };

function groupNodeKey(groupId: string): string {
  return `g:${groupId}`;
}

function taskNodeKey(workspaceKey: string, taskId: string): string {
  return `t:${JSON.stringify([workspaceKey, taskId])}`;
}

function requireGroupTables(db: DatabaseSync): void {
  for (const table of ["task_groups", "task_group_members", "task_group_view_node_orders"]) {
    if (!tableExists(db, table)) throw new Error("task-group.unavailable");
  }
}

function ownerWorkspaceKeys(db: DatabaseSync, ownerHostId: string): Set<string> {
  const keys = new Set<string>();
  for (const row of db
    .prepare("SELECT DISTINCT workspace_key FROM tasks WHERE host_id=?")
    .all(ownerHostId) as Array<{ workspace_key: string }>) {
    keys.add(String(row.workspace_key));
  }
  for (const project of readProjects(db).filter((project) => project.hostId === ownerHostId)) {
    for (const root of project.roots) keys.add(root.rootPath);
  }
  return keys;
}

/** 完整兄弟层：读全库原始行，不做视图过滤（写集与授权集合必须分开取）。 */
function readFullStructure(db: DatabaseSync): ProjectTaskGroupStructure {
  requireGroupTables(db);
  const structure = readTaskGroupStructure(db);
  if (!structure) throw new Error("task-group.unavailable");
  return structure;
}

/** 只有授权用可见集合：来源/目标 group 与 group 锚点必须属于当前 Host。 */
function readVisibleGroupIds(db: DatabaseSync, ownerHostId: string): Set<string> {
  requireGroupTables(db);
  const structure = readTaskGroupStructure(db, ownerWorkspaceKeys(db, ownerHostId));
  if (!structure) throw new Error("task-group.unavailable");
  return new Set(structure.groups.map((group) => group.id));
}

function requireTaskNode(
  db: DatabaseSync,
  node: Extract<ProjectTaskGroupNode, { type: "task" }>,
  ownerHostId: string,
): { workspaceKey: string; taskId: string; ref: ProjectTaskGroupNode & { type: "task" } } {
  if (node.task.hostId !== ownerHostId) throw new Error("task-group.cross-host");
  const row = readTask(db, node.task) as TaskIndexMoveRow | undefined;
  if (!row || row.host_id !== ownerHostId) throw new Error("task-group.task-unavailable");
  if (row.deleted === 1 || row.archived === 1 || row.cli_deleted === 1) {
    throw new Error("task-group.task-unavailable");
  }
  // 身份必须和 Host 任务行一致：同 path 不同远端、或调用方拿错 workspace 都拒绝。
  if (String(row.workspace_path) !== node.task.workspacePath) {
    throw new Error("task-group.workspace-mismatch");
  }
  const rowIdentity = row.workspace_identity?.trim() ?? "";
  if (rowIdentity !== (node.task.workspaceIdentity?.trim() ?? "")) {
    throw new Error("task-group.authority-mismatch");
  }
  return {
    workspaceKey: resolveWorkspaceKey(node.task),
    taskId: node.task.taskId,
    ref: node,
  };
}

function memberParent(
  structure: ProjectTaskGroupStructure,
  workspaceKey: string,
  taskId: string,
): string | null {
  return (
    structure.members.find(
      (member) => member.workspaceKey === workspaceKey && member.taskId === taskId,
    )?.groupId ?? null
  );
}

function memberOrder(
  left: { sortOrder: number | null; addedAt: number },
  right: { sortOrder: number | null; addedAt: number },
): number {
  return (left.sortOrder ?? -left.addedAt) - (right.sortOrder ?? -right.addedAt);
}

function children(structure: ProjectTaskGroupStructure, groupId: string | null): OrderedNode[] {
  if (groupId) {
    return [...structure.members]
      .filter((member) => member.groupId === groupId)
      .sort(
        (left, right) =>
          memberOrder(left, right) ||
          left.workspaceKey.localeCompare(right.workspaceKey) ||
          left.taskId.localeCompare(right.taskId),
      )
      .map((member) => ({
        type: "task",
        workspaceKey: member.workspaceKey,
        taskId: member.taskId,
        key: taskNodeKey(member.workspaceKey, member.taskId),
      }));
  }

  // 顶层写集 = 全部原始 order 行（含视图外 group、悬空 group）
  // + 尚未有 order 行的 group + 已归组任务的残留顶层行。它们都占用同一层 ordinal，
  // 只重排“可渲染子集”会留下与本次新号段碰撞的旧号，读取端按 sort_order 就会换位。
  // 这里既不删行也不改 membership：视图外节点只是拿到新号，相对顺序由排序后的插入顺序保留。
  const memberKeys = new Set(
    structure.members.map((member) => taskNodeKey(member.workspaceKey, member.taskId)),
  );
  const nodes: OrderedNode[] = [];
  const seen = new Set<string>();
  const push = (node: OrderedNode) => {
    if (seen.has(node.key)) return;
    seen.add(node.key);
    nodes.push(node);
  };
  // 已归组任务的顶层残留行不能被渲染为顶层节点（读取端同样按 membership 排除），
  // 但仍要重编号：否则它保留旧号，与其它同层节点撞号。放到层尾，不影响任何可见顺序。
  const staleMemberRows: OrderedNode[] = [];
  for (const row of [...structure.topLevelOrders].sort(
    (left, right) => left.sortOrder - right.sortOrder,
  )) {
    if (row.type === "group") {
      push({ type: "group", groupId: row.groupId, key: groupNodeKey(row.groupId) });
      continue;
    }
    const node: OrderedNode = {
      type: "task",
      workspaceKey: row.workspaceKey,
      taskId: row.taskId,
      key: taskNodeKey(row.workspaceKey, row.taskId),
    };
    if (memberKeys.has(node.key)) {
      staleMemberRows.push(node);
      continue;
    }
    push(node);
  }
  for (const group of structure.groups) {
    push({ type: "group", groupId: group.id, key: groupNodeKey(group.id) });
  }
  for (const node of staleMemberRows) push(node);
  return nodes;
}

/** 同一 node_key 只保留首次出现位置；不写重复 ordinal，也不删任何行。 */
function dedupeNodes(nodes: readonly OrderedNode[]): OrderedNode[] {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    if (seen.has(node.key)) return false;
    seen.add(node.key);
    return true;
  });
}

function writeOrder(
  db: DatabaseSync,
  nodes: readonly OrderedNode[],
  groupId: string | null,
  now: number,
): void {
  nodes.forEach((node, index) => {
    const sortOrder = (index + 1) * GROUP_ORDER_STEP;
    if (groupId) {
      if (node.type !== "task") return;
      db.prepare(
        `UPDATE task_group_members
         SET sort_order=?, updated_at=?
         WHERE group_id=? AND workspace_key=? AND task_id=?`,
      ).run(sortOrder, now, groupId, node.workspaceKey, node.taskId);
      return;
    }
    db.prepare(
      `INSERT INTO task_group_view_node_orders(node_type,node_key,sort_order,created_at,updated_at)
       VALUES(?,?,?,?,?)
       ON CONFLICT(node_type,node_key) DO UPDATE SET
         sort_order=excluded.sort_order,
         updated_at=excluded.updated_at`,
    ).run(node.type === "group" ? "group" : "task", node.key.slice(2), sortOrder, now, now);
  });
}

function markOrganized(db: DatabaseSync, workspaceKey: string, taskId: string): void {
  if (!tableExists(db, "task_group_admissions")) return;
  db.prepare(
    `INSERT INTO task_group_admissions(workspace_key,task_id,user_organized) VALUES(?,?,1)
     ON CONFLICT(workspace_key,task_id) DO UPDATE SET user_organized=1`,
  ).run(workspaceKey, taskId);
}

function nodeKeyOf(node: ProjectTaskGroupNode): string {
  return node.type === "group"
    ? groupNodeKey(node.groupId)
    : taskNodeKey(resolveWorkspaceKey(node.task), node.task.taskId);
}

export function moveTaskGroupNode(
  db: DatabaseSync,
  input: ProjectTaskGroupMoveInput,
  ownerHostId: string,
  now = Date.now(),
): void {
  const structure = readFullStructure(db);
  const groupIds = readVisibleGroupIds(db, ownerHostId);
  const sourceKey = nodeKeyOf(input.node);

  let sourceGroupId: string | null = null;
  let sourceTask: { workspaceKey: string; taskId: string } | null = null;
  if (input.node.type === "group") {
    if (input.sourceGroupId !== null) throw new Error("task-group.stale-source");
    if (input.groupId !== null) throw new Error("task-group.invalid-group");
    if (!groupIds.has(input.node.groupId)) throw new Error("task-group.not-found");
  } else {
    const task = requireTaskNode(db, input.node, ownerHostId);
    sourceTask = { workspaceKey: task.workspaceKey, taskId: task.taskId };
    sourceGroupId = memberParent(structure, task.workspaceKey, task.taskId);
    if (sourceGroupId !== input.sourceGroupId) throw new Error("task-group.stale-source");
    // 来源组必须同样在当前 Host 可见结构内；不能借 stale command 操作其它 workspace 的 bootstrap 组。
    if (sourceGroupId !== null && !groupIds.has(sourceGroupId)) {
      throw new Error("task-group.stale-source");
    }
  }
  if (input.groupId && !groupIds.has(input.groupId)) throw new Error("task-group.not-found");

  const destination = children(structure, input.groupId).filter(
    (candidate) => candidate.key !== sourceKey,
  );
  let anchorIndex = -1;
  if (input.anchor) {
    if (input.anchor.node.type === "group" && input.groupId !== null) {
      throw new Error("task-group.stale-anchor");
    }
    // 锚点在完整层里可见即可定位，但 group 锚点仍须属于当前 Host，避免 stale 命令跨 Host 排序。
    if (input.anchor.node.type === "group" && !groupIds.has(input.anchor.node.groupId)) {
      throw new Error("task-group.stale-anchor");
    }
    if (input.anchor.node.type === "task") {
      const anchorTask = input.anchor.node;
      const anchorFact = requireTaskNode(db, anchorTask, ownerHostId);
      const anchorParent = memberParent(structure, anchorFact.workspaceKey, anchorFact.taskId);
      if (anchorParent !== input.groupId) throw new Error("task-group.stale-anchor");
    }
    anchorIndex = destination.findIndex(
      (candidate) => candidate.key === nodeKeyOf(input.anchor!.node),
    );
    if (anchorIndex < 0) throw new Error("task-group.stale-anchor");
  }

  const node: OrderedNode =
    input.node.type === "group"
      ? { type: "group", groupId: input.node.groupId, key: sourceKey }
      : {
          type: "task",
          workspaceKey: resolveWorkspaceKey(input.node.task),
          taskId: input.node.task.taskId,
          key: sourceKey,
        };
  destination.splice(
    anchorIndex < 0 ? 0 : anchorIndex + (input.anchor?.side === "after" ? 1 : 0),
    0,
    node,
  );

  if (input.node.type === "task" && sourceTask) {
    markOrganized(db, sourceTask.workspaceKey, sourceTask.taskId);
    db.prepare("DELETE FROM task_group_members WHERE workspace_key=? AND task_id=?").run(
      sourceTask.workspaceKey,
      sourceTask.taskId,
    );
    if (input.groupId) {
      db.prepare(
        `INSERT INTO task_group_members(
          group_id,workspace_key,workspace_path,workspace_identity,task_id,
          sort_order,added_at,created_at,updated_at
        ) VALUES(?,?,?,?,?,0,?,?,?)`,
      ).run(
        input.groupId,
        sourceTask.workspaceKey,
        input.node.task.workspacePath,
        input.node.task.workspaceIdentity ?? null,
        sourceTask.taskId,
        now,
        now,
        now,
      );
    }
  }
  writeOrder(db, destination, input.groupId, now);
}

/** 取消分组：成员按原组块位置回到顶层，包含当前过滤条件外的成员。 */
export function ungroupTaskGroup(db: DatabaseSync, groupId: string, now = Date.now()): void {
  const structure = readFullStructure(db);
  if (!structure.groups.some((group) => group.id === groupId)) {
    throw new Error("Task group 不存在，无法删除");
  }
  const groupKey = groupNodeKey(groupId);
  const members = children(structure, groupId);
  // 取消分组时成员会在原组块位置重新出现，层尾的归组残留行因此重复；只保留拼接后的首次位置。
  const root = dedupeNodes(
    children(structure, null).flatMap((node) => (node.key === groupKey ? members : [node])),
  );
  for (const member of members) {
    if (member.type !== "task") continue;
    markOrganized(db, member.workspaceKey, member.taskId);
  }
  db.prepare("DELETE FROM task_group_members WHERE group_id=?").run(groupId);
  db.prepare("DELETE FROM task_groups WHERE group_id=?").run(groupId);
  db.prepare("DELETE FROM task_group_view_node_orders WHERE node_type='group' AND node_key=?").run(
    groupId,
  );
  writeOrder(db, root, null, now);
}
