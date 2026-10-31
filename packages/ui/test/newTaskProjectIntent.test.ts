import { describe, expect, it } from "vitest";
import {
  inheritNewTaskProjectId,
  resolveExplicitProjectIntent,
} from "@/root/newTaskProjectIntent.js";

const task = (
  taskId: string,
  workspacePath: string,
  projectId: string | null,
  workspaceIdentity?: string,
) => ({ taskId, workspacePath, projectId, ...(workspaceIdentity ? { workspaceIdentity } : {}) });

describe("新任务项目归属意图", () => {
  it("项目行新建：显式 projectId 在入口处冻结", () => {
    expect(
      resolveExplicitProjectIntent({
        targetWorkspace: { workspacePath: "/repo" },
        projectId: "project-a",
      }),
    ).toEqual({ explicit: true, projectId: "project-a" });
    expect(
      resolveExplicitProjectIntent({ targetWorkspace: { workspacePath: "/repo", projectId: "b" } }),
    ).toEqual({ explicit: true, projectId: "b" });
  });

  it("显式 null 表示全局任务；快捷键/工具栏（未表态）不算显式", () => {
    expect(resolveExplicitProjectIntent({ projectId: null })).toEqual({
      explicit: true,
      projectId: null,
    });
    expect(resolveExplicitProjectIntent({ targetWorkspace: { workspacePath: "/repo" } })).toEqual({
      explicit: false,
    });
    expect(resolveExplicitProjectIntent(undefined)).toEqual({ explicit: false });
    expect(resolveExplicitProjectIntent("glm")).toEqual({ explicit: false });
  });

  it("快捷键新任务继承活动任务的真实项目归属（cwd 相同也按精确身份匹配）", () => {
    const tasks = [
      task("task-a", "/shared-root", "project-a"),
      task("task-b", "/shared-root", "project-b"),
    ];
    expect(
      inheritNewTaskProjectId({
        targetWorkspacePath: "/shared-root",
        activeTaskId: "task-b",
        draftProjectId: null,
        tasks,
      }),
    ).toBe("project-b");
    // 任务属于其他 workspace 时不串项目，按未归类处理。
    expect(
      inheritNewTaskProjectId({
        targetWorkspacePath: "/other",
        activeTaskId: "task-b",
        draftProjectId: null,
        tasks,
      }),
    ).toBeNull();
  });

  it("没有活动任务时沿用当前草稿意图；远端 identity 不读本地树", () => {
    expect(
      inheritNewTaskProjectId({
        targetWorkspacePath: "/repo",
        activeTaskId: null,
        draftProjectId: "project-a",
        tasks: [],
      }),
    ).toBe("project-a");
    expect(
      inheritNewTaskProjectId({
        targetWorkspacePath: "/repo",
        targetWorkspaceIdentity: "remote:ssh:host:22:user",
        activeTaskId: "task-a",
        draftProjectId: null,
        tasks: [task("task-a", "/repo", "project-a")],
      }),
    ).toBeUndefined();
  });

  it("归属读取失败（树不可用）时不伪造项目，交给调用方按全局任务继续", () => {
    expect(
      inheritNewTaskProjectId({
        targetWorkspacePath: "/repo",
        activeTaskId: "task-a",
        draftProjectId: null,
        tasks: null,
      }),
    ).toBeUndefined();
  });
});
