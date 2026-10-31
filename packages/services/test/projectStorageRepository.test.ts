import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { projectStorage } from "#src/project-storage/index.js";

const resources: Array<{ db: DatabaseSync; directory: string }> = [];
afterEach(async () => {
  for (const { db, directory } of resources.splice(0)) {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "zcode-project-repo-"));
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
      PRIMARY KEY(workspace_key, task_id));`);
  await projectStorage.migrate(db, {
    backupDirectories: [join(directory, "backup")],
    settings: { lastWorkspaceSession: [], recentProjects: [] },
  });
  const addTask = (taskId: string, workspacePath: string, identity?: string) =>
    db
      .prepare(
        "INSERT INTO tasks(workspace_key,workspace_path,workspace_identity,task_id,title,created_at,updated_at,provider) VALUES(?,?,?,?,?,1,2,'glm')",
      )
      .run(identity ?? workspacePath, workspacePath, identity ?? null, taskId, `title ${taskId}`);
  return { db, directory, repo: projectStorage.repository(db), addTask };
}

describe("project repository", () => {
  it("prepends new projects, keeps unique names and preserves position on edit/restore", async () => {
    const { repo } = await fixture();
    const first = repo.saveProject({ name: "First" });
    const duplicate = repo.saveProject({ name: "First" });
    expect(first.position).toBe(0);
    expect(duplicate.name).toBe("First (2)");
    expect(repo.readTree().projects.map((project) => project.id)).toEqual([duplicate.id, first.id]);
    expect(repo.saveProject({ id: first.id, name: "Renamed", pinned: true })).toMatchObject({
      id: first.id,
      name: "Renamed",
      pinned: true,
      position: first.position,
    });
    repo.deleteProject(first.id);
    expect(repo.readTree().projects.map((project) => project.id)).toEqual([duplicate.id]);
    expect(repo.readTree({ includeDeleted: true }).projects).toHaveLength(2);
    expect(repo.saveProject({ restoreProjectId: first.id, roots: [] }).position).toBe(
      first.position,
    );
  });

  it("initializes roots only for empty projects and never overwrites a concurrent edit", async () => {
    const { repo } = await fixture();
    const empty = repo.saveProject({ name: "Empty" });
    expect(repo.initializeProjectRoot(empty.id, "/a").roots).toEqual([
      { rootPath: "/a", position: 0, isPrimary: true },
    ]);
    expect(repo.initializeProjectRoot(empty.id, "/b").roots).toEqual([
      { rootPath: "/a", position: 0, isPrimary: true },
    ]);
  });

  it("reorders deterministically and rejects duplicates", async () => {
    const { repo } = await fixture();
    const a = repo.saveProject({ name: "A" });
    const b = repo.saveProject({ name: "B" });
    repo.reorderProjects([a.id, b.id]);
    expect(repo.readTree().projects.map((project) => project.id)).toEqual([a.id, b.id]);
    expect(() => repo.reorderProjects([a.id, a.id])).toThrow("project.duplicate-order");
  });

  it("moves a task only with root confirmation and keeps cwd and prompt facts", async () => {
    const { db, repo, addTask } = await fixture();
    const project = repo.saveProject({ name: "Project", roots: ["/repo"] });
    addTask("task", "/other");
    const task = { taskId: "task", workspacePath: "/other" };
    projectStorage.admitTaskIdentity(db, task);
    expect(() => repo.moveTask({ task, projectId: project.id })).toThrow(
      "project.root-confirmation-required",
    );
    repo.moveTask({ task, projectId: project.id, addMissingRoot: true });
    expect(repo.readTree().projects[0]?.roots.map((root) => root.rootPath)).toEqual([
      "/repo",
      "/other",
    ]);
    expect(db.prepare("SELECT workspace_path,project_id FROM tasks").get()).toMatchObject({
      workspace_path: "/other",
      project_id: project.id,
    });
    expect(repo.resolveSessionDirectories(task)).toMatchObject({
      workspacePath: "/other",
      projectId: project.id,
      additionalDirectories: ["/repo"],
    });
  });

  it("reserves a task before CLI creation and freezes execution directories on retry", async () => {
    const { db, repo } = await fixture();
    const project = repo.saveProject({ name: "Project", roots: ["/repo", "/extra"] });
    const task = { taskId: "new", workspacePath: "/repo" };
    expect(repo.reserveCreatedTask({ task, projectId: project.id })).toMatchObject({
      projectId: project.id,
      additionalDirectories: ["/repo", "/extra"].filter((path) => path !== "/repo"),
    });
    expect(
      repo.reserveCreatedTask({ task, projectId: project.id, additionalDirectories: ["/frozen"] }),
    ).toMatchObject({ additionalDirectories: ["/repo", "/extra"].filter((p) => p !== "/repo") });
    expect(db.prepare("SELECT project_id,execution_directories FROM tasks").get()).toEqual({
      project_id: project.id,
      execution_directories: null,
    });
    // 空事实的预留行不进入列表（没有 CLI 创建/时间事实）。
    expect(repo.readTree().tasks).toEqual([]);
  });

  it("rejects an unprovable remote authority instead of coercing it to local", async () => {
    const { repo } = await fixture();
    expect(() =>
      repo.reserveCreatedTask({
        task: { taskId: "x", workspacePath: "/repo", workspaceIdentity: "remote:bad" },
        projectId: null,
      }),
    ).toThrow("project.host-authority-unknown");
  });

  it("enforces single immutable remote root and rejects unclassified sessions without partial writes", async () => {
    const { db } = await fixture();
    const hostId = "remote:ssh:example.test:22:user";
    db.prepare("INSERT INTO hosts(host_id,kind) VALUES(?,'ssh')").run(hostId);
    const remote = projectStorage.repository(db, hostId);
    for (const roots of [[], ["/a", "/b"]])
      expect(() => remote.saveProject({ roots })).toThrow("project.remote-single-root-required");
    const project = remote.saveProject({ roots: ["/a"] });
    for (const roots of [[], ["/b"]])
      expect(() => remote.saveProject({ id: project.id, roots })).toThrow();
    expect(remote.saveProject({ id: project.id, name: "Renamed", pinned: true })).toMatchObject({
      name: "Renamed",
      roots: [{ rootPath: "/a", position: 0, isPrimary: true }],
    });
    const task = { taskId: "new", workspacePath: "/a", workspaceIdentity: `${hostId}:/a` };
    expect(() => remote.reserveCreatedTask({ task, projectId: null })).toThrow(
      "project.remote-project-required",
    );
    expect(() =>
      remote.reserveCreatedTask({ task, projectId: project.id, additionalDirectories: ["/b"] }),
    ).toThrow("project.remote-single-root-required");
    expect(() =>
      remote.reserveCreatedTask({
        task: { ...task, workspacePath: "/b" },
        projectId: project.id,
        additionalDirectories: [],
      }),
    ).toThrow("project.cwd-not-in-roots");
    expect(db.prepare("SELECT count(*) AS n FROM tasks").get()).toEqual({ n: 0 });
    expect(remote.reserveCreatedTask({ task, projectId: project.id })).toMatchObject({
      projectId: project.id,
      additionalDirectories: [],
    });
  });

  it("keeps same-path local and remote projects isolated", async () => {
    const { db, repo } = await fixture();
    const hostId = "remote:ssh:example.test:22:user";
    db.prepare("INSERT INTO hosts(host_id,kind) VALUES(?,'ssh')").run(hostId);
    const local = repo.saveProject({ name: "Shared", roots: ["/repo"] });
    const remote = projectStorage.repository(db, hostId).saveProject({ roots: ["/repo"] });
    expect(
      projectStorage
        .repository(db, hostId)
        .readTree()
        .projects.map((p) => p.id),
    ).toEqual([remote.id]);
    expect(repo.readTree().projects.map((p) => p.id)).toEqual([local.id]);
    expect(remote.hostId).toBe(hostId);
  });
});
