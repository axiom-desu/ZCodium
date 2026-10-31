import { describe, expect, it } from "vitest";
import type { ProjectTask, ProjectTree, VirtualProject } from "@zcode/services";
import {
  buildProjectRowModels,
  filterLegacyWorkspaceTabs,
  isProjectLegacyReadOnly,
  isProjectPrimaryRootMissing,
  isTaskOwnedByProject,
  projectTaskKey,
  reorderProjectIds,
  selectDeletedProjects,
  selectProjectRows,
  selectUnassignedTasks,
  selectVisibleProjects,
  splitRoots,
} from "../src/project-sidebar/view.js";

function project(overrides: Partial<VirtualProject> & { id: string }): VirtualProject {
  return {
    hostId: "local",
    name: `Project ${overrides.id}`,
    nameOverridden: false,
    roots: [],
    position: 0,
    pinned: false,
    deleted: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function task(
  overrides: Partial<ProjectTask> & { taskId: string; workspacePath: string },
): ProjectTask {
  return {
    traceId: `trace-${overrides.taskId}`,
    title: `Task ${overrides.taskId}`,
    createdAt: 1,
    updatedAt: 1,
    mode: "build",
    provider: "glm",
    projectId: null,
    hostId: "local",
    pinned: false,
    archived: false,
    ...overrides,
  } as ProjectTask;
}

function tree(projects: VirtualProject[], tasks: ProjectTask[]): ProjectTree {
  return { projects, tasks };
}

const repoA = project({
  id: "a",
  name: "Repo A",
  position: 2,
  roots: [{ rootPath: "/work/repo-a", position: 0, isPrimary: true }],
});
const repoB = project({
  id: "b",
  name: "Repo B",
  position: 1,
  pinned: true,
  roots: [{ rootPath: "/work/repo-b", position: 0, isPrimary: true }],
});
const deleted = project({ id: "c", name: "Deleted", deleted: true, position: 0 });
const legacy = project({
  id: "legacy-single-root:x",
  name: "Legacy",
  position: 3,
  legacySingleRoot: true,
  roots: [{ rootPath: "/remote/legacy", position: 0, isPrimary: true }],
});

describe("project sidebar view model", () => {
  it("sorts pinned first then Host position and hides soft-deleted rows", () => {
    const visible = selectVisibleProjects(tree([repoA, repoB, deleted], []));
    expect(visible.map((entry) => entry.id)).toEqual(["b", "a"]);
    expect(selectDeletedProjects(tree([repoA, deleted], [])).map((entry) => entry.id)).toEqual([
      "c",
    ]);
  });

  it("keeps pinned/archived tasks out of project rows but still reports unread", () => {
    const tasks = [
      task({ taskId: "t1", workspacePath: "/work/repo-a", projectId: "a", updatedAt: 10 }),
      task({ taskId: "t2", workspacePath: "/work/repo-a", projectId: "a", pinned: true }),
      task({ taskId: "t3", workspacePath: "/work/repo-a", projectId: "a", archived: true }),
      task({ taskId: "t4", workspacePath: "/work/repo-b", projectId: "b", unreadAt: 3 }),
      task({ taskId: "t5", workspacePath: "/work/repo-a", projectId: null }),
    ];
    const model = buildProjectRowModels(tree([repoA, repoB], tasks), new Set(['["local","a"]']));
    expect(model.map((row) => row.project.id)).toEqual(["b", "a"]);
    expect(model[1]?.tasks.map((entry) => entry.taskId)).toEqual(["t1"]);
    expect(model[1]?.expanded).toBe(true);
    expect(model[0]?.hasUnread).toBe(true);
    expect(
      selectProjectRows(tree([repoA, repoB], tasks), { kind: "pinned" }).map(
        (entry) => entry.taskId,
      ),
    ).toEqual(["t2"]);
  });

  it("shows unassigned tasks only when no legacy tab already renders that workspace", () => {
    const tasks = [
      task({ taskId: "orphan", workspacePath: "/tmp/no-tab" }),
      task({ taskId: "in-tab", workspacePath: "/tmp/legacy-tab" }),
      task({ taskId: "pinned", workspacePath: "/tmp/no-tab", pinned: true }),
      task({ taskId: "archived", workspacePath: "/tmp/no-tab", archived: true }),
    ];
    const unassigned = selectUnassignedTasks(tree([repoA], tasks), new Set(["/tmp/legacy-tab"]));
    expect(unassigned.map((entry) => entry.taskId)).toEqual(["orphan"]);
  });

  it("filters legacy tabs by local project root without swallowing remote or legacy adapters", () => {
    const tabs = [
      { workspacePath: "/work/repo-a" },
      { workspacePath: "/work/repo-a", workspaceIdentity: "remote:host:/work/repo-a" },
      { workspacePath: "/remote/legacy", remoteSessionId: "session-1" },
      { workspacePath: "/tmp/unassigned" },
    ];
    const legacyTabs = filterLegacyWorkspaceTabs(tabs, [repoA, repoB, legacy]);
    expect(legacyTabs.map((tab) => tab.workspacePath)).toEqual([
      "/work/repo-a",
      "/remote/legacy",
      "/tmp/unassigned",
    ]);
  });

  it("compares task ownership by host + workspace key + taskId", () => {
    const tasks = [
      task({ taskId: "t1", workspacePath: "/work/repo-a", projectId: "a" }),
      task({
        taskId: "t1",
        workspacePath: "/work/repo-a",
        workspaceIdentity: "remote:host:/work/repo-a",
        projectId: "a",
        hostId: "remote-host",
      }),
    ];
    const sample = tree([repoA], tasks);
    expect(projectTaskKey(tasks[0]!, "local")).not.toEqual(
      projectTaskKey(tasks[1]!, "remote-host"),
    );
    expect(isTaskOwnedByProject(sample, tasks[0]!, "local")).toBe(true);
    expect(isTaskOwnedByProject(sample, tasks[1]!, "local")).toBe(false);
  });

  it("recognizes legacy read-only and missing primary root for write gating", () => {
    expect(isProjectLegacyReadOnly(legacy)).toBe(true);
    expect(isProjectPrimaryRootMissing({ ...repoA, primaryRootStatus: "missing" })).toBe(true);
    expect(isProjectPrimaryRootMissing({ ...repoA, primaryRootStatus: "available" })).toBe(false);
    expect(isProjectPrimaryRootMissing({ ...repoA, primaryRootStatus: undefined })).toBe(false);
  });

  it("reorders only inside the same pinned group and keeps other projects in place", () => {
    const projects = [repoB, repoA, deleted, legacy];
    expect(reorderProjectIds(projects, '["local","a"]', '["local","c"]')).toEqual([
      "b",
      "c",
      "a",
      "legacy-single-root:x",
    ]);
    expect(reorderProjectIds(projects, '["local","a"]', '["local","b"]')).toBeNull();
  });

  it("splits roots/primary without inventing a primary root", () => {
    expect(splitRoots(repoA)).toEqual({
      roots: ["/work/repo-a"],
      primaryRoot: "/work/repo-a",
    });
    expect(
      splitRoots(
        project({
          id: "multi",
          roots: [
            { rootPath: "/work/one", position: 0, isPrimary: false },
            { rootPath: "/work/two", position: 1, isPrimary: true },
          ],
        }),
      ),
    ).toEqual({ roots: ["/work/one", "/work/two"], primaryRoot: "/work/two" });
  });
});
