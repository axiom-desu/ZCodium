import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { buildRemoteWorkspaceIdentity } from "@zcode/shared";
import type { ProjectMigrationContext } from "#src/project-storage/contract.js";
import { projectStorage } from "#src/project-storage/index.js";

const resources: Array<{ db: DatabaseSync; directory: string }> = [];
afterEach(async () => {
  for (const { db, directory } of resources.splice(0)) {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

type SessionEntry = NonNullable<
  NonNullable<ProjectMigrationContext["settings"]>["lastWorkspaceSession"]
>[number];

function remoteEntry(workspacePath: string, workspaceIdentity: string): SessionEntry {
  return {
    kind: "remote",
    workspacePath,
    workspaceIdentity,
    target: { kind: "ssh", host: "example.test", username: "user", port: 22 },
    lastOpenedAt: 7,
    lastConnectionStatus: "connected",
  };
}

async function fixture(entries: SessionEntry[] = []) {
  const directory = await mkdtemp(join(tmpdir(), "zcode-project-foundation-"));
  const db = new DatabaseSync(join(directory, "tasks-index.sqlite"));
  resources.push({ db, directory });
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE tasks (
      workspace_key TEXT NOT NULL, workspace_path TEXT NOT NULL, workspace_identity TEXT,
      task_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', task_status TEXT,
      provider TEXT DEFAULT 'glm', mode TEXT NOT NULL DEFAULT 'build', model TEXT,
      migration_source TEXT, forked_from_task_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, unread_at INTEGER,
      last_unread_at INTEGER NOT NULL DEFAULT 0, pinned INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0,
      title_overridden INTEGER NOT NULL DEFAULT 0, meta_json TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY(workspace_key, task_id));
    CREATE TABLE task_groups(group_id TEXT PRIMARY KEY,title TEXT,color TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE task_group_members(group_id TEXT,workspace_key TEXT,workspace_path TEXT,workspace_identity TEXT,task_id TEXT,sort_order INTEGER);
    CREATE TABLE task_group_workspace_bootstraps(workspace_key TEXT PRIMARY KEY,group_id TEXT);
    CREATE TABLE task_group_view_node_orders(node_type TEXT,node_key TEXT,sort_order INTEGER);
    CREATE TABLE automations(automation_id TEXT PRIMARY KEY,workspace_key TEXT,workspace_path TEXT);
    CREATE TABLE off_peak_tasks(off_peak_task_id TEXT PRIMARY KEY,workspace_key TEXT,workspace_path TEXT);
    CREATE TABLE untouched(id TEXT PRIMARY KEY,value TEXT);
    INSERT INTO untouched VALUES ('keep','unchanged');`);
  const add = (taskId: string, workspacePath: string, identity?: string) =>
    db
      .prepare(
        "INSERT INTO tasks(workspace_key,workspace_path,workspace_identity,task_id,title,created_at,updated_at) VALUES(?,?,?,?,?,1,2)",
      )
      .run(identity ?? workspacePath, workspacePath, identity ?? null, taskId, `title ${taskId}`);
  return {
    db,
    add,
    directory,
    context: {
      backupDirectories: [join(directory, "backup")],
      now: () => 10,
      settings: {
        recentProjects: [],
        lastWorkspaceSession: entries,
      },
    } satisfies ProjectMigrationContext,
  };
}

describe("project-storage migration", () => {
  it("creates the organization schema on an empty Host database", async () => {
    const { db, context } = await fixture();
    const result = await projectStorage.migrate(db, context);
    expect(result.applied).toEqual([
      "0005_projects",
      "0006_default_workspace_tasks",
      "0007_initial_workspace_order",
      "0008_task_creation_reservations",
    ]);
    // 预留 receipt 表只追加、不并入 0005；空库也必须有它，否则预占写入会静默降级。
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='task_creation_reservations'",
        )
        .get(),
    ).toEqual({ name: "task_creation_reservations" });
    expect(db.prepare("SELECT count(*) AS n FROM projects").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM hosts WHERE host_id='local'").get()).toEqual({
      n: 1,
    });
    expect(await projectStorage.migrate(db, context)).toMatchObject({ applied: [] });
  });

  it("seeds the first project set only from injected saved workspaces, in original order", async () => {
    const { db, add, context } = await fixture([
      { kind: "local", workspacePath: "/work/a" },
      { kind: "local", workspacePath: "/work/b" },
    ]);
    add("a", "/work/a");
    add("b", "/work/b");
    db.exec("UPDATE tasks SET deleted=1 WHERE task_id='b'");
    await projectStorage.migrate(db, context);
    const projects = db
      .prepare("SELECT name,position,deleted FROM projects ORDER BY position")
      .all();
    expect(projects).toEqual([
      { name: "a", position: 0, deleted: 0 },
      { name: "b", position: 1, deleted: 0 },
    ]);
    const owners = db
      .prepare(
        "SELECT task_id,host_id,project_id,cli_title,cli_deleted FROM tasks ORDER BY task_id",
      )
      .all();
    expect(owners[0]).toMatchObject({ task_id: "a", host_id: "local", cli_title: "title a" });
    expect(owners[0]?.project_id).toBeTruthy();
    // 删除行保留事实与组织关系；可见查询仍由 deleted 过滤。
    expect(owners[1]).toMatchObject({ task_id: "b", host_id: "local", cli_deleted: 0 });
    expect(owners[1]?.project_id).toBeTruthy();
    expect(db.prepare("SELECT count(*) AS n FROM tasks WHERE deleted=1").get()).toEqual({ n: 1 });
    // 幂等：不重排、不新增项目。
    await projectStorage.migrate(db, context);
    expect(db.prepare("SELECT name,position FROM projects ORDER BY position").all()).toEqual([
      { name: "a", position: 0 },
      { name: "b", position: 1 },
    ]);
  });

  it("never derives projects from conversation entries, history, groups or recentProjects", async () => {
    const { db, add, context } = await fixture([
      { kind: "local", workspacePath: "/conv", workspacePurpose: "conversation" },
    ]);
    add("history", "/history");
    add("conv", "/conv");
    db.exec("INSERT INTO task_groups VALUES ('g','Group','blue',1,2)");
    await projectStorage.migrate(db, context);
    expect(db.prepare("SELECT count(*) AS n FROM projects").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM tasks WHERE project_id IS NULL").get()).toEqual({
      n: 2,
    });
    expect(db.prepare("SELECT count(*) AS n FROM task_groups").get()).toEqual({ n: 1 });
  });

  it("keeps same-path remote identities isolated and stores no credential target", async () => {
    const sshA = "remote:ssh:example.test:22:user:/repo";
    const sshB = "remote:ssh:other.test:22:user:/repo";
    const { db, add, context } = await fixture([
      remoteEntry("/repo", sshA),
      remoteEntry("/repo", sshB),
    ]);
    add("a", "/repo", sshA);
    add("b", "/repo", sshB);
    await projectStorage.migrate(db, context);
    expect(db.prepare("SELECT host_id FROM remote_project_entries ORDER BY host_id").all()).toEqual(
      [
        { host_id: "remote:ssh:example.test:22:user" },
        { host_id: "remote:ssh:other.test:22:user" },
      ],
    );
    expect(db.prepare("SELECT count(*) AS n FROM projects").get()).toEqual({ n: 0 });
    const hosts = db.prepare("SELECT target_json FROM hosts WHERE target_json IS NOT NULL").all();
    expect(hosts).toHaveLength(2);
    for (const host of hosts) {
      expect(host.target_json).not.toMatch(/password|privateKey|passphrase/i);
      expect(JSON.parse(String(host.target_json))).toMatchObject({ kind: "ssh" });
    }
    // 远端任务不因同路径合并成同一条组织事实。
    const rows = db
      .prepare("SELECT workspace_key,host_id,project_id FROM tasks ORDER BY task_id")
      .all();
    expect(rows).toEqual([
      { workspace_key: sshA, host_id: "remote:ssh:example.test:22:user", project_id: null },
      { workspace_key: sshB, host_id: "remote:ssh:other.test:22:user", project_id: null },
    ]);
  });

  it("leaves unprovable authority unassigned and readable instead of coercing to local", async () => {
    const { db, add, context } = await fixture();
    add("broken", "/repo", "remote:not-a-real-identity");
    await projectStorage.migrate(db, context);
    expect(
      db.prepare("SELECT workspace_key,host_id,project_id,cli_title FROM tasks").get(),
    ).toEqual({
      workspace_key: "remote:not-a-real-identity",
      host_id: null,
      project_id: null,
      cli_title: null,
    });
    expect(db.prepare("SELECT count(*) AS n FROM hosts").get()).toEqual({ n: 1 });
  });

  it("adds only missing task columns on a partially migrated database", async () => {
    const { db, add, context } = await fixture();
    add("kept", "/work/a");
    db.exec(
      "ALTER TABLE tasks ADD COLUMN host_id TEXT; ALTER TABLE tasks ADD COLUMN project_id TEXT",
    );
    db.exec("UPDATE tasks SET host_id='local'");
    await projectStorage.migrate(db, context);
    const columns = db
      .prepare(
        "SELECT name FROM pragma_table_info('tasks') WHERE name IN ('cli_created_at','execution_directories','handoff_pending') ORDER BY name",
      )
      .all();
    expect(columns).toEqual([
      { name: "cli_created_at" },
      { name: "execution_directories" },
      { name: "handoff_pending" },
    ]);
    expect(db.prepare("SELECT task_id,host_id FROM tasks").get()).toEqual({
      task_id: "kept",
      host_id: "local",
    });
  });

  it("rejects a conflicting historical ledger checksum without rewriting rows", async () => {
    const { db, context } = await fixture();
    db.exec(`CREATE TABLE schema_migration(id TEXT PRIMARY KEY, checksum TEXT NOT NULL, app_version TEXT, applied_at INTEGER NOT NULL);
      INSERT INTO schema_migration VALUES('0005_projects','deadbeef','3.12.0',1)`);
    await expect(projectStorage.migrate(db, context)).rejects.toMatchObject({
      migrationId: "0005_projects",
    });
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects'").get(),
    ).toBeUndefined();
  });

  it("keeps membership_id stable per Host and sanitizes duplicate logs", async () => {
    const entry = remoteEntry("/repo-a", "remote:ssh:corp.example:22:alice:/repo-a");
    const { db, context } = await fixture([entry]);
    const insertTask = db.prepare(
      "INSERT INTO tasks(workspace_key,workspace_path,workspace_identity,task_id,title,created_at,updated_at) VALUES(?,?,?,?,?,1,2)",
    );
    const keyA = buildRemoteWorkspaceIdentity("/repo-a", entry.target!);
    const keyB = buildRemoteWorkspaceIdentity("/repo-b", entry.target!);
    insertTask.run(keyA, "/repo-a", keyA, "dup-task", "a");
    insertTask.run(keyB, "/repo-b", keyB, "dup-task", "b");
    const warnings: unknown[] = [];
    context.warn = (_message, details) => warnings.push(details);
    await projectStorage.migrate(db, context);
    const first = db
      .prepare("SELECT host_id,membership_id FROM hosts WHERE target_json IS NOT NULL")
      .all() as Array<{ host_id: string; membership_id: string }>;
    expect(first).toHaveLength(1);
    expect(first[0]!.membership_id).toBeTruthy();
    await projectStorage.migrate(db, context);
    expect(
      db.prepare("SELECT host_id,membership_id FROM hosts WHERE target_json IS NOT NULL").all(),
    ).toEqual(first);
    // 重复行诊断上传阶段/表/计数，不包含 host_id、task_id 或 user@host。
    expect(warnings.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(warnings);
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain("corp.example");
    expect(serialized).not.toContain("dup-task");
    expect(warnings[0]).toMatchObject({ table: "tasks", groupCount: 2 });
  });

  it("soft-deletes the unedited system default container once, keeping task rows", async () => {
    const { db, add, context } = await fixture([
      { kind: "local", workspacePath: "/home/u/.zcode/workspace/default" },
    ]);
    add("system", "/home/u/.zcode/workspace/default");
    await projectStorage.migrate(db, context);
    expect(db.prepare("SELECT deleted FROM projects").get()).toEqual({ deleted: 1 });
    expect(db.prepare("SELECT project_id FROM tasks").get()).toEqual({ project_id: null });
  });
});
