import { describe, expect, it } from "vitest";
import type {
  ProjectTask,
  ProjectTaskGroupStructure,
  ProjectTree,
  VirtualProject,
} from "@zcode/services";
import {
  buildProjectArchiveGroups,
  projectTaskWorkspaceKey,
  selectTimelineTasks,
  timelineDateHeadings,
} from "../src/project-sidebar/view.js";
import {
  buildProjectGroupedRows,
  countTasksByGroup,
  moveProjectGroupedTask,
  projectGroupTaskKey,
} from "../src/project-sidebar/grouped.js";
import {
  buildProjectGroupedMoveCommand,
  collapseProjectGroupedRows,
  previewProjectGroupedDrag,
} from "../src/project-sidebar/grouped-drag.js";

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

function task(overrides: Partial<ProjectTask> & { taskId: string }): ProjectTask {
  return {
    traceId: `trace-${overrides.taskId}`,
    title: `Task ${overrides.taskId}`,
    workspacePath: "/work/repo-a",
    createdAt: 1,
    updatedAt: 1,
    mode: "build",
    provider: "glm",
    projectId: "p1",
    hostId: "local",
    pinned: false,
    archived: false,
    ...overrides,
  } as ProjectTask;
}

function tree(
  projects: VirtualProject[],
  tasks: ProjectTask[],
  taskGroups?: ProjectTaskGroupStructure,
): ProjectTree {
  return { projects, tasks, ...(taskGroups ? { taskGroups } : {}) };
}

const repoA = project({
  id: "p1",
  name: "Repo A",
  roots: [{ rootPath: "/work/repo-a", position: 0, isPrimary: true }],
});

const structure: ProjectTaskGroupStructure = {
  groups: [
    { id: "g1", title: "Group 1", color: "blue", createdAt: 1, updatedAt: 1 },
    { id: "g2", title: "Empty", color: "gray", createdAt: 2, updatedAt: 2 },
  ],
  members: [
    {
      groupId: "g1",
      workspaceKey: "/work/repo-a",
      workspacePath: "/work/repo-a",
      taskId: "grouped",
      sortOrder: 1,
      addedAt: 1,
    },
    {
      groupId: "g1",
      workspaceKey: "/work/repo-a",
      workspacePath: "/work/repo-a",
      taskId: "archived-member",
      sortOrder: 2,
      addedAt: 2,
    },
  ],
  topLevelOrders: [
    { type: "group", groupId: "g2", sortOrder: 1 },
    { type: "group", groupId: "g1", sortOrder: 2 },
    { type: "task", workspaceKey: "/work/repo-a", taskId: "top", sortOrder: 3 },
  ],
};

describe("project timeline view", () => {
  it("takes all non-archived tasks including pinned and orders by CLI updatedAt", () => {
    const tasks = [
      task({ taskId: "old", updatedAt: 10 }),
      task({ taskId: "pinned", updatedAt: 30, pinned: true }),
      task({ taskId: "new", updatedAt: 20 }),
      task({ taskId: "archived", updatedAt: 40, archived: true }),
    ];
    expect(selectTimelineTasks(tree([repoA], tasks)).map((entry) => entry.taskId)).toEqual([
      "pinned",
      "new",
      "old",
    ]);
  });

  it("keeps the same task key and excludes only known legacy workspace rows", () => {
    const tasks = [
      task({ taskId: "tree", workspacePath: "/work/repo-a" }),
      task({ taskId: "legacy", workspacePath: "/work/unassigned" }),
    ];
    const selected = selectTimelineTasks(tree([repoA], tasks), new Set(["/work/unassigned"]));
    expect(selected.map((entry) => entry.taskId)).toEqual(["tree"]);
    expect(projectTaskWorkspaceKey(selected[0]!)).toBe("/work/repo-a");
  });

  it("inserts date headings without reordering rows", () => {
    const now = new Date(2026, 4, 20, 12).getTime();
    const headings = timelineDateHeadings(
      [
        new Date(2026, 4, 20, 8).getTime(),
        new Date(2026, 4, 19, 8).getTime(),
        new Date(2026, 4, 19, 9).getTime(),
        new Date(2026, 3, 1, 8).getTime(),
      ],
      now,
      "en-US",
    );
    expect(headings.map((heading) => heading?.id ?? null)).toEqual([
      "taskTimeline.today",
      "taskTimeline.yesterday",
      null,
      "taskTimeline.lastMonth",
    ]);
  });
});

describe("project grouped view", () => {
  it("renders structure order, empty groups and ungrouped tasks exactly once", () => {
    const tasks = [
      task({ taskId: "top", updatedAt: 5 }),
      task({ taskId: "grouped", updatedAt: 4 }),
      task({ taskId: "archived-member", updatedAt: 3, archived: true }),
      task({ taskId: "pinned", updatedAt: 2, pinned: true }),
      task({ taskId: "loose", updatedAt: 1 }),
    ];
    const rows = buildProjectGroupedRows(tasks, structure, new Set());
    expect(
      rows.map(
        (row) =>
          `${row.type}:${row.type === "group" ? row.group.id : row.type === "empty" ? row.groupId : row.task.taskId}`,
      ),
    ).toEqual(["group:g2", "empty:g2", "group:g1", "task:grouped", "task:top", "task:loose"]);
  });

  it("collapses groups without dropping their header or leaking children", () => {
    const rows = buildProjectGroupedRows(
      [task({ taskId: "grouped" }), task({ taskId: "loose" })],
      structure,
      new Set(["g1"]),
    );
    expect(rows.map((row) => row.key)).toEqual([
      "group:g2",
      "empty:g2",
      "group:g1",
      'task:["/work/repo-a","loose"]',
    ]);
    expect(countTasksByGroup(rows).get("g1")).toBeUndefined();
  });

  it("emits one anchored move command instead of a visible full snapshot", () => {
    const tasks = [
      task({ taskId: "top", updatedAt: 5 }),
      task({ taskId: "grouped", updatedAt: 4 }),
      task({ taskId: "archived-member", updatedAt: 3, archived: true }),
      task({ taskId: "loose", updatedAt: 1 }),
    ];
    const rows = buildProjectGroupedRows(tasks, structure, new Set());
    const source = {
      type: "task" as const,
      rowKey: `task:${projectGroupTaskKey(tasks[3]!)}`,
    };
    const preview = moveProjectGroupedTask(rows, tasks[3]!, "g1");
    const command = buildProjectGroupedMoveCommand(rows, preview, source);
    expect(command).toEqual({
      node: {
        type: "task",
        task: {
          workspacePath: "/work/repo-a",
          taskId: "loose",
          hostId: "local",
        },
      },
      sourceGroupId: null,
      groupId: "g1",
      anchor: {
        node: {
          type: "task",
          task: {
            workspacePath: "/work/repo-a",
            taskId: "grouped",
            hostId: "local",
          },
        },
        side: "before",
      },
    });
    // 不可见 archived 成员只留在 Host 结构中，不进入命令载荷。
    expect(JSON.stringify(command)).not.toContain("archived-member");
  });

  it("reorders groups with a relative anchor and keeps collapse preview local", () => {
    const tasks = [task({ taskId: "top" }), task({ taskId: "grouped" })];
    const rows = buildProjectGroupedRows(tasks, structure, new Set());
    const source = { type: "group" as const, rowKey: "group:g1", groupId: "g1" };
    const preview = previewProjectGroupedDrag(rows, source, {
      zone: "group-header",
      groupId: "g2",
      side: "before",
    });
    expect(buildProjectGroupedMoveCommand(rows, preview, source)).toEqual({
      node: { type: "group", groupId: "g1" },
      sourceGroupId: null,
      groupId: null,
      anchor: { node: { type: "group", groupId: "g2" }, side: "before" },
    });
    expect(collapseProjectGroupedRows(rows, new Set(["g1"]))).toEqual(
      buildProjectGroupedRows(tasks, structure, new Set(["g1"])),
    );
  });

  it("falls back to a flat, non-duplicated list when the old store has no structure", () => {
    const tasks = [
      task({ taskId: "b", updatedAt: 2 }),
      task({ taskId: "a", updatedAt: 1 }),
      task({ taskId: "pinned", pinned: true }),
    ];
    expect(buildProjectGroupedRows(tasks, undefined, new Set()).map((row) => row.type)).toEqual([
      "task",
      "task",
    ]);
  });
});

describe("project archive view", () => {
  it("groups by host + projectId and never merges same cwd projects", () => {
    const repoB = project({ id: "p2", name: "Repo B" });
    const tasks = [
      task({ taskId: "a1", projectId: "p1", archived: true, updatedAt: 1 }),
      task({ taskId: "b1", projectId: "p2", archived: true, updatedAt: 2 }),
      task({ taskId: "orphan", projectId: null, archived: true, updatedAt: 3 }),
      task({ taskId: "active", projectId: "p1", archived: false, updatedAt: 4 }),
    ];
    const groups = buildProjectArchiveGroups(tree([repoA, repoB], tasks));
    expect(
      groups.map((group) => [
        group.hostId,
        group.projectId,
        group.tasks.map((entry) => entry.taskId),
      ]),
    ).toEqual([
      ["local", null, ["orphan"]],
      ["local", "p2", ["b1"]],
      ["local", "p1", ["a1"]],
    ]);
  });

  it("supports search, sort and project filter without losing project options", () => {
    const tasks = [
      task({
        taskId: "old",
        title: "Fix login",
        projectId: "p1",
        archived: true,
        createdAt: 1,
        updatedAt: 1,
      }),
      task({
        taskId: "new",
        title: "Fix signup",
        projectId: "p1",
        archived: true,
        createdAt: 2,
        updatedAt: 2,
      }),
      task({
        taskId: "other",
        title: "Docs",
        projectId: "p2",
        archived: true,
        createdAt: 3,
        updatedAt: 3,
      }),
    ];
    expect(
      buildProjectArchiveGroups(tree([repoA], tasks), {
        query: "fix",
        sort: "created",
        project: '["local","p1"]',
      }).flatMap((group) => group.tasks.map((entry) => entry.taskId)),
    ).toEqual(["new", "old"]);
    expect(
      buildProjectArchiveGroups(tree([repoA], tasks), { sort: "updated" })[0]?.tasks[0]?.taskId,
    ).toBe("other");
  });
});
