import type { DatabaseSync } from "node:sqlite";
import { resolveWorkspaceKey, type ZCodeTaskMeta } from "@zcode/shared";

type TaskGroupSystemKind = "cron" | "off-peak";
type TaskGroupAdmissionFact = Pick<
  ZCodeTaskMeta,
  "workspacePath" | "workspaceIdentity" | "taskId" | "cronAutomationId" | "offPeakTaskId"
> & {
  createdAt?: number;
  archived?: boolean;
  deleted?: boolean;
  /** 调用方已确认的系统分组类型（例如系统分组维护路径）；缺省由任务标记推导。 */
  systemKind?: TaskGroupSystemKind;
};
export interface TaskGroupAdmissionPlacement {
  task: Pick<ZCodeTaskMeta, "workspacePath" | "workspaceIdentity" | "taskId">;
  groupId: string | null;
  creationId: string;
}

interface AdmissionRow {
  system_kind: string | null;
  user_organized: number;
  creation_id: string | null;
}

function transaction<T>(db: DatabaseSync, run: () => T): T {
  const own = !db.isTransaction;
  if (own) db.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    if (own) db.exec("COMMIT");
    return result;
  } catch (error) {
    // 回滚失败不能替换原始异常；falsy thrown value 也必须原样抛出。
    if (own && db.isTransaction) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* 保留首因 */
      }
    }
    throw error;
  }
}

function nodeKey(
  task: Pick<TaskGroupAdmissionFact, "workspacePath" | "workspaceIdentity" | "taskId">,
) {
  return JSON.stringify([resolveWorkspaceKey(task), task.taskId]);
}

function systemKindOf(task: TaskGroupAdmissionFact): TaskGroupSystemKind | null {
  if (task.systemKind) return task.systemKind;
  return task.cronAutomationId ? "cron" : task.offPeakTaskId ? "off-peak" : null;
}

/**
 * 首次发现/首次系统类型登记，沿用 tasks-index 的唯一分组仓储（不新建 group store）。
 * - 已存在成员关系或排序节点即视为用户已整理，后续系统归属标记不再改它。
 * - creationId 是创建回执：只记录第一次，迟到回包不能覆盖用户后续整理。
 * - 删除事实保留登记墓碑，避免缺少 deleted 的旧投影重新入组。
 * 没有调用方事务时自建事务；syncTaskMeta 等已持有写事务的路径用 applyTaskGroupFacts。
 */
export function admitTaskGroupFacts(
  db: DatabaseSync,
  tasks: readonly TaskGroupAdmissionFact[],
  placement?: TaskGroupAdmissionPlacement,
): void {
  transaction(db, () => {
    applyTaskGroupFacts(db, tasks, placement);
  });
}

/**
 * 事务内版本：调用方已持有写事务（例如 syncTaskMeta 的 task 行 + 组织 + admission 同事务）。
 * 这里不 BEGIN/COMMIT，失败由调用方整体回滚，避免出现“登记成功但成员关系失败”的孤儿。
 */
export function applyTaskGroupFacts(
  db: DatabaseSync,
  tasks: readonly TaskGroupAdmissionFact[],
  placement?: TaskGroupAdmissionPlacement,
): void {
  // 批量首次发现按创建时间从旧到新写入；以后活动更新不重排已登记节点。
  for (const task of [...tasks].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))) {
    const workspaceKey = resolveWorkspaceKey(task);
    const key = nodeKey(task);
    if (task.deleted) {
      db.prepare("DELETE FROM task_group_members WHERE workspace_key=? AND task_id=?").run(
        workspaceKey,
        task.taskId,
      );
      db.prepare(
        "DELETE FROM task_group_view_node_orders WHERE node_type='task' AND node_key=?",
      ).run(key);
      db.prepare(
        `INSERT INTO task_group_admissions(workspace_key,task_id,user_organized) VALUES(?,?,1)
         ON CONFLICT(workspace_key,task_id) DO UPDATE SET user_organized=1`,
      ).run(workspaceKey, task.taskId);
      continue;
    }
    let admission = db
      .prepare("SELECT * FROM task_group_admissions WHERE workspace_key=? AND task_id=?")
      .get(workspaceKey, task.taskId) as unknown as AdmissionRow | undefined;
    if (!admission) {
      const legacy =
        Boolean(
          db
            .prepare("SELECT 1 FROM task_group_members WHERE workspace_key=? AND task_id=?")
            .get(workspaceKey, task.taskId),
        ) ||
        Boolean(
          db
            .prepare(
              "SELECT 1 FROM task_group_view_node_orders WHERE node_type='task' AND node_key=?",
            )
            .get(key),
        );
      db.prepare(
        "INSERT INTO task_group_admissions(workspace_key,task_id,user_organized) VALUES(?,?,?)",
      ).run(workspaceKey, task.taskId, legacy ? 1 : 0);
      admission = { system_kind: null, user_organized: legacy ? 1 : 0, creation_id: null };
    }
    const systemKind = systemKindOf(task);
    // 只有第一次确认系统类型才登记；不能把读列表变成重复覆盖用户整理的自愈。
    if (systemKind && admission.system_kind === null)
      db.prepare(
        "UPDATE task_group_admissions SET system_kind=? WHERE workspace_key=? AND task_id=?",
      ).run(systemKind, workspaceKey, task.taskId);
  }
  if (!placement) return;
  const workspaceKey = resolveWorkspaceKey(placement.task);
  const existing = db
    .prepare("SELECT creation_id FROM task_group_admissions WHERE workspace_key=? AND task_id=?")
    .get(workspaceKey, placement.task.taskId) as { creation_id: string | null } | undefined;
  // 首次回执优先；迟到创建回包不改已有回执，也不复活/移动用户整理后的节点。
  if (existing && existing.creation_id === null)
    db.prepare(
      "UPDATE task_group_admissions SET creation_id=? WHERE workspace_key=? AND task_id=?",
    ).run(placement.creationId, workspaceKey, placement.task.taskId);
}
