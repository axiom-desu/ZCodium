import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AutomationRepo } from "#src/session/automationRepo.js";
import { AutomationService } from "#src/session/automationService.js";

// CronPauseSelf 的 Host 侧契约：条件暂停必须是数据库单写者的一次 UPDATE，
// 只把 active+enabled 的任务转 paused，重复/跨 workspace/终态调用都返回 false。

async function withService(
  run: (service: AutomationService, workspacePath: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-automation-pause-"));
  const repo = new AutomationRepo(join(dir, "tasks-index.sqlite"));
  try {
    const workspacePath = join(dir, "workspace");
    await repo.ensureReady();
    await run(new AutomationService(repo), workspacePath);
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("pause 只把 active+enabled 的任务转 paused，并返回真实变更", async () => {
  await withService(async (service, workspacePath) => {
    const created = await service.create({
      cronExpr: "0 9 * * *",
      prompt: "daily",
      recurring: true,
      title: "daily",
      workspacePath,
    });
    assert.equal(created.lifecycleStatus, "active");
    assert.equal(created.enabled, true);

    assert.equal(await service.pause(created.automationId, { workspacePath }), true);
    const paused = await service.get(created.automationId, { workspacePath });
    assert.equal(paused?.lifecycleStatus, "paused");
    assert.equal(paused?.enabled, false);

    // 已 paused：条件不满足，不得再声称变更。
    assert.equal(await service.pause(created.automationId, { workspacePath }), false);
    // 跨 workspace：归属不符，同样 false 且不改状态。
    assert.equal(
      await service.pause(created.automationId, { workspacePath: `${workspacePath}-other` }),
      false,
    );
    // 不存在的 id：false。
    assert.equal(await service.pause("automation-missing", { workspacePath }), false);
  });
});

test("pause 不改变 completed/failed 终态", async () => {
  await withService(async (service, workspacePath) => {
    const created = await service.create({
      cronExpr: "0 9 * * *",
      prompt: "one shot",
      recurring: false,
      title: "one shot",
      workspacePath,
      maxRuns: 1,
    });
    await service.setEnabled(created.automationId, false, { workspacePath });
    // setEnabled(false) 走 paused，不是 completed；恢复后暂停语义保持。
    assert.equal(await service.pause(created.automationId, { workspacePath }), false);
  });
});
