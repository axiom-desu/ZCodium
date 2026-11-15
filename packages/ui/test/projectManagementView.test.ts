import { describe, expect, it } from "vitest";
import type { ProjectTask, ProjectTree, VirtualProject } from "@zcode/services";
import {
  buildProjectManagementRows,
  formatCountMessage,
  isProjectDataCandidate,
  selectProjectManagementRows,
  selectRemovedProjects,
  summarizeProjectRemoval,
  summarizeUnusedProjects,
} from "../src/project-sidebar/project-management-view.js";

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

function project(overrides: Partial<VirtualProject> & { id: string }): VirtualProject {
  return {
    hostId: "local",
    name: `Project ${overrides.id}`,
    nameOverridden: false,
    roots: [{ rootPath: `/work/${overrides.id}`, position: 0, isPrimary: true }],
    position: 0,
    pinned: false,
    deleted: false,
    createdAt: NOW - 30 * DAY,
    updatedAt: NOW - 30 * DAY,
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
    updatedAt: NOW - DAY,
    mode: "agent",
    projectId: null,
    hostId: "local",
    pinned: false,
    archived: false,
    ...overrides,
  } as ProjectTask;
}

describe("buildProjectManagementRows", () => {
  it("derives session facts per exact Host + project and local-only removal", () => {
    const tree: ProjectTree = {
      projects: [
        project({ id: "a", name: "Alpha" }),
        project({ id: "b", hostId: "remote-1", name: "Remote" }),
        project({ id: "deleted", deleted: true }),
      ],
      tasks: [
        task({ taskId: "t1", workspacePath: "/work/a", projectId: "a", updatedAt: NOW - 2 * DAY }),
        task({ taskId: "t2", workspacePath: "/work/a", projectId: "a", updatedAt: NOW - DAY }),
        task({ taskId: "t3", workspacePath: "/remote", projectId: "b", hostId: "remote-1" }),
        task({ taskId: "t4", workspacePath: "/work/a", projectId: null }),
      ],
    };
    const rows = buildProjectManagementRows({ tree, now: NOW });
    expect(rows.map((row) => row.key)).toEqual([
      JSON.stringify(["local", "a"]),
      JSON.stringify(["remote-1", "b"]),
    ]);
    expect(rows[0]).toMatchObject({ sessions: 2, lastActiveAt: NOW - DAY, removal: "delete" });
    expect(rows[1]).toMatchObject({ sessions: 1, removal: null });
    expect(rows[1]!.reason).toBeUndefined();
  });

  it("only suggests removable, unpinned rows with a real reason", () => {
    const tree: ProjectTree = {
      projects: [
        project({ id: "empty", createdAt: NOW - 8 * DAY }),
        project({ id: "fresh", createdAt: NOW - 2 * DAY }),
        project({ id: "pinned", pinned: true, createdAt: NOW - 30 * DAY }),
        project({
          id: "missing",
          primaryRootStatus: "missing",
        }),
        project({ id: "idle", createdAt: NOW - 200 * DAY }),
        project({ id: "remote", hostId: "remote-1", createdAt: NOW - 200 * DAY }),
      ],
      tasks: [
        task({
          taskId: "idle-1",
          workspacePath: "/work/idle",
          projectId: "idle",
          updatedAt: NOW - 200 * DAY,
        }),
        task({
          taskId: "missing-1",
          workspacePath: "/work/missing",
          projectId: "missing",
        }),
      ],
    };
    const rows = new Map(
      buildProjectManagementRows({ tree, now: NOW }).map((row) => [row.project.id, row]),
    );
    expect(rows.get("empty")!.reason).toBe("empty");
    expect(rows.get("fresh")!.reason).toBeUndefined();
    expect(rows.get("pinned")!.reason).toBeUndefined();
    expect(rows.get("missing")!.reason).toBe("missing");
    expect(rows.get("idle")!.reason).toBe("idle");
    expect(rows.get("idle")!.idleMonths).toBeGreaterThanOrEqual(3);
    expect(rows.get("remote")!.reason).toBeUndefined();
  });
});

describe("selectProjectManagementRows", () => {
  const tree: ProjectTree = {
    projects: [
      project({ id: "a", name: "Alpha" }),
      project({ id: "b", name: "Beta" }),
      project({ id: "c", name: "Gamma" }),
    ],
    tasks: [
      task({ taskId: "1", workspacePath: "/work/a", projectId: "a", updatedAt: NOW - DAY }),
      task({ taskId: "2", workspacePath: "/work/b", projectId: "b", updatedAt: NOW - 5 * DAY }),
    ],
  };
  const rows = buildProjectManagementRows({ tree, now: NOW });

  it("filters by unused reason and sorts stably", () => {
    expect(
      selectProjectManagementRows(rows, { query: "", filter: "all", sort: "name" }).map(
        (row) => row.project.id,
      ),
    ).toEqual(["a", "b", "c"]);
    expect(
      selectProjectManagementRows(rows, { query: "", filter: "unused", sort: "name" }).map(
        (row) => row.project.id,
      ),
    ).toEqual(["c"]);
    expect(
      selectProjectManagementRows(rows, { query: "", filter: "all", sort: "sessions" }).map(
        (row) => row.project.id,
      ),
    ).toEqual(["a", "b", "c"]);
    expect(
      selectProjectManagementRows(rows, { query: "", filter: "all", sort: "lastActive" }).map(
        (row) => row.project.id,
      ),
    ).toEqual(["a", "b", "c"]);
  });

  it("matches names and folder paths, case-insensitively", () => {
    expect(
      selectProjectManagementRows(rows, { query: "beta", filter: "all", sort: "name" }).map(
        (row) => row.project.id,
      ),
    ).toEqual(["b"]);
    expect(
      selectProjectManagementRows(rows, { query: "/work/c", filter: "all", sort: "name" }).map(
        (row) => row.project.id,
      ),
    ).toEqual(["c"]);
  });
});

describe("summaries and helpers", () => {
  it("counts unused reasons and removal candidates", () => {
    const tree: ProjectTree = {
      projects: [
        project({ id: "a", createdAt: NOW - 8 * DAY }),
        project({ id: "b", createdAt: NOW - 200 * DAY }),
      ],
      tasks: [
        task({
          taskId: "old",
          workspacePath: "/work/b",
          projectId: "b",
          updatedAt: NOW - 200 * DAY,
        }),
      ],
    };
    const rows = buildProjectManagementRows({ tree, now: NOW });
    expect(summarizeUnusedProjects(rows)).toEqual({ total: 2, missing: 0, empty: 1, idle: 1 });
    expect(summarizeProjectRemoval(rows)).toEqual({
      sessions: 1,
      devices: [{ hostId: "local", count: 2 }],
    });
    expect(rows.every(isProjectDataCandidate)).toBe(true);
  });

  it("only restores local soft-deleted projects", () => {
    const deletedLocal = project({ id: "local", deleted: true, updatedAt: NOW - 1 });
    const deletedRemote = project({ id: "remote", hostId: "remote-1", deleted: true });
    const removed = selectRemovedProjects({
      projects: [deletedLocal, deletedRemote, project({ id: "alive" })],
    });
    expect(removed.map((item) => item.id)).toEqual(["local"]);
  });

  it("uses singular variants when count is one", () => {
    const intl = {
      formatMessage: (descriptor: { id: string }, values?: Record<string, string | number>) =>
        `${descriptor.id}:${JSON.stringify(values ?? {})}`,
    };
    expect(formatCountMessage(intl, "projectManagement.projectsCount", 1)).toContain(
      "projectsCountOne",
    );
    expect(formatCountMessage(intl, "projectManagement.projectsCount", 2)).toContain(
      "projectsCount:",
    );
  });
});
