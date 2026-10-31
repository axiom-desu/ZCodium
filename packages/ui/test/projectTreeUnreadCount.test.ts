import { describe, expect, it } from "vitest";
import type { ProjectTask, ProjectTree, VirtualProject } from "@zcode/services";
import { countProjectTreeUnreadTasks } from "../src/project-sidebar/view.js";

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

function tree(projects: VirtualProject[], tasks: ProjectTask[]): ProjectTree {
  return { projects, tasks };
}

const repoA = project({ id: "p1", name: "Repo A" });

describe("countProjectTreeUnreadTasks", () => {
  it("只统计非归档且仍有 unreadAt 的任务", () => {
    const result = countProjectTreeUnreadTasks(
      tree(
        [repoA],
        [
          // 活跃未读
          task({ taskId: "active", unreadAt: 100 }),
          // 已读（mark-read 后 unreadAt 被清除）
          task({ taskId: "read", unreadAt: undefined }),
          // 已归档/关闭的旧任务不再产生蓝点
          task({ taskId: "archived", unreadAt: 300, archived: true }),
        ],
      ),
    );

    expect(result).toBe(1);
  });

  it("按 host + workspace identity + task 去重，项目行与 legacy 行不重复计数", () => {
    const legacyTask = task({
      taskId: "shared",
      unreadAt: 100,
      workspacePath: "/remote/repo",
      workspaceIdentity: "remote:server:/remote/repo",
      projectId: "legacy-single-root:one",
    });
    const sameTaskFromLegacyRow = { ...legacyTask };
    const result = countProjectTreeUnreadTasks(
      tree(
        [
          repoA,
          project({
            id: "legacy-single-root:one",
            hostId: "local",
            legacySingleRoot: true,
          }),
        ],
        [legacyTask, sameTaskFromLegacyRow],
      ),
    );

    expect(result).toBe(1);
  });

  it("不同 host/identity 的同 taskId 仍分别计数，不按 path 合并", () => {
    const result = countProjectTreeUnreadTasks(
      tree(
        [repoA, project({ id: "p1", hostId: "remote:server" })],
        [
          task({ taskId: "same", unreadAt: 100, hostId: "local", projectId: "p1" }),
          task({
            taskId: "same",
            unreadAt: 200,
            hostId: "remote:server",
            projectId: "p1",
          }),
        ],
      ),
    );

    expect(result).toBe(2);
  });

  it("同路径不同 workspace identity 按 identity 区分，不按 path 合并", () => {
    const result = countProjectTreeUnreadTasks(
      tree(
        [repoA],
        [
          task({
            taskId: "same",
            unreadAt: 100,
            workspacePath: "/shared/repo",
            workspaceIdentity: "remote:server-a:/shared/repo",
          }),
          task({
            taskId: "same",
            unreadAt: 200,
            workspacePath: "/shared/repo",
            workspaceIdentity: "remote:server-b:/shared/repo",
          }),
        ],
      ),
    );

    expect(result).toBe(2);
  });

  it("置顶与无项目任务没有项目行也能看到蓝点，计入角标", () => {
    const result = countProjectTreeUnreadTasks(
      tree(
        [repoA],
        [
          task({ taskId: "pinned", unreadAt: 100, pinned: true, projectId: "deleted" }),
          task({ taskId: "unassigned", unreadAt: 200, projectId: null }),
        ],
      ),
    );

    expect(result).toBe(2);
  });

  it("孤儿任务与软删项目的未读没有蓝点落点，不计入角标", () => {
    const result = countProjectTreeUnreadTasks(
      tree(
        [repoA, project({ id: "deleted", deleted: true })],
        [
          task({ taskId: "orphan", unreadAt: 100, projectId: "missing" }),
          task({ taskId: "deleted-task", unreadAt: 200, projectId: "deleted" }),
        ],
      ),
    );

    expect(result).toBe(0);
  });

  it("空树计 0", () => {
    expect(countProjectTreeUnreadTasks(tree([], []))).toBe(0);
  });
});
