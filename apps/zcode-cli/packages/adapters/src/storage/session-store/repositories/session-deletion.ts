// 会话永久删除的持久事实：跨进程删除凭据、运行态登记、owned tree/附件引用预检与正文清理。
// 规格：`.agents/specs/upstream-3.18-project-data.md` §4；上游 3.18.2 `0025_session_permanent_deletion`。
// 单事务边界由调用方（RepositorySurface）持有；这里不建第二份连接，也不复制 owned tree 规则。
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  SessionDeletionReference,
  SessionDeletionSnapshot,
  SessionId,
} from "@zcode/contracts";
import { listOwnedSessionTrees, purgeSessions } from "./sessions.js";

const ARTIFACT_URI = /zcode-artifact:\/\/([^/"\\\s]+)\/([^"\\\s/?#]+)/g;
const ARTIFACT_URI_PREFIX = "zcode-artifact://";

/** 本进程运行态 owner：pid 用于跨进程存活判断，uuid 区分同 pid 的重开连接。 */
export function newRuntimeOwnerId(): string {
  return `${process.pid}:${randomUUID()}`;
}

export function registerSessionRuntime(
  db: DatabaseSync,
  ownerId: string,
  sessionID: SessionId,
): void {
  // 删除凭据存在时由 `session_purge_runtime_guard` 触发器拒绝，不能靠调用方自律。
  db.prepare(
    "insert or ignore into session_runtime_presence(session_id,owner_id,process_id) values(?,?,?)",
  ).run(sessionID, ownerId, process.pid);
}

export function unregisterSessionRuntime(
  db: DatabaseSync,
  ownerId: string,
  sessionID: SessionId,
): void {
  db.prepare("delete from session_runtime_presence where session_id=? and owner_id=?").run(
    sessionID,
    ownerId,
  );
}

/** 连接关闭：本 owner 的行全部失效，不能留下永远“活着”的残留运行态。 */
export function clearSessionRuntimePresence(db: DatabaseSync, ownerId: string): void {
  db.prepare("delete from session_runtime_presence where owner_id=?").run(ownerId);
}

/** `process.kill(pid, 0)` 的等价语义：ESRCH → 已退出；其它错误按存活保守处理。 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function collectReferences(
  db: DatabaseSync,
  inside: ReadonlySet<string>,
): SessionDeletionReference[] {
  const references = new Map<string, SessionDeletionReference>();
  const sources = [
    ["part", "session_id", "data"],
    ["message", "session_id", "data"],
    ["session_input", "session_id", "payload"],
    ["session_entry", "session_id", "data"],
    ["session", "id", "revert"],
    ["input_history", "session_id", "attachments"],
  ] as const;
  const queries = sources.map(
    ([table, id, data]) =>
      `select t.${id} as session_id,t.${data} as body,s.title from ${table} t join session s on s.id=t.${id} where s.time_deleted is null and instr(t.${data}, '${ARTIFACT_URI_PREFIX}')>0`,
  );
  // 工作流 journal 的产物不一定进入消息 part，必须沿 run 的会话归属检查。
  for (const [table, owner, columns] of [
    ["dwf_run", null, ["args_json", "result_json", "failure_json"]],
    ["workflow_run", null, ["args_json", "stats_json", "failure_json"]],
    ["dwf_node", "dwf_run", ["input_json", "result_json", "error_json"]],
    ["dwf_event", "dwf_run", ["payload_json"]],
    ["dwf_actor", "dwf_run", ["persona_json"]],
    ["workflow_activity", "workflow_run", ["prompt", "opts_json", "result_json", "error_json"]],
    ["workflow_event", "workflow_run", ["payload_json"]],
  ] as const) {
    const body = columns.map((column) => `coalesce(t.${column},'')`).join(" || ' ' || ");
    queries.push(
      `select s.id as session_id,${body} as body,s.title from ${table} t ${owner ? `join ${owner} r on r.id=t.run_id` : ""} join session s on s.id=${owner ? "r" : "t"}.parent_session_id where s.time_deleted is null and instr(${body},'${ARTIFACT_URI_PREFIX}')>0`,
    );
  }
  for (const query of queries) {
    const rows = db.prepare(query).iterate() as Iterable<{
      session_id: SessionId;
      body: string;
      title: string;
    }>;
    for (const row of rows) {
      // 被删树自身的引用不会阻止自己的删除。
      if (inside.has(row.session_id)) continue;
      for (const match of row.body.matchAll(ARTIFACT_URI)) {
        const sessionId = decodeURIComponent(match[1]!) as SessionId;
        const artifactId = decodeURIComponent(match[2]!);
        if (!inside.has(sessionId)) continue;
        const key = `${sessionId}/${artifactId}`;
        const entry = references.get(key) ?? { sessionId, artifactId, referrers: [] };
        if (!entry.referrers.some((ref) => ref.sessionId === row.session_id))
          entry.referrers.push({ sessionId: row.session_id, title: row.title });
        references.set(key, entry);
      }
    }
  }
  return [...references.values()].sort((a, b) =>
    `${a.sessionId}/${a.artifactId}`.localeCompare(`${b.sessionId}/${b.artifactId}`),
  );
}

/**
 * 只读预检。删除凭据一旦写入即以凭据中的 ID 集为准：文件已删、正文未删时，
 * 重试必须继续同一计划，而不是按当前谱系重算出一份更小的树。
 */
export function inspectSessionDeletion(
  db: DatabaseSync,
  root: SessionId,
  ownerId: string,
): SessionDeletionSnapshot {
  const receipt = db
    .prepare(
      "select session_id,retained_artifacts,state from session_purge where root_id=? order by session_id",
    )
    .all(root) as Array<{ session_id: SessionId; retained_artifacts: string; state: string }>;
  const ids = receipt.length
    ? receipt.map((row) => row.session_id)
    : (listOwnedSessionTrees(db, [root]).get(root) ?? []);
  const inside = new Set<string>(ids);
  const forks: SessionDeletionSnapshot["forks"] = [];
  for (const row of db
    .prepare(
      "select id as sessionId,title,parent_id from session where time_deleted is null order by id",
    )
    .iterate() as Iterable<{ sessionId: SessionId; title: string; parent_id: string | null }>) {
    if (row.parent_id && inside.has(row.parent_id) && !inside.has(row.sessionId))
      forks.push({ sessionId: row.sessionId, title: row.title });
  }
  const references = collectReferences(db, inside);
  for (const row of receipt) {
    for (const artifactId of JSON.parse(row.retained_artifacts) as string[]) {
      const key = `${row.session_id}/${artifactId}`;
      if (!references.some((ref) => `${ref.sessionId}/${ref.artifactId}` === key))
        references.push({ sessionId: row.session_id, artifactId, referrers: [] });
    }
  }
  references.sort((a, b) =>
    `${a.sessionId}/${a.artifactId}`.localeCompare(`${b.sessionId}/${b.artifactId}`),
  );
  for (const ref of references)
    ref.referrers.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  let foreignRuntime = false;
  const localRuntimeIds: SessionId[] = [];
  for (const row of db
    .prepare("select session_id,owner_id,process_id from session_runtime_presence")
    .all() as Array<{ session_id: string; owner_id: string; process_id: number }>) {
    if (!inside.has(row.session_id)) continue;
    if (row.owner_id === ownerId) {
      localRuntimeIds.push(row.session_id as SessionId);
      continue;
    }
    if (processAlive(row.process_id)) foreignRuntime = true;
    else
      db.prepare("delete from session_runtime_presence where session_id=? and owner_id=?").run(
        row.session_id,
        row.owner_id,
      );
  }
  // 已有删除凭据时不再把“正在写入”当阻塞：凭据本身已阻止新写入。
  const pendingWork =
    !receipt.length &&
    ids.some((id) =>
      Boolean(
        db
          .prepare("select 1 from session_input where session_id=? and status='admitted' limit 1")
          .get(id) ||
        db
          .prepare("select 1 from session_target where session_id=? and status='active' limit 1")
          .get(id),
      ),
    );
  const facts = ids.map((id) =>
    db.prepare("select id,time_updated,time_deleted from session where id=?").get(id),
  );
  const revision = createHash("sha256")
    .update(JSON.stringify({ ids, facts, forks, references, pendingWork }))
    .digest("hex");
  const workspace =
    db.prepare("select directory as path,workspace_id as identity from session where id=?").get(root) ??
    db
      .prepare(
        "select workspace_path as path,workspace_identity as identity from session_purge where session_id=?",
      )
      .get(root);
  return {
    workspacePath: workspace?.path as string | undefined,
    workspaceIdentity: (workspace?.identity ?? undefined) as string | undefined,
    revision,
    sessionIds: ids,
    forks,
    references,
    foreignRuntime,
    localRuntimeIds,
    pendingWork,
    deleting: receipt.some((row) => row.state === "deleting"),
    completed: receipt.length > 0 && receipt.every((row) => row.state === "deleted"),
  };
}

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/** 准入：同一事务内复查预检事实；只有凭据不存在时才写入，重复调用幂等。 */
export function beginSessionDeletion(
  db: DatabaseSync,
  root: SessionId,
  ownerId: string,
  revision: string,
  operationId: string,
  retained: ReadonlyArray<{ sessionId: SessionId; artifactId: string }>,
): void {
  db.exec("begin immediate");
  try {
    const snapshot = inspectSessionDeletion(db, root, ownerId);
    if (snapshot.foreignRuntime || snapshot.pendingWork)
      throw codedError("session-data.running", "running");
    if (!snapshot.deleting && !snapshot.completed) {
      if (snapshot.revision !== revision || !snapshot.sessionIds.length)
        throw codedError("session-data.changed", "changed");
      const insert = db.prepare(
        "insert into session_purge(session_id,root_id,operation_id,retained_artifacts,workspace_path,workspace_identity,state) values(?,?,?,?,?,?,'deleting')",
      );
      for (const id of snapshot.sessionIds)
        insert.run(
          id,
          root,
          operationId,
          JSON.stringify(
            retained.filter((ref) => ref.sessionId === id).map((ref) => ref.artifactId),
          ),
          snapshot.workspacePath ?? "",
          snapshot.workspaceIdentity ?? null,
        );
    }
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}

/** 文件已清理后才删除正文；凭据独立于 session，重启和旧 create 不能复活同一 ID。 */
export function completeSessionDeletion(db: DatabaseSync, root: SessionId): void {
  const ids = db
    .prepare("select session_id from session_purge where root_id=?")
    .all(root) as Array<{ session_id: SessionId }>;
  purgeSessions(
    db,
    ids.map((row) => row.session_id),
  );
  db.prepare("update session_purge set state='deleted' where root_id=?").run(root);
}
