import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import type { ProjectTaskGroupMoveInput } from "#src/project-storage/contract.js";

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
  const directory = await mkdtemp(join(tmpdir(), "zcode-project-group-move-"));
  const path = join(directory, "tasks-index.sqlite");
  const repo = new TaskIndexRepo(path, 5000, {
    settings: { lastWorkspaceSession: [], recentProjects: [] },
    hostId: "local",
  });
  resources.push({ repo, directory });
  await repo.ensureReady();
  return { repo, path };
}

/** 测试内直连同一 tasks-index：模拟同库其它 Host 写入的隐藏层级（不经过本 Host 的公开入口）。 */
function rawDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

/** 全库原始顶层 order 行（含视图外/悬空/残留），按真实读取顺序。 */
function rawTopOrder(db: DatabaseSync): string[] {
  return (
    db
      .prepare(
        "SELECT node_type,node_key FROM task_group_view_node_orders ORDER BY sort_order,node_type,node_key",
      )
      .all() as Array<{ node_type: string; node_key: string }>
  ).map((row) => `${row.node_type}:${row.node_key}`);
}

function rawSortOrders(db: DatabaseSync): number[] {
  return (
    db
      .prepare("SELECT sort_order FROM task_group_view_node_orders ORDER BY sort_order")
      .all() as Array<{ sort_order: number }>
  ).map((row) => Number(row.sort_order));
}

function taskNode(taskId: string, workspacePath = "/work/a"): ProjectTaskGroupMoveInput["node"] {
  return {
    type: "task",
    task: { workspacePath, taskId, hostId: "local" },
  };
}

async function move(repo: TaskIndexRepo, input: ProjectTaskGroupMoveInput): Promise<void> {
  (await repo.getProjectRepository()).moveTaskGroupNode(input);
}

describe("project task-group single-node move", () => {
  it("preserves invisible members and unrelated top-level order while moving one task", async () => {
    const { repo } = await fixture();
    for (const [index, taskId] of ["a1", "a2", "a3", "hidden"].entries()) {
      await repo.applyCliFacts({ meta: meta(taskId, "/work/a", 10 + index) });
    }
    await repo.applyCliFacts({ meta: meta("b1", "/work/b", 30) });
    await repo.applyCliFacts({ meta: meta("b2", "/work/b", 40) });
    await repo.applyGroupedTaskViewOrder({
      workspaceScopes: [{ workspacePath: "/work/b" }],
      topLevelNodes: [{ type: "task", task: { workspacePath: "/work/b", taskId: "b2" } }],
      groups: [],
    });
    const first = await repo.createTaskGroup({ title: "First", color: "blue" });
    const second = await repo.createTaskGroup({ title: "Second", color: "green" });

    await move(repo, { node: taskNode("a1"), sourceGroupId: null, groupId: first.id });
    await move(repo, { node: taskNode("a2"), sourceGroupId: null, groupId: second.id });
    await move(repo, { node: taskNode("hidden"), sourceGroupId: null, groupId: first.id });
    await move(repo, { node: taskNode("b1", "/work/b"), sourceGroupId: null, groupId: first.id });
    await repo.updateTaskState({
      workspacePath: "/work/a",
      taskId: "hidden",
      patch: { archived: true },
    });
    const before = (await (await repo.getProjectRepository()).readTree()).taskGroups!;
    const topTaskOrder = (structure: typeof before) =>
      structure.topLevelOrders
        .filter((row) => row.type === "task")
        .sort((left, right) => left.sortOrder - right.sortOrder)
        .map((row) => row.taskId);
    const beforeTopTasks = topTaskOrder(before);
    expect(beforeTopTasks).toContain("b2");
    const groupOrderBefore = before.topLevelOrders
      .filter((row) => row.type === "group")
      .map((row) => row.groupId);

    await move(repo, {
      node: taskNode("a1"),
      sourceGroupId: first.id,
      groupId: second.id,
      anchor: { node: taskNode("a2"), side: "before" },
    });

    const after = (await (await repo.getProjectRepository()).readTree()).taskGroups!;
    // 不可见的 archived / 其它 workspace 成员仍留原组，不被可见快照覆盖。
    expect(after.members.filter((member) => member.groupId === first.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskId: "hidden", workspaceKey: "/work/a" }),
        expect.objectContaining({ taskId: "b1", workspaceKey: "/work/b" }),
      ]),
    );
    expect(after.members.filter((member) => member.groupId === second.id)).toEqual([
      expect.objectContaining({ taskId: "a1" }),
      expect.objectContaining({ taskId: "a2" }),
    ]);
    expect(
      after.topLevelOrders.filter((row) => row.type === "group").map((row) => row.groupId),
    ).toEqual(groupOrderBefore);
    expect(topTaskOrder(after)).toEqual(beforeTopTasks);
  });

  it("reorders groups idempotently and rejects stale source or anchor atomically", async () => {
    const { repo } = await fixture();
    for (const [index, taskId] of ["a1", "a2"].entries()) {
      await repo.applyCliFacts({ meta: meta(taskId, "/work/a", 10 + index) });
    }
    const first = await repo.createTaskGroup({ title: "First" });
    const second = await repo.createTaskGroup({ title: "Second" });
    await move(repo, { node: taskNode("a1"), sourceGroupId: null, groupId: first.id });
    await move(repo, { node: taskNode("a2"), sourceGroupId: null, groupId: second.id });

    const reorder = {
      node: { type: "group" as const, groupId: first.id },
      sourceGroupId: null,
      groupId: null,
      anchor: { node: { type: "group" as const, groupId: second.id }, side: "before" as const },
    };
    await move(repo, reorder);
    const once = (await (await repo.getProjectRepository()).readTree()).taskGroups!;
    await move(repo, reorder);
    const twice = (await (await repo.getProjectRepository()).readTree()).taskGroups!;
    expect(twice).toEqual(once);

    await expect(
      move(repo, {
        node: taskNode("a1"),
        sourceGroupId: second.id,
        groupId: null,
      }),
    ).rejects.toThrow("stale-source");
    await expect(
      move(repo, {
        node: taskNode("a2"),
        sourceGroupId: second.id,
        groupId: first.id,
        anchor: { node: taskNode("a2"), side: "after" },
      }),
    ).rejects.toThrow("stale-anchor");
    await expect(
      move(repo, {
        node: taskNode("missing"),
        sourceGroupId: null,
        groupId: first.id,
      }),
    ).rejects.toThrow("task-unavailable");
    await expect(
      move(repo, {
        node: taskNode("a1", "/work/wrong-workspace"),
        sourceGroupId: first.id,
        groupId: null,
      }),
    ).rejects.toThrow("task-unavailable");
    await expect(
      move(repo, {
        node: {
          type: "task",
          task: { workspacePath: "/work/a", taskId: "a1", hostId: "remote:x" },
        },
        sourceGroupId: first.id,
        groupId: null,
      }),
    ).rejects.toThrow("cross-host");
  });

  it("ungroups at the original block position without dropping hidden members", async () => {
    const { repo } = await fixture();
    for (const [index, taskId] of ["a1", "hidden", "tail"].entries()) {
      await repo.applyCliFacts({ meta: meta(taskId, "/work/a", 10 + index) });
    }
    await repo.applyGroupedTaskViewOrder({
      workspaceScopes: [{ workspacePath: "/work/a" }],
      topLevelNodes: [{ type: "task", task: { workspacePath: "/work/a", taskId: "tail" } }],
      groups: [],
    });
    const group = await repo.createTaskGroup({ title: "Block" });
    await move(repo, { node: taskNode("a1"), sourceGroupId: null, groupId: group.id });
    await move(repo, { node: taskNode("hidden"), sourceGroupId: null, groupId: group.id });
    await repo.updateTaskState({
      workspacePath: "/work/a",
      taskId: "hidden",
      patch: { archived: true },
    });
    await repo.deleteTaskGroup({ groupId: group.id });
    const groups = (await (await repo.getProjectRepository()).readTree()).taskGroups!;
    expect(groups.groups).toEqual([]);
    expect(groups.members).toEqual([]);
    const order = groups.topLevelOrders
      .filter((row) => row.type === "task")
      .sort((left, right) => left.sortOrder - right.sortOrder);
    expect(order.map((row) => row.taskId)).toEqual(["hidden", "a1", "tail"]);
  });

  it("renumbers the full raw top-level layer so hidden and unknown rows keep their relative order", async () => {
    const { repo, path } = await fixture();
    for (const [index, taskId] of ["v1", "v2", "v3"].entries()) {
      await repo.applyCliFacts({ meta: meta(taskId, "/work/a", 10 + index) });
    }
    const visible = await repo.createTaskGroup({ title: "Visible" });
    await repo.applyGroupedTaskViewOrder({
      workspaceScopes: [{ workspacePath: "/work/a" }],
      topLevelNodes: [
        { type: "group", groupId: visible.id },
        { type: "task", task: { workspacePath: "/work/a", taskId: "v2" } },
        { type: "task", task: { workspacePath: "/work/a", taskId: "v3" } },
      ],
      groups: [{ groupId: visible.id, taskRefs: [{ workspacePath: "/work/a", taskId: "v1" }] }],
    });

    // 同库其它 Host / 历史形态的隐藏层：脏 group order 行、不可见 bootstrap 组、无 CLI 事实行、
    // 其它 Host 的任务行。它们共享同一层 ordinal，但都不在当前 Host 的可见快照里。
    const remoteKey = "remote:ssh:test-host:22:alice:/repo";
    const remoteHostId = "remote:ssh:test-host:22:alice";
    const db = rawDb(path);
    try {
      db.exec("BEGIN IMMEDIATE");
      const order = db.prepare(
        "INSERT INTO task_group_view_node_orders(node_type,node_key,sort_order,created_at,updated_at) VALUES(?,?,?,1,1)",
      );
      const group = db.prepare(
        "INSERT INTO task_groups(group_id,title,color,created_at,updated_at) VALUES(?,?,?,1,1)",
      );
      group.run("group-hidden", "Hidden", "gray");
      db.prepare(
        "INSERT INTO task_group_workspace_bootstraps(workspace_key,group_id,created_at,updated_at) VALUES(?,?,1,1)",
      ).run(remoteKey, "group-hidden");
      db.prepare(
        `INSERT INTO task_group_members(group_id,workspace_key,workspace_path,workspace_identity,task_id,sort_order,added_at,created_at,updated_at)
         VALUES('group-hidden',?,'/repo',?,'rh1',1000,1,1,1)`,
      ).run(remoteKey, remoteKey);
      db.prepare(
        `INSERT INTO tasks(workspace_key,workspace_path,workspace_identity,task_id,created_at,updated_at,host_id,root_path,handoff_pending)
         VALUES('/work/a','/work/a',NULL,'no-cli',0,0,'local','/work/a',8)`,
      ).run();
      db.prepare(
        `INSERT INTO tasks(workspace_key,workspace_path,workspace_identity,task_id,created_at,updated_at,host_id,root_path,cli_created_at,cli_updated_at)
         VALUES(?,? ,?,'remote-task',1,1,?,?,1,1)`,
      ).run(remoteKey, "/repo", remoteKey, remoteHostId, "/repo");
      // 先按真实读取顺序建立混合 ordinal：脏行/可见组/无 CLI 行/可见任务/不可见组/可见任务/远端任务。
      order.run("group", "group-dangling", 500);
      order.run("task", JSON.stringify(["/work/a", "no-cli"]), 1500);
      order.run("group", "group-hidden", 2500);
      order.run("task", JSON.stringify([remoteKey, "remote-task"]), 3500);
      db.exec("COMMIT");
    } finally {
      db.close();
    }

    const before = rawDb(path);
    const beforeRows = rawTopOrder(before);
    const beforeOrders = rawSortOrders(before);
    const beforeCounts = {
      tasks: Number((before.prepare("SELECT count(*) AS n FROM tasks").get() as { n: number }).n),
      members: Number(
        (before.prepare("SELECT count(*) AS n FROM task_group_members").get() as { n: number }).n,
      ),
      orders: beforeOrders.length,
    };
    before.close();
    const movedNode = `task:${JSON.stringify(["/work/a", "v3"])}`;

    // v3 移到可见组之前：干预点在完整层里定位，而不是只在可见快照里。
    await move(repo, {
      node: taskNode("v3"),
      sourceGroupId: null,
      groupId: null,
      anchor: { node: { type: "group", groupId: visible.id }, side: "before" },
    });

    const after = rawDb(path);
    let afterMoveRows: string[];
    try {
      const afterOrders = rawSortOrders(after);
      // 同层 ordinal 全库唯一：不再留与本次新号段碰撞的旧号。
      expect(new Set(afterOrders).size).toBe(afterOrders.length);
      // 除被移动节点外，全库原始顶层顺序逐行保持（含隐藏/悬空/无 CLI/其它 Host 行）。
      expect(rawTopOrder(after).filter((row) => row !== movedNode)).toEqual(
        beforeRows.filter((row) => row !== movedNode),
      );
      expect(rawTopOrder(after).indexOf(movedNode)).toBe(
        rawTopOrder(after).indexOf("group:group-dangling") + 1,
      );
      // 不可读/未知/视图外行不被删除，也不改变成员归属。
      expect({
        tasks: Number((after.prepare("SELECT count(*) AS n FROM tasks").get() as { n: number }).n),
        members: Number(
          (after.prepare("SELECT count(*) AS n FROM task_group_members").get() as { n: number }).n,
        ),
        orders: afterOrders.length,
      }).toEqual(beforeCounts);
      expect(
        after.prepare("SELECT group_id FROM task_group_members WHERE task_id='rh1'").get(),
      ).toEqual({ group_id: "group-hidden" });
      expect(
        after.prepare("SELECT group_id FROM task_group_members WHERE task_id='v1'").get(),
      ).toEqual({ group_id: visible.id });
      expect(
        after
          .prepare(
            "SELECT 1 AS found FROM task_group_view_node_orders WHERE node_key='group-dangling'",
          )
          .get(),
      ).toEqual({ found: 1 });
      afterMoveRows = rawTopOrder(after);
    } finally {
      after.close();
    }

    // 同一事务内核的 group 分支：把可见组移到可见任务 v2 之后，写集同样是完整层。
    const groupNode = `group:${visible.id}`;
    const anchorNode = `task:${JSON.stringify(["/work/a", "v2"])}`;
    await move(repo, {
      node: { type: "group", groupId: visible.id },
      sourceGroupId: null,
      groupId: null,
      anchor: { node: taskNode("v2"), side: "after" },
    });
    const afterGroup = rawDb(path);
    try {
      const orders = rawSortOrders(afterGroup);
      expect(new Set(orders).size).toBe(orders.length);
      const rows = rawTopOrder(afterGroup);
      expect(rows.filter((row) => row !== groupNode)).toEqual(
        afterMoveRows.filter((row) => row !== groupNode),
      );
      expect(rows.indexOf(groupNode)).toBe(rows.indexOf(anchorNode) + 1);
    } finally {
      afterGroup.close();
    }
  });

  it("moves one visible member past hidden siblings without reordering or dropping the rest", async () => {
    const { repo, path } = await fixture();
    for (const [index, taskId] of ["m1", "m2"].entries()) {
      await repo.applyCliFacts({ meta: meta(taskId, "/work/a", 10 + index) });
    }
    await repo.applyCliFacts({ meta: meta("archived-sibling", "/work/a", 30) });
    await repo.updateTaskState({
      workspacePath: "/work/a",
      taskId: "archived-sibling",
      patch: { archived: true },
    });
    const group = await repo.createTaskGroup({ title: "Mixed" });
    const remoteKey = "remote:ssh:other-host:22:bob:/repo";
    const db = rawDb(path);
    try {
      db.exec("BEGIN IMMEDIATE");
      const member = db.prepare(
        `INSERT INTO task_group_members(group_id,workspace_key,workspace_path,workspace_identity,task_id,sort_order,added_at,created_at,updated_at)
         VALUES(?,?,?,?,?,?,1,1,1)`,
      );
      // 可见 m1 / 无 CLI 事实 / 可见 m2 / 其它 Host / 已归档：隐藏成员夹在可见成员之间。
      member.run(group.id, "/work/a", "/work/a", null, "m1", 1000);
      member.run(group.id, "/work/a", "/work/a", null, "no-cli", 1500);
      member.run(group.id, "/work/a", "/work/a", null, "m2", 2000);
      member.run(group.id, remoteKey, "/repo", remoteKey, "remote-sibling", 2500);
      member.run(group.id, "/work/a", "/work/a", null, "archived-sibling", 3000);
      db.exec("COMMIT");
    } finally {
      db.close();
    }

    const memberOrder = (target: DatabaseSync) =>
      (
        target
          .prepare(
            "SELECT task_id FROM task_group_members WHERE group_id=? ORDER BY sort_order,workspace_key,task_id",
          )
          .all(group.id) as Array<{ task_id: string }>
      ).map((row) => row.task_id);

    await move(repo, {
      node: taskNode("m2"),
      sourceGroupId: group.id,
      groupId: group.id,
      anchor: { node: taskNode("m1"), side: "after" },
    });

    const after = rawDb(path);
    try {
      // 只把 m2 挪到 m1 之后；隐藏成员保持彼此相对位置，且一个都不少。
      expect(memberOrder(after)).toEqual([
        "m1",
        "m2",
        "no-cli",
        "remote-sibling",
        "archived-sibling",
      ]);
      const sortOrders = (
        after
          .prepare("SELECT sort_order FROM task_group_members WHERE group_id=?")
          .all(group.id) as Array<{ sort_order: number }>
      ).map((row) => Number(row.sort_order));
      expect(new Set(sortOrders).size).toBe(sortOrders.length);
      // membership 只允许被移动节点换 sort_order；不删任何成员行。
      expect(
        after
          .prepare("SELECT workspace_key,task_id,group_id FROM task_group_members ORDER BY task_id")
          .all(),
      ).toEqual([
        { workspace_key: "/work/a", task_id: "archived-sibling", group_id: group.id },
        { workspace_key: "/work/a", task_id: "m1", group_id: group.id },
        { workspace_key: "/work/a", task_id: "m2", group_id: group.id },
        { workspace_key: "/work/a", task_id: "no-cli", group_id: group.id },
        { workspace_key: remoteKey, task_id: "remote-sibling", group_id: group.id },
      ]);
      // 用户排序事实仍落在同一仓储：task_group_admissions 记录本次整理。
      expect(
        after.prepare("SELECT user_organized FROM task_group_admissions WHERE task_id='m2'").get(),
      ).toEqual({ user_organized: 1 });
    } finally {
      after.close();
    }
  });
});
