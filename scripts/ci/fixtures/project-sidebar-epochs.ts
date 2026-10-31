import assert from "node:assert/strict";

/** Deferred results come from the real temporary ProjectService, never a copied command implementation. */
export async function runProjectSidebarEpochsSmoke(page, host, baseUrl) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const arm = async (method, fail) =>
    page.evaluate(
      ({ method, fail }) => {
        window.projectSidebarFixture.arm(method, fail);
      },
      { method, fail },
    );
  const started = () => page.waitForFunction(() => window.projectSidebarFixture.barrier?.started);
  const holdA = () =>
    page.evaluate(() => {
      window.releaseEpochA = window.projectSidebarFixture.release;
      window.epochA = window.projectSidebarFixture.barrier;
    });
  const releaseA = async () => {
    await page.evaluate(() => window.releaseEpochA());
    await page.waitForFunction(() => window.epochA.done);
    // Observe settled production React commits, not an arbitrary delay.
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  };
  await host.saveProject({ name: "Epoch A", roots: [host.paths.workspaceA] });
  await host.saveProject({
    name: "Epoch B",
    roots: [host.paths.workspaceB, host.paths.workspaceA],
  });
  for (const transition of ["scope", "service", "unmount"]) {
    for (const fail of [false, true]) {
      await page.goto(`${baseUrl}/?workspace=${encodeURIComponent(host.paths.workspaceA)}`);
      const row = page.locator('[data-project-name="Epoch A"]');
      await row.waitFor();
      await arm("prepareSession", fail);
      await row.getByTestId("project-new-task").click();
      await started();
      await holdA();
      if (transition === "scope")
        await page.evaluate(() => window.projectSidebarFixture.setScope("/scope-b"));
      else if (transition === "service")
        await page.evaluate(() => window.projectSidebarFixture.swapService());
      else await page.evaluate(() => window.projectSidebarFixture.setScope(""));
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      if (transition !== "unmount") {
        await row.waitFor();
        await arm("prepareSession", false);
        await row.getByTestId("project-new-task").click();
        await started();
      }
      await releaseA();
      assert.equal(
        await page.evaluate(() => window.projectSidebarFixture.created.length),
        0,
        `prepare ${transition}/${fail}: no stale navigation`,
      );
      assert.equal(await page.getByText(/stale-fixture-error/).count(), 0);
      if (transition !== "unmount") {
        assert.equal(
          await row.getByTestId("project-new-task").isDisabled(),
          true,
          "A finally cannot unlock B prepare",
        );
        await page.evaluate(() => window.projectSidebarFixture.release());
        await page.waitForFunction(() => window.projectSidebarFixture.created.length === 1);
      }
    }
  }

  // 旧 refresh 在 scope/service 换代后不能借当前 token 启动旧服务。
  for (const transition of ["scope", "service"]) {
    await page.goto(
      `${baseUrl}/?dialog=editor&workspace=${encodeURIComponent(host.paths.workspaceA)}`,
    );
    await page.getByTestId("dialog-harness-ready").waitFor();
    await page.evaluate(() => {
      window.oldRefresh = window.projectSidebarFixture.refresh;
    });
    if (transition === "scope")
      await page.evaluate(() => window.projectSidebarFixture.setScope("/scope-b"));
    else await page.evaluate(() => window.projectSidebarFixture.swapService());
    await page.waitForFunction(() => window.oldRefresh !== window.projectSidebarFixture.refresh);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    const reads = await page.evaluate(async () => {
      const before = window.projectSidebarFixture.reads.length;
      await window.oldRefresh();
      return { before, after: window.projectSidebarFixture.reads.length };
    });
    assert.equal(reads.after, reads.before, `old refresh/${transition}: zero old service reads`);
  }

  for (const kind of ["editor", "delete", "move", "restore"]) {
    for (const transition of ["reopen", "scope", "service"]) {
      for (const fail of [false, true]) {
        const deleted = await host.saveProject({
          name: `Epoch deleted ${kind}-${transition}-${fail}`,
          roots: [],
        });
        await host.deleteProject(deleted.id, deleted.hostId);
        const targetName = `Epoch deletable ${transition}-${fail}`;
        if (kind === "delete") await host.saveProject({ name: targetName, roots: [] });
        await page.goto(
          `${baseUrl}/?dialog=${kind}&project=${kind === "delete" ? encodeURIComponent(targetName) : ""}&workspace=${encodeURIComponent(host.paths.workspaceA)}`,
        );
        await page.getByTestId("dialog-harness-ready").waitFor();
        const dialogId = kind === "delete" ? "editor" : kind;
        const method =
          kind === "move" ? "moveTask" : kind === "delete" ? "deleteProject" : "saveProject";
        const submit =
          kind === "editor"
            ? page.getByTestId("project-editor-save")
            : kind === "delete"
              ? page.getByTestId("project-editor-delete-apply")
              : kind === "move"
                ? page.getByTestId("project-move-apply")
                : page.locator('[data-testid^="project-restore-Epoch deleted"]').last();
        if (kind === "editor") await page.getByTestId("project-editor-name").fill("Epoch editor A");
        await arm(method, fail);
        await submit.click();
        await started();
        await holdA();
        if (transition === "reopen") {
          await page.evaluate(() => window.projectSidebarFixture.setDialogOpen(false));
          await page.getByTestId(`project-${dialogId}-dialog`).waitFor({ state: "detached" });
          await page.evaluate(() => window.projectSidebarFixture.setDialogOpen(true));
        } else if (transition === "scope")
          await page.evaluate(() => window.projectSidebarFixture.setScope("/scope-b"));
        else await page.evaluate(() => window.projectSidebarFixture.swapService());
        await page.getByTestId(`project-${dialogId}-dialog`).waitFor();
        if (kind === "editor") await page.getByTestId("project-editor-name").fill("Epoch editor B");
        await arm(method, false);
        await submit.click();
        await started();
        await releaseA();
        assert.equal(
          await page.getByTestId(`project-${dialogId}-dialog`).count(),
          1,
          `${kind} ${transition}/${fail}: A cannot close B`,
        );
        assert.equal(
          await submit.isDisabled(),
          true,
          `${kind} ${transition}/${fail}: A finally cannot unlock B`,
        );
        assert.equal(
          await page.getByText(/stale-fixture-error/).count(),
          0,
          "A catch cannot display stale error",
        );
        if (kind === "editor")
          assert.equal(
            await page.getByTestId("project-editor-name").inputValue(),
            "Epoch editor B",
          );
        await page.evaluate(() => window.projectSidebarFixture.release());
        await page.waitForFunction(() => window.projectSidebarFixture.barrier.done);
      }
    }
  }
  // 服务替换必须关闭真实 Sidebar 的旧编辑器，而非只让测试 harness 自行重开。
  await page.goto(`${baseUrl}/?workspace=${encodeURIComponent(host.paths.workspaceA)}`);
  await page.getByTestId("project-add").click();
  await page.getByTestId("project-sidebar-create").click();
  await page.getByTestId("project-editor-dialog").waitFor();
  await page.evaluate(() => window.projectSidebarFixture.swapService());
  await page.getByTestId("project-editor-dialog").waitFor({ state: "detached" });
  assert.deepEqual(errors, []);
  console.log(
    "project-sidebar epochs: PASS (6 prepare + 24 dialog deferred schedules + 2 old refresh callbacks)",
  );
}
