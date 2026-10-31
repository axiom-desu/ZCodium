import assert from "node:assert/strict";
import type { Page } from "playwright-core";

interface ProjectSidebarViewsHost {
  paths: { workspaceA: string };
  createTaskGroup(title: string): Promise<{ id: string }>;
  groupTask(groupId: string, refs: Array<{ workspacePath: string; taskId: string }>): Promise<void>;
  moveTaskGroupNode(input: {
    node:
      | { type: "group"; groupId: string }
      | {
          type: "task";
          task: { workspacePath: string; taskId: string; hostId: string };
        };
    sourceGroupId: string | null;
    groupId: string | null;
  }): Promise<void>;
  moveTaskGroupNodeSilently(
    input: Parameters<ProjectSidebarViewsHost["moveTaskGroupNode"]>[0],
  ): Promise<void>;
  readTree(): Promise<{
    taskGroups?: {
      members: Array<{ groupId: string; taskId: string; sortOrder: number | null }>;
    };
  }>;
  applyCliFacts(input: {
    taskId: string;
    title: string;
    workspacePath: string;
    createdAt: number;
    updatedAt: number;
    titleSource?: string;
  }): Promise<unknown>;
  updateTask(input: {
    op: "pin" | "archive";
    taskId: string;
    workspacePath: string;
    pinned?: boolean;
  }): Promise<unknown>;
}

/**
 * 项目树四视图的真实生产 Sidebar E2E：同一 readTree 数据驱动 tabs，
 * 任务组写 taskIndexRepo，归档/置顶仍走既有任务命令。
 */
export async function runProjectSidebarViewsSmoke(
  page: Page,
  host: ProjectSidebarViewsHost,
): Promise<void> {
  const group = await host.createTaskGroup("Focus");
  const otherGroup = await host.createTaskGroup("Other");
  await host.applyCliFacts({
    taskId: "task-timeline",
    title: "Timeline task",
    workspacePath: host.paths.workspaceA,
    createdAt: 4000,
    updatedAt: 5000,
    titleSource: "generated",
  });
  await host.applyCliFacts({
    taskId: "task-group",
    title: "Grouped task",
    workspacePath: host.paths.workspaceA,
    createdAt: 4100,
    updatedAt: 4900,
    titleSource: "generated",
  });
  for (const [index, taskId] of ["drag-one", "drag-two", "drag-three"].entries()) {
    await host.applyCliFacts({
      taskId,
      title: `Drag ${taskId.slice(-3)}`,
      workspacePath: host.paths.workspaceA,
      createdAt: 4200 + index,
      updatedAt: 4800 - index,
      titleSource: "generated",
    });
  }
  await host.applyCliFacts({
    taskId: "task-archive",
    title: "Archived task",
    workspacePath: host.paths.workspaceA,
    createdAt: 300,
    updatedAt: 300,
    titleSource: "generated",
  });
  await host.updateTask({
    op: "archive",
    taskId: "task-archive",
    workspacePath: host.paths.workspaceA,
  });
  await host.updateTask({
    op: "pin",
    taskId: "task-timeline",
    workspacePath: host.paths.workspaceA,
    pinned: true,
  });
  await host.groupTask(group.id, [
    { workspacePath: host.paths.workspaceA, taskId: "task-group" },
    { workspacePath: host.paths.workspaceA, taskId: "drag-one" },
    { workspacePath: host.paths.workspaceA, taskId: "drag-two" },
    { workspacePath: host.paths.workspaceA, taskId: "drag-three" },
  ]);
  await page.reload();
  await page.getByTestId("project-sidebar-section").waitFor();

  await page.getByTestId("project-view-timeline").click();
  await page.getByTestId("project-timeline-view").waitFor();
  const timelineIds = await page
    .locator('[data-testid="project-timeline-view"] [data-testid^="task-item-"]')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute("data-testid")));
  assert.deepEqual(timelineIds.slice(0, 2), ["task-item-task-timeline", "task-item-task-group"]);
  assert.equal(
    await page.getByTestId("project-timeline-view").getByTestId("task-item-task-archive").count(),
    0,
  );
  assert.equal(await page.getByTestId("task-item-task-timeline").count(), 1);

  await page.getByTestId("project-view-grouped").click();
  await page.getByTestId("project-grouped-view").waitFor();
  await page.getByText("Focus", { exact: true }).waitFor();
  assert.equal(await page.getByTestId("task-item-task-group").count(), 1);
  assert.equal(await page.getByTestId("task-item-task-archive").count(), 0);
  assert.equal(
    await page.getByTestId("project-grouped-pinned").getByTestId("task-item-task-timeline").count(),
    1,
  );
  assert.equal(await page.getByTestId("project-timeline-view").count(), 0);

  const groupedTaskIds = () =>
    page
      .locator(
        `[data-project-group-id="${group.id}"][data-project-grouped-drag="task"] [data-testid^="task-item-"]`,
      )
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-testid")?.slice("task-item-".length)),
      );
  assert.deepEqual(await groupedTaskIds(), ["task-group", "drag-one", "drag-two", "drag-three"]);

  const dragTask = async (
    sourceId: string,
    targetId: string,
    options: { before?: boolean; escape?: boolean } = {},
  ) => {
    const source = page.getByTestId(`task-item-${sourceId}`);
    const target = page.getByTestId(`task-item-${targetId}`);
    await source.scrollIntoViewIfNeeded();
    await target.scrollIntoViewIfNeeded();
    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    assert.ok(sourceBox && targetBox);
    await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      sourceBox.x + sourceBox.width / 2,
      sourceBox.y + sourceBox.height / 2 + 8,
      { steps: 2 },
    );
    // 拖拽开始后行高/滚动可能变化，落点必须用当前 DOM 重新测量。
    const liveTargetBox = await target.boundingBox();
    assert.ok(liveTargetBox);
    await page.mouse.move(
      liveTargetBox.x + liveTargetBox.width / 2,
      liveTargetBox.y + (options.before === false ? liveTargetBox.height - 3 : 3),
      { steps: 8 },
    );
    await page.getByTestId("project-grouped-drag-overlay").waitFor();
    await page.getByTestId("project-grouped-drop-indicator").waitFor({ state: "attached" });
    if (options.escape) {
      await page.keyboard.press("Escape");
      await page.mouse.up();
      await page.getByTestId("project-grouped-drag-overlay").waitFor({ state: "detached" });
      return;
    }
    await page.mouse.up();
    await page.getByTestId("project-grouped-drag-overlay").waitFor({ state: "detached" });
  };

  // 同组重排：hover preview 只改 UI，drop 后一条单节点命令落库。
  await dragTask("drag-three", "drag-one", { before: true });
  await page.waitForFunction(
    (groupId) =>
      [
        ...document.querySelectorAll(
          `[data-project-group-id="${groupId}"][data-project-grouped-drag="task"] [data-testid^="task-item-"]`,
        ),
      ]
        .map((element) => element.getAttribute("data-testid")?.slice("task-item-".length))
        .join(",") === "task-group,drag-three,drag-one,drag-two",
    group.id,
  );

  // Esc 只丢预览，不提交任何写入。
  const orderBeforeEscape = await groupedTaskIds();
  await dragTask("drag-two", "drag-one", { before: true, escape: true });
  assert.deepEqual(await groupedTaskIds(), orderBeforeEscape);

  // 外部窗口已改来源但广播未到：drop 必须被 source CAS 拒绝，不覆盖外部结果。
  await host.moveTaskGroupNodeSilently({
    node: {
      type: "task",
      task: { workspacePath: host.paths.workspaceA, taskId: "drag-one", hostId: "local" },
    },
    sourceGroupId: group.id,
    groupId: otherGroup.id,
  });
  await dragTask("drag-one", "drag-two", { before: true });
  const treeAfterStale = await host.readTree();
  assert.equal(
    treeAfterStale.taskGroups?.members.find((member) => member.taskId === "drag-one")?.groupId,
    otherGroup.id,
  );

  await page.getByTestId("project-view-archive").click();
  await page.getByTestId("project-archive-view").waitFor();
  await page.getByTestId("project-archive-view").getByText("Archived task").waitFor();
  assert.equal(await page.getByTestId("project-archive-task").count(), 1);
  await page.getByTestId("project-archive-unarchive").click();
  await page.getByTestId("project-archive-task").waitFor({ state: "detached" });

  await page.getByTestId("project-view-timeline").click();
  await page.getByTestId("project-timeline-view").waitFor();
  assert.equal(await page.getByTestId("project-list").count(), 0);
}
