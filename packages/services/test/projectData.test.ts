import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectService } from "#src/project/index.js";
import type { ProjectDataPort } from "#src/project/domain/data-contract.js";
import { projectStorage } from "#src/project-storage/index.js";

const resources: Array<{ db: DatabaseSync; directory: string }> = [];
afterEach(async () => {
  for (const { db, directory } of resources.splice(0)) {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function taskRow(
  db: DatabaseSync,
  input: { taskId: string; projectId: string | null; rootPath: string; deleted?: boolean },
) {
  db.prepare(
    `INSERT INTO tasks(workspace_key,workspace_path,workspace_identity,task_id,title,created_at,updated_at,provider,
       host_id,root_path,project_id,deleted,cli_deleted,handoff_pending)
     VALUES(?,?,?,?,?,1,2,'glm','local',?,?,?,?,0)`,
  ).run(
    input.rootPath,
    input.rootPath,
    null,
    input.taskId,
    `title ${input.taskId}`,
    input.rootPath,
    input.projectId,
    input.deleted ? 1 : 0,
    input.deleted ? 1 : 0,
  );
}

/** 真实 sqlite tasks-index + 内存数据端口：目录/字节由测试注入，宿主行操作走真实仓储。 */
async function fixture(portOverrides: Partial<ProjectDataPort> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "zcode-project-data-"));
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
    CREATE TABLE task_group_members (
      group_id TEXT NOT NULL, workspace_key TEXT NOT NULL, task_id TEXT NOT NULL,
      sort_order INTEGER, added_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(group_id, workspace_key, task_id));
    CREATE TABLE task_group_admissions (
      workspace_key TEXT NOT NULL, task_id TEXT NOT NULL, user_organized INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(workspace_key, task_id));
    CREATE TABLE automations (
      id TEXT PRIMARY KEY, workspace_key TEXT, workspace_path TEXT, project_id TEXT, host_id TEXT);
    CREATE TABLE off_peak_tasks (
      id TEXT PRIMARY KEY, workspace_key TEXT, workspace_path TEXT, project_id TEXT, host_id TEXT);`);
  await projectStorage.migrate(db, {
    backupDirectories: [join(directory, "backup")],
    settings: { lastWorkspaceSession: [], recentProjects: [] },
  });
  const repo = () => projectStorage.repository(db);
  const purged: string[] = [];
  const purgedDirectories: string[] = [];
  const port: ProjectDataPort = {
    measure: async ({ sessions, directories }) => ({
      sessions: sessions.map((session) => ({ sessionId: session.sessionId, bytes: 10 })),
      directories: directories.map((path) => ({
        path,
        memoryBytes: 3,
        checkpointBytes: 2,
      })),
    }),
    purgeSessions: async (sessions) => {
      purged.push(...sessions.map((session) => session.sessionId));
      return {
        deleted: sessions.map((session) => ({ sessionId: session.sessionId, bytes: 10 })),
        kept: [],
        failed: [],
      };
    },
    purgeDirectories: async (directories) => {
      purgedDirectories.push(...directories);
      return { bytes: directories.length * 5, failed: [] };
    },
    ...portOverrides,
  };
  let changes = 0;
  const service = createProjectService({
    repository: async () => repo(),
    workspaceDirectory: join(directory, "workspace"),
    data: { repository: async () => repo(), port },
    afterChange: async () => {
      changes += 1;
    },
  });
  return {
    db,
    repo,
    service,
    purged,
    purgedDirectories,
    changes: () => changes,
  };
}

describe("restoreProject", () => {
  it("撤销软删除：目录缺失也可恢复、幂等、保留 roots/置顶/顺序", async () => {
    const { service, repo } = await fixture();
    const project = repo().saveProject({
      name: "Site",
      roots: ["/tmp/does-not-exist-site"],
      pinned: true,
    });
    const position = project.position;
    repo().deleteProject(project.id);

    const restored = await service.restoreProject(project.id);
    expect(restored).toMatchObject({
      id: project.id,
      deleted: false,
      pinned: true,
      position,
      name: "Site",
    });
    expect(restored.roots.map((root) => root.rootPath)).toEqual(["/tmp/does-not-exist-site"]);

    // 幂等：再次撤销返回当前事实，不改名、不移动。
    expect(await service.restoreProject(project.id)).toMatchObject({
      id: project.id,
      name: "Site",
    });
  });

  it("重名时按保存规则加序号，未知 ID 报 not-found", async () => {
    const { service, repo } = await fixture();
    const removed = repo().saveProject({ name: "Same", roots: ["/tmp/same-a"] });
    repo().deleteProject(removed.id);
    repo().saveProject({ name: "Same", roots: ["/tmp/same-b"] });

    expect((await service.restoreProject(removed.id)).name).toBe("Same (2)");
    await expect(service.restoreProject("missing")).rejects.toThrow("project.not-found");
  });
});

describe("project data", () => {
  it("测量只读：会话数/字节、记忆与检查点按目录汇总，同批共享目录只算一次", async () => {
    const { service, repo, db } = await fixture();
    const a = repo().saveProject({ name: "A", roots: ["/work/a"] });
    const b = repo().saveProject({ name: "B", roots: ["/work/b"] });
    taskRow(db, { taskId: "t1", projectId: a.id, rootPath: "/work/a" });
    taskRow(db, { taskId: "t2", projectId: a.id, rootPath: "/work/a" });

    const measured = await service.measureProjectData([a.id, b.id]);
    expect(measured.projects).toEqual([
      { id: a.id, sessions: 2, sessionBytes: 20, memoryBytes: 3, checkpointBytes: 2 },
      { id: b.id, sessions: 0, sessionBytes: 0, memoryBytes: 3, checkpointBytes: 2 },
    ]);
  });

  it("只接受已移除的项目，远程与缺失端口的调用显式拒绝", async () => {
    const { service, repo } = await fixture();
    const live = repo().saveProject({ name: "Live", roots: ["/work/live"] });
    await expect(service.deleteProjectData(live.id)).rejects.toThrow(
      "project.data-requires-removed",
    );
    await expect(service.measureProjectData([live.id])).resolves.toBeTruthy();
    await expect(service.deleteProjectData(live.id, "remote-1")).rejects.toThrow(
      "project.data-local-only",
    );

    const bare = createProjectService({
      repository: async () => repo(),
      workspaceDirectory: "/tmp/workspace",
    });
    await expect(bare.measureProjectData([live.id])).rejects.toThrow("project.data-unavailable");
  });

  it("彻底删除：删会话、删目录、清任务与项目行，并广播一次", async () => {
    const { service, repo, db, purged, purgedDirectories, changes } = await fixture();
    const project = repo().saveProject({ name: "Gone", roots: ["/work/gone"] });
    repo().deleteProject(project.id);
    taskRow(db, { taskId: "t1", projectId: project.id, rootPath: "/work/gone" });
    db.prepare(
      "INSERT INTO task_group_members(group_id,workspace_key,task_id,added_at) VALUES('g','/work/gone','t1',0)",
    ).run();

    const result = await service.deleteProjectData(project.id);
    expect(result).toMatchObject({ deletedSessions: 1, freedBytes: 10 + 5, failed: 0 });
    expect(purged).toEqual(["t1"]);
    expect(purgedDirectories).toEqual(["/work/gone"]);
    expect(db.prepare("SELECT count(*) AS n FROM tasks").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM task_group_members").get()).toEqual({ n: 0 });
    expect(repo().readTree({ includeDeleted: true }).projects).toEqual([]);
    expect(changes()).toBeGreaterThan(0);
    // 幂等重试：项目行已不存在，第二次报 not-found 而不是悄悄成功。
    await expect(service.deleteProjectData(project.id)).rejects.toThrow("project.not-found");
  });

  it("共享目录保护：范围外项目 root 与存活任务 cwd 都不删", async () => {
    const { service, repo, db, purgedDirectories } = await fixture();
    const removed = repo().saveProject({ name: "Shared", roots: ["/work/shared"] });
    // 另一个仍在侧栏的项目也用同一目录（例如多项目同 cwd）。
    repo().saveProject({ name: "Kept", roots: ["/work/shared"] });
    repo().deleteProject(removed.id);
    taskRow(db, { taskId: "t1", projectId: removed.id, rootPath: "/work/shared" });
    // 存活任务（未软删除）的 cwd 也保护记忆与检查点。
    taskRow(db, { taskId: "t2", projectId: null, rootPath: "/work/other" });

    await service.deleteProjectData(removed.id);
    expect(purgedDirectories).toEqual([]);
  });

  it("目录删除失败：只标记任务行并保留可恢复的软删除项目，重试成功", async () => {
    let failDirectories = true;
    const { service, repo, db } = await fixture({
      purgeDirectories: async (directories) =>
        failDirectories
          ? { bytes: 0, failed: directories }
          : { bytes: directories.length * 5, failed: [] },
    });
    const project = repo().saveProject({ name: "Retry", roots: ["/work/retry"] });
    repo().deleteProject(project.id);
    taskRow(db, { taskId: "t1", projectId: project.id, rootPath: "/work/retry" });

    const first = await service.deleteProjectData(project.id);
    expect(first.failed).toBe(1);
    // 任务行只被隐藏（deleted=1, cli_deleted=1），项目仍软删除、仍可按行找回目录。
    expect(db.prepare("SELECT deleted,cli_deleted FROM tasks WHERE task_id='t1'").get()).toEqual({
      deleted: 1,
      cli_deleted: 1,
    });
    expect(
      repo()
        .readTree({ includeDeleted: true })
        .projects.map((entry) => entry.id),
    ).toEqual([project.id]);

    failDirectories = false;
    const second = await service.deleteProjectData(project.id);
    expect(second.failed).toBe(0);
    expect(repo().readTree({ includeDeleted: true }).projects).toEqual([]);
  });

  it("运行中被保留的会话计入 runningSessions，项目保持可重试", async () => {
    const { service, repo, db } = await fixture({
      purgeSessions: async (sessions) => ({
        deleted: [],
        kept: sessions.map((session) => ({
          sessionId: session.sessionId,
          reason: "running" as const,
        })),
        failed: [],
      }),
      purgeDirectories: async () => ({ bytes: 0, failed: [] }),
    });
    const project = repo().saveProject({ name: "Busy", roots: ["/work/busy"] });
    repo().deleteProject(project.id);
    taskRow(db, { taskId: "t1", projectId: project.id, rootPath: "/work/busy" });

    const result = await service.deleteProjectData(project.id);
    expect(result).toMatchObject({ deletedSessions: 0, runningSessions: 1, failed: 0 });
    // 会话行仍在，因此项目行被引用而保留。
    expect(db.prepare("SELECT count(*) AS n FROM tasks").get()).toEqual({ n: 1 });
    expect(repo().readTree({ includeDeleted: true }).projects).toHaveLength(1);
  });

  it("仍被定时任务引用时删除项目行被拒绝，任务行照样清理", async () => {
    const { service, repo, db } = await fixture();
    const project = repo().saveProject({ name: "Automated", roots: ["/work/auto"] });
    repo().deleteProject(project.id);
    taskRow(db, { taskId: "t1", projectId: project.id, rootPath: "/work/auto" });
    db.prepare("INSERT INTO automations(id,project_id,host_id) VALUES('a1',?,'local')").run(
      project.id,
    );

    await service.deleteProjectData(project.id);
    expect(db.prepare("SELECT count(*) AS n FROM tasks").get()).toEqual({ n: 0 });
    expect(
      repo()
        .readTree({ includeDeleted: true })
        .projects.map((entry) => entry.id),
    ).toEqual([project.id]);
  });
});
