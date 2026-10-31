import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import { projectStorage } from "#src/project-storage/index.js";

const resources: Array<{ repo: TaskIndexRepo; directory: string }> = [];
afterEach(async () => {
  for (const { repo, directory } of resources.splice(0)) {
    repo.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function meta(taskId: string, workspacePath: string, updatedAt: number): ZCodeTaskMeta {
  return {
    taskId,
    traceId: `zcode-${taskId}`,
    title: `Task ${taskId}`,
    workspacePath,
    createdAt: updatedAt,
    updatedAt,
    mode: "build",
    provider: "glm",
  };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "zcode-project-tree-groups-"));
  const repo = new TaskIndexRepo(join(directory, "tasks-index.sqlite"), 5000, {
    settings: { lastWorkspaceSession: [], recentProjects: [] },
    hostId: "local",
  });
  resources.push({ repo, directory });
  await repo.ensureReady();
  return { repo, directory };
}

describe("project tree task groups", () => {
  it("projects the same task-group tables through readTree without a second store", async () => {
    const { repo } = await fixture();
    await repo.applyCliFacts({ meta: meta("t1", "/work/a", 10) });
    await repo.applyCliFacts({ meta: meta("t2", "/work/a", 20) });
    await repo.applyCliFacts({ meta: meta("t3", "/work/b", 30) });
    const group = await repo.createTaskGroup({ title: "Focus", color: "blue" });
    await repo.applyGroupedTaskViewOrder({
      workspaceScopes: [{ workspacePath: "/work/a" }],
      topLevelNodes: [
        { type: "group", groupId: group.id },
        {
          type: "task",
          task: { workspacePath: "/work/a", taskId: "t2" },
        },
      ],
      groups: [
        {
          groupId: group.id,
          taskRefs: [{ workspacePath: "/work/a", taskId: "t1" }],
        },
      ],
    });

    const tree = (await repo.getProjectRepository()).readTree();
    expect(tree.tasks.map((task) => task.taskId).sort()).toEqual(["t1", "t2", "t3"]);
    expect(tree.taskGroups?.groups).toEqual([
      expect.objectContaining({ id: group.id, title: "Focus", color: "blue" }),
    ]);
    expect(tree.taskGroups?.members).toEqual([
      expect.objectContaining({
        groupId: group.id,
        workspaceKey: "/work/a",
        workspacePath: "/work/a",
        taskId: "t1",
      }),
    ]);
    expect(tree.taskGroups?.topLevelOrders.map((row) => row.type)).toEqual(["group", "task"]);
  });

  it("omits group structure when the old database has no task-group tables", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-project-tree-old-"));
    const db = new DatabaseSync(join(directory, "tasks-index.sqlite"));
    try {
      db.exec(`CREATE TABLE tasks (
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
      const tree = projectStorage.repository(db).readTree();
      expect(tree.tasks).toEqual([]);
      expect(tree.taskGroups).toBeUndefined();
    } finally {
      db.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
