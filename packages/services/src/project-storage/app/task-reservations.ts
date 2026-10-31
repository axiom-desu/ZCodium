import type { DatabaseSync } from "node:sqlite";
import { resolveWorkspaceKey } from "@zcode/shared";
import type {
  ProjectTaskRef,
  ProjectTaskReservationSettlement,
} from "#src/project-storage/domain/contract.js";
import { tableExists } from "#src/project-storage/app/schema.js";
import { OWNERSHIP_DECIDED } from "#src/project-storage/app/legacy-tasks.js";

/**
 * draft 创建预留的 owner receipt。
 *
 * 背景：v4 `createSession` 由 Host 在 CLI 首发前预占 tasks 空行（created_at=0），携带项目归属与
 * 冻结执行目录。草稿会话是纯内存的，项目切换/预热 dispose 只发 `deleteSession`，CLI 不会发出
 * `session.removed`，`applyCliDeletion` 因此永不执行；旧实现留下永久不可见的预留行（占用项目
 * 归属与目录快照）。
 *
 * 所有权：receipt 与空行在同一写事务产生（唯一 owner 仍是 ProjectRepository），只记录
 * 「这次预占属于谁、冻结了什么」，不是第二个任务 owner，也不参与列表/树读取。
 *
 * 释放判据（任一不成立即保留任务行，只丢弃 receipt）：
 * 1. receipt 与命令目标的 workspace/task/host 完全一致；
 * 2. 行仍是本次预占的空行：没有任何 CLI 事实、没有被 pin/archive/删除/改标题/已读；
 *    project_id 与 execution_directories 仍与 receipt 快照逐字段相等；
 * 3. 没有被用户整理的证据（分组 membership、user_organized admission、顶层 order 行）；
 * 4. 调用方已拿到 CLI 关闭回执（Host 侧的 deleteSession accepted/noop），且该会话从未转发过输入。
 *
 * 输入屏障由调用方（Host 命令路径）在转发前先清掉 receipt 完成：CLI 持久会话只能由首条输入产生，
 * 所以「CLI 已接受但 sessions-index 帧在途、cli_created_at 仍为 NULL」的窗口里 receipt 已不存在。
 * 不等待、不超时、不按 cli_created_at NULL 猜，也绝不删已接受/用户整理/未知来源历史任务。
 */
export const TASK_RESERVATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS task_creation_reservations (
 reservation_id TEXT PRIMARY KEY,
 workspace_key TEXT NOT NULL,
 task_id TEXT NOT NULL,
 host_id TEXT NOT NULL,
 project_id TEXT,
 execution_directories TEXT,
 created_at INTEGER NOT NULL,
 UNIQUE(workspace_key, task_id)
);
CREATE INDEX IF NOT EXISTS idx_task_creation_reservations_host
 ON task_creation_reservations(host_id);
`;

const TASK_RESERVATION_TABLE = "task_creation_reservations";

interface ReservationRow {
  reservation_id: string;
  workspace_key: string;
  task_id: string;
  host_id: string;
  project_id: string | null;
  execution_directories: string | null;
}

const RETAINED: ProjectTaskReservationSettlement = { released: false, reason: "claimed" };

function hasReceiptTable(db: DatabaseSync): boolean {
  return tableExists(db, TASK_RESERVATION_TABLE);
}

/**
 * 写入本次预占的 receipt。与空行同事务调用；shapshot 取自写入后的最终行状态，
 * 因此 execution_directories 冻结快照与任务行始终一致。重复预占命中同一行时不重建 receipt。
 */
export function insertTaskReservationReceipt(
  db: DatabaseSync,
  input: { workspaceKey: string; taskId: string; hostId: string; now: number },
): void {
  if (!hasReceiptTable(db)) return;
  const row = db
    .prepare(
      "SELECT project_id,execution_directories FROM tasks WHERE workspace_key=? AND task_id=?",
    )
    .get(input.workspaceKey, input.taskId) as
    | { project_id: string | null; execution_directories: string | null }
    | undefined;
  if (!row) return;
  db.prepare(
    `INSERT INTO task_creation_reservations(
      reservation_id,workspace_key,task_id,host_id,project_id,execution_directories,created_at)
     VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(workspace_key,task_id) DO NOTHING`,
  ).run(
    `reservation-${input.hostId}-${input.taskId}`,
    input.workspaceKey,
    input.taskId,
    input.hostId,
    row.project_id,
    row.execution_directories,
    input.now,
  );
}

/** CLI 事实到达 = 该行已是任务事实镜像，预占不再是可释放对象（同一事务内丢弃 receipt）。 */
export function forgetTaskReservationReceipt(
  db: DatabaseSync,
  input: { workspaceKey: string; taskId: string },
): void {
  if (!hasReceiptTable(db)) return;
  db.prepare("DELETE FROM task_creation_reservations WHERE workspace_key=? AND task_id=?").run(
    input.workspaceKey,
    input.taskId,
  );
}

function readReceipt(
  db: DatabaseSync,
  workspaceKey: string,
  taskId: string,
  hostId: string,
): ReservationRow | undefined {
  return db
    .prepare(
      "SELECT * FROM task_creation_reservations WHERE workspace_key=? AND task_id=? AND host_id=?",
    )
    .get(workspaceKey, taskId, hostId) as ReservationRow | undefined;
}

/** 未被任何 CLI 事实/用户操作触碰过的空预留行；任何一项被写过都算已认领。 */
function isUnclaimedReservationRow(row: Record<string, unknown>, receipt: ReservationRow): boolean {
  const empty = [
    "cli_created_at",
    "cli_updated_at",
    "cli_deleted",
    "cli_title",
    "cli_title_source",
    "cli_last_outcome",
    "task_status",
    "unread_at",
  ];
  if (empty.some((column) => row[column] != null)) return false;
  if (Number(row.created_at) !== 0) return false;
  if (Number(row.deleted) !== 0 || Number(row.archived) !== 0 || Number(row.pinned) !== 0)
    return false;
  if (Number(row.title_overridden) !== 0) return false;
  // 只允许预占时写入的 OWNERSHIP_DECIDED 位；其它交接位表示别的写入路径碰过这一行。
  if ((Number(row.handoff_pending ?? 0) & ~OWNERSHIP_DECIDED) !== 0) return false;
  const projectId = row.project_id == null ? null : String(row.project_id);
  if (projectId !== receipt.project_id) return false;
  const directories = row.execution_directories == null ? null : String(row.execution_directories);
  return directories === receipt.execution_directories;
}

/** 用户整理优先：分组/用户排序/手工 admission 任一存在都不得删除任务行。 */
function isUserOrganized(db: DatabaseSync, workspaceKey: string, taskId: string): boolean {
  const member = db
    .prepare("SELECT 1 FROM task_group_members WHERE workspace_key=? AND task_id=?")
    .get(workspaceKey, taskId);
  if (member) return true;
  if (tableExists(db, "task_group_view_node_orders")) {
    const order = db
      .prepare("SELECT 1 FROM task_group_view_node_orders WHERE node_type='task' AND node_key=?")
      .get(JSON.stringify([workspaceKey, taskId]));
    if (order) return true;
  }
  if (tableExists(db, "task_group_admissions")) {
    const admission = db
      .prepare(
        "SELECT 1 FROM task_group_admissions WHERE workspace_key=? AND task_id=? AND user_organized=1",
      )
      .get(workspaceKey, taskId);
    if (admission) return true;
  }
  return false;
}

/**
 * 预留收口（唯一入口，调用方已持有写事务）：
 * - `input-forwarded`：只丢弃 receipt，行留给 CLI 事实；
 * - `cli-closed`：CLI 关闭回执后释放仍未认领的空行；不能证明未认领时保留行与冻结目录。
 */
export function settleTaskReservation(
  db: DatabaseSync,
  task: ProjectTaskRef,
  hostId: string,
  outcome: "cli-closed" | "input-forwarded",
): ProjectTaskReservationSettlement {
  if (!hasReceiptTable(db)) return { released: false, reason: "unavailable" };
  const workspaceKey = resolveWorkspaceKey(task);
  const receipt = readReceipt(db, workspaceKey, task.taskId, hostId);
  if (!receipt) return { released: false, reason: "not-reserved" };
  const dropReceipt = () =>
    db
      .prepare("DELETE FROM task_creation_reservations WHERE reservation_id=?")
      .run(receipt.reservation_id);
  if (outcome === "input-forwarded") {
    dropReceipt();
    return { released: false, reason: "input-forwarded" };
  }
  const row = db
    .prepare("SELECT * FROM tasks WHERE workspace_key=? AND task_id=?")
    .get(workspaceKey, task.taskId) as Record<string, unknown> | undefined;
  if (!row) {
    dropReceipt();
    return { released: false, reason: "task-missing" };
  }
  if (!isUnclaimedReservationRow(row, receipt)) {
    dropReceipt();
    return RETAINED;
  }
  if (isUserOrganized(db, workspaceKey, task.taskId)) {
    dropReceipt();
    return { released: false, reason: "organized" };
  }
  db.prepare("DELETE FROM tasks WHERE workspace_key=? AND task_id=?").run(
    workspaceKey,
    task.taskId,
  );
  dropReceipt();
  return { released: true, reason: "released" };
}
