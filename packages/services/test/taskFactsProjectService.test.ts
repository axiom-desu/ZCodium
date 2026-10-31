import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import { createProjectService } from "#src/project/app/index.js";

const root = await mkdtemp(join(tmpdir(), "zcode-task-facts-"));
const resources: Array<{ repo?: TaskIndexRepo; directory: string }> = [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    resource.repo?.close();
    await rm(resource.directory, { recursive: true, force: true });
  }
});

async function fixture() {
  const directory = await mkdtemp(join(root, "case-"));
  const repo = new TaskIndexRepo(join(directory, "tasks-index.sqlite"), 5000, {
    settings: { lastWorkspaceSession: [], recentProjects: [] },
    hostId: "local",
  });
  const resource = { repo, directory };
  resources.push(resource);
  await repo.ensureReady();
  return { repo, directory };
}

const facts = (taskId: string, workspacePath: string, extra: Record<string, unknown> = {}) => ({
  meta: {
    taskId,
    traceId: `zcode-${taskId}`,
    title: `title ${taskId}`,
    workspacePath,
    createdAt: 100,
    updatedAt: 200,
    mode: "build" as const,
    provider: "glm" as const,
  },
  ...extra,
});

describe("CLI facts mirror + project tree", () => {
  it("makes an accepted CLI task visible without restart and keeps org writes separate", async () => {
    const { repo, directory } = await fixture();
    const project = (await repo.getProjectRepository()).saveProject({
      name: "Repo",
      roots: [directory],
    });
    await repo.syncTaskMeta(facts("task-1", directory));
    // 普通展示同步不冒充 CLI 事实；项目树仍不可见。
    expect((await repo.getProjectRepository()).readTree().tasks).toEqual([]);
    await repo.applyCliFacts(facts("task-1", directory));
    const tree = (await repo.getProjectRepository()).readTree();
    expect(tree.tasks.map((task) => task.taskId)).toEqual(["task-1"]);
    expect(tree.tasks[0]).toMatchObject({ projectId: project.id, hostId: "local" });
    const row = (await repo.getOrganizationDatabase())
      .prepare(
        "SELECT cli_title,cli_created_at,cli_updated_at,cli_deleted,handoff_pending FROM tasks WHERE task_id='task-1'",
      )
      .get() as Record<string, unknown>;
    expect(row).toMatchObject({
      cli_title: "title task-1",
      cli_created_at: 100,
      cli_updated_at: 200,
      cli_deleted: 0,
    });
  });

  it("keeps a reservation invisible until real CLI facts, then preserves project and frozen dirs", async () => {
    const { repo, directory } = await fixture();
    const project = (await repo.getProjectRepository()).saveProject({
      name: "Repo",
      roots: [directory],
    });
    const extra = join(directory, "extra");
    await mkdir(extra);
    const reserved = (await repo.getProjectRepository()).reserveCreatedTask({
      task: { workspacePath: directory, taskId: "reserved" },
      projectId: project.id,
      additionalDirectories: [extra],
    });
    expect(reserved.additionalDirectories).toEqual([extra]);
    expect((await repo.getProjectRepository()).readTree().tasks).toEqual([]);
    // 重试不覆盖已冻结执行目录。
    expect(
      (await repo.getProjectRepository()).reserveCreatedTask({
        task: { workspacePath: directory, taskId: "reserved" },
        projectId: project.id,
        additionalDirectories: [],
      }).additionalDirectories,
    ).toEqual([extra]);
    await repo.applyCliFacts(facts("reserved", directory));
    expect((await repo.getProjectRepository()).readTree().tasks[0]).toMatchObject({
      taskId: "reserved",
      projectId: project.id,
    });
  });

  it("preserves a user rename against late default CLI titles and never revives user delete", async () => {
    const { repo, directory } = await fixture();
    await repo.applyCliFacts(facts("task-1", directory));
    await repo.updateTaskState({
      workspacePath: directory,
      taskId: "task-1",
      patch: { title: "User title", titleOverridden: true },
    });
    await repo.applyCliFacts({
      ...facts("task-1", directory),
      meta: { ...facts("task-1", directory).meta, title: "Generated title", updatedAt: 300 },
    });
    const meta = await repo.getTaskMeta({ workspacePath: directory, taskId: "task-1" });
    expect(meta?.title).toBe("User title");
    expect(meta?.titleOverridden).toBe(true);
    // 用户删除（Host 事实）不能被后续 CLI 事实复活。
    await repo.syncTaskMeta({
      ...facts("task-1", directory),
      meta: facts("task-1", directory).meta,
      deleted: true,
    });
    await repo.applyCliFacts(facts("task-1", directory));
    expect(await repo.getTaskMeta({ workspacePath: directory, taskId: "task-1" })).toBeNull();
  });

  it("writes explicit CLI deletion and keeps orphan facts non-deleting", async () => {
    const { repo, directory } = await fixture();
    await repo.applyCliFacts(facts("task-1", directory));
    await repo.markCliOrphan({ workspacePath: directory, taskId: "task-1" });
    expect((await repo.getProjectRepository()).readTree().tasks).toHaveLength(1);
    await repo.applyCliDeletion({ workspacePath: directory, taskId: "task-1" });
    expect((await repo.getProjectRepository()).readTree().tasks).toEqual([]);
    expect(
      (await repo.getProjectRepository()).readTree({ includeDeletedTasks: true }).deletedTasks,
    ).toEqual([{ taskId: "task-1", workspacePath: directory, hostId: "local" }]);
  });

  it("commits task org admission atomically on the non-grouped sync path", async () => {
    const { repo, directory } = await fixture();
    const db = await repo.getOrganizationDatabase();
    db.exec(
      "CREATE TRIGGER reject_member BEFORE INSERT ON task_group_members BEGIN SELECT RAISE(ABORT,'no member'); END;",
    );
    await expect(
      repo.syncTaskMeta({
        ...facts("cron-task", directory),
        meta: { ...facts("cron-task", directory).meta, cronAutomationId: "cron-1" },
      }),
    ).rejects.toThrow(/no member/);
    // 整笔回滚：task 行、admission 都不存在，不能留下 system_kind='cron' 的孤儿登记。
    expect(db.prepare("SELECT 1 FROM tasks WHERE task_id='cron-task'").get()).toBeUndefined();
    expect(
      db.prepare("SELECT 1 FROM task_group_admissions WHERE task_id='cron-task'").get(),
    ).toBeUndefined();
    db.exec("DROP TRIGGER reject_member;");
    await repo.syncTaskMeta({
      ...facts("cron-task", directory),
      meta: { ...facts("cron-task", directory).meta, cronAutomationId: "cron-1" },
    });
    expect(
      db.prepare("SELECT system_kind FROM task_group_admissions WHERE task_id='cron-task'").get(),
    ).toEqual({ system_kind: "cron" });
    expect(
      db.prepare("SELECT count(*) AS n FROM task_group_members WHERE task_id='cron-task'").get(),
    ).toEqual({ n: 1 });
  });

  it("applies creation placement once inside the same sync transaction", async () => {
    const { repo, directory } = await fixture();
    const ref = { workspacePath: directory, taskId: "placed" };
    await repo.syncTaskMeta({
      ...facts("placed", directory),
      admission: { task: ref, groupId: null, creationId: "create-1" },
    });
    await repo.syncTaskMeta({
      ...facts("placed", directory),
      admission: { task: ref, groupId: null, creationId: "create-2" },
    });
    expect(
      (await repo.getOrganizationDatabase())
        .prepare("SELECT creation_id FROM task_group_admissions WHERE task_id='placed'")
        .get(),
    ).toEqual({ creation_id: "create-1" });
  });

  it("auto-archive reads CLI facts only and excludes active/pinned/deleted tasks", async () => {
    const { repo, directory } = await fixture();
    await repo.applyCliFacts(facts("old", directory));
    await repo.applyCliFacts(facts("active", directory));
    await repo.applyCliFacts(facts("pinned", directory));
    await repo.syncTaskMeta({ ...facts("pinned", directory), pinned: true });
    const archived = (await repo.getProjectRepository()).archiveInactive({
      cutoff: 1000,
      activeTasks: [{ workspacePath: directory, taskId: "active" }],
    });
    expect(archived.map((task) => task.taskId)).toEqual(["old"]);
  });
});

describe("ProjectService", () => {
  it("validates directories, prepares deterministic dirs and rejects deleted projects", async () => {
    const { repo, directory } = await fixture();
    const workspaceDirectory = join(directory, "workspace");
    await mkdir(workspaceDirectory, { recursive: true });
    const file = join(directory, "file.txt");
    await writeFile(file, "x");
    const changes: number[] = [];
    const service = createProjectService({
      repository: () => repo.getProjectRepository(),
      workspaceDirectory,
      directories: {
        home: async () => directory,
        read: async () => [],
      },
      afterChange: async () => {
        changes.push(1);
      },
    });
    await expect(service.saveProject({ name: "relative", roots: ["relative"] })).rejects.toThrow(
      "project.absolute-path-required",
    );
    await expect(service.saveProject({ name: "file", roots: [file] })).rejects.toThrow(
      "project.directory-required",
    );
    const empty = await service.saveProject({ name: "Empty" });
    expect(empty.roots).toEqual([]);
    const prepared = await service.prepareSession({ projectId: empty.id });
    expect(prepared.workspacePath).toBe(join(workspaceDirectory, empty.id));
    expect(prepared.additionalDirectories).toEqual([]);
    await expect(
      service.prepareSession({ projectId: empty.id, draftId: "not-a-uuid" }),
    ).rejects.toThrow();
    await service.deleteProject(empty.id);
    await expect(service.prepareSession({ projectId: empty.id })).rejects.toThrow(
      "project.not-found",
    );
    const restored = await service.saveProject({
      restoreProjectId: empty.id,
      roots: [prepared.workspacePath],
    });
    expect(restored.deleted).toBe(false);
    await expect(service.saveProject({ restoreProjectId: empty.id, roots: [] })).rejects.toThrow(
      "project.restore-roots-mismatch",
    );
    expect(changes.length).toBeGreaterThan(2);
  });
});
