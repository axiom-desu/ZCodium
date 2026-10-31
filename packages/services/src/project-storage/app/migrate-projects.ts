import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { buildRemoteWorkspaceIdentity } from "@zcode/shared";
import type { ProjectMigrationContext } from "#src/project-storage/domain/contract.js";
import {
  ensureHost,
  initializeLegacyTaskIdentity,
  OWNERSHIP_DECIDED,
  uniqueRootProject,
} from "#src/project-storage/app/legacy-tasks.js";
import {
  legacyWorkspaceJson,
  sanitizedTarget,
  savedRootName,
} from "#src/project-storage/domain/saved-workspace.js";
import { addProjectSchema, tableExists } from "#src/project-storage/app/schema.js";

function createProject(
  db: DatabaseSync,
  hostId: string,
  name: string,
  roots: string[],
  overridden: boolean,
  now: number,
): string {
  let uniqueName = name || "新项目";
  for (
    let suffix = 2;
    db
      .prepare("SELECT 1 FROM projects WHERE host_id=? AND name=? AND deleted=0")
      .get(hostId, uniqueName);
    suffix++
  )
    uniqueName = `${name} (${suffix})`;
  const id = randomUUID();
  db.prepare(`INSERT INTO projects(project_id,host_id,name,name_overridden,position,created_at,updated_at)
    VALUES(?,?,?,?,(SELECT count(*) FROM projects WHERE host_id=?),?,?)`).run(
    id,
    hostId,
    uniqueName,
    overridden ? 1 : 0,
    hostId,
    now,
    now,
  );
  roots.forEach((root, index) =>
    db
      .prepare(
        "INSERT INTO project_roots(project_id,root_path,position,is_primary) VALUES(?,?,?,?)",
      )
      .run(id, root, index, index === 0 ? 1 : 0),
  );
  return id;
}

/**
 * 首次项目集合只来自 composition 注入的旧已保存 workspace 列表与顺序；
 * 不从历史会话/任务组/最近项目推断，也不导入远端连接 profile（R3 未接入）。
 */
export function migrateProjects(db: DatabaseSync, context: ProjectMigrationContext): void {
  // 首次 seed 依赖旧 settings；缺失时不能记账再永久丢掉导入机会。
  if (!context.settings) throw new Error("project.settings-required");
  const now = (context.now ?? Date.now)();
  const ownerHostId = context.hostId;
  const localOwner = !ownerHostId || ownerHostId === "local";
  const localHostId = localOwner ? "local" : ownerHostId;
  addProjectSchema(db);
  ensureHost(db, "local", ownerHostId);
  initializeLegacyTaskIdentity(db, false, ownerHostId);
  const workspaces = new Map<string, { path: string; hostId: string }>();
  const importedEntries = new Set<string>();
  for (const entry of context.settings?.lastWorkspaceSession ?? []) {
    if (entry.kind === "local" && entry.workspacePurpose !== "conversation") {
      workspaces.set(entry.workspacePath, { path: entry.workspacePath, hostId: localHostId });
      continue;
    }
    // 远端项目只经本机入口缓存进入侧栏；远端持库 Host 的入口由远端投影负责。
    if (entry.kind !== "remote" || !localOwner) continue;
    let identity: string;
    try {
      identity =
        entry.workspaceIdentity ?? buildRemoteWorkspaceIdentity(entry.workspacePath, entry.target);
    } catch {
      // 旧 server 缺已鉴权 serverId 且没有既有 identity 时无法证明 authority，保持未导入。
      continue;
    }
    // 身份无法证明时保持未导入，不按路径伪造 Host，也不回落到 local。
    if (importedEntries.has(identity)) continue;
    const hostId = ensureHost(db, identity);
    if (!hostId) continue;
    importedEntries.add(identity);
    db.prepare(
      "UPDATE hosts SET target_json=coalesce(target_json,?),last_connection_status=?,last_connection_error=?,last_opened_at=? WHERE host_id=?",
    ).run(
      JSON.stringify(sanitizedTarget(entry)),
      entry.lastConnectionStatus,
      entry.lastConnectionError ?? null,
      entry.lastOpenedAt,
      hostId,
    );
    db.prepare(`INSERT INTO remote_project_entries(entry_id,host_id,cached_name,cached_roots_json,legacy_workspace_json)
      VALUES(?,?,?,?,?)`).run(
      randomUUID(),
      hostId,
      savedRootName(entry.workspacePath),
      JSON.stringify([{ rootPath: entry.workspacePath, position: 0, isPrimary: true }]),
      legacyWorkspaceJson(entry),
    );
  }
  for (const row of db
    .prepare("SELECT host_id FROM hosts WHERE target_json IS NOT NULL AND membership_id IS NULL")
    .all()) {
    // membership_id 是本地 tasks-index 自己持有的持久 membership 标识（上游 3.16.2 在
    // composition 迁移中同样生成），不是远端握手/授权事实：不拿它当远端 authority，
    // 只保证同一 Host 首次写入后稳定，重跑不重新生成。
    db.prepare("UPDATE hosts SET membership_id=? WHERE host_id=? AND membership_id IS NULL").run(
      randomUUID(),
      String(row.host_id),
    );
  }
  for (const [key, workspace] of workspaces) {
    const projectId = createProject(
      db,
      workspace.hostId,
      savedRootName(workspace.path),
      [workspace.path],
      false,
      now,
    );
    if (tableExists(db, "tasks"))
      db.prepare("UPDATE tasks SET project_id=? WHERE workspace_key=?").run(projectId, key);
  }
  // 分组与项目独立；升级只按 workspace 建项目，不能改写分组成员的项目归属。
  if (tableExists(db, "tasks")) {
    for (const row of db
      .prepare(
        "SELECT workspace_key,task_id,host_id,root_path FROM tasks WHERE project_id IS NULL AND host_id IS NOT NULL",
      )
      .all() as { workspace_key: string; task_id: string; host_id: string; root_path: string }[]) {
      db.prepare("UPDATE tasks SET project_id=? WHERE workspace_key=? AND task_id=?").run(
        uniqueRootProject(db, row.host_id, row.root_path),
        row.workspace_key,
        row.task_id,
      );
    }
    db.exec(`UPDATE tasks SET handoff_pending=handoff_pending | ${OWNERSHIP_DECIDED}`);
    const duplicate = db
      .prepare(
        "SELECT host_id,task_id,count(*) AS count FROM tasks WHERE host_id IS NOT NULL GROUP BY host_id,task_id HAVING count(*)>1 LIMIT 1",
      )
      .get();
    db.exec(
      `CREATE ${duplicate ? "" : "UNIQUE "}INDEX IF NOT EXISTS idx_tasks_host_task ON tasks(host_id,task_id)`,
    );
    if (duplicate)
      context.warn?.("历史 task ID 存在冲突，host/task 索引暂用非唯一索引", {
        // 只输出阶段/表/计数；不输出 host_id/task_id/user@host 等用户身份。
        table: "tasks",
        stage: "0005_projects",
        groupCount: Number(duplicate.count),
      });
  }
  for (const table of ["automations", "off_peak_tasks"]) {
    if (!tableExists(db, table)) continue;
    for (const row of db
      .prepare(`SELECT DISTINCT workspace_key,workspace_path FROM ${table}`)
      .all() as {
      workspace_key: string;
      workspace_path: string;
    }[]) {
      const hostId = ensureHost(db, row.workspace_key, ownerHostId);
      if (!hostId) continue;
      // 远端身份 key 与 settings 的真实目录不同；调度定义也按同 Host 的 root 归入已保存项目。
      db.prepare(
        `UPDATE ${table} SET host_id=?,project_id=?,additional_directories='[]' WHERE workspace_key=?`,
      ).run(hostId, uniqueRootProject(db, hostId, row.workspace_path), row.workspace_key);
    }
  }
}
