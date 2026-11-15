import { afterEach, describe, expect, it } from "vitest";
import {
  createManagedWorktreeFixture,
  type ManagedWorktreeFixture,
  waitForFact,
} from "./fixtures/managedWorktreeFixture.js";

const fixtures: ManagedWorktreeFixture[] = [];
afterEach(async () => {
  for (const value of fixtures.splice(0)) await value.dispose();
});

describe("managed worktree cross-Host leases", () => {
  it("lets another Host see creating and refuse to delete the unfinished worktree", async () => {
    let releaseSession: () => void = () => {};
    const sessionWait = new Promise<void>((resolve) => {
      releaseSession = resolve;
    });
    const hostA = await createManagedWorktreeFixture({ sessionWait });
    fixtures.push(hostA);
    // 同一 tasks-index 的第二条 SQLite 连接 + 独立服务实例 = 另一个窗口 Host 进程。
    const hostB = await hostA.openHost();
    const projectId = hostA.project.id;
    const creating = hostA.service.createTask({ projectId, ref: null });
    let worktreeRoot = "";
    await waitForFact(async () => {
      const groups = (await hostB.service.listWorktrees({ projectId })).groups;
      worktreeRoot = groups[0]?.worktrees[0]?.path ?? "";
      return Boolean(worktreeRoot) && groups[0]!.worktrees[0]!.creating === true;
    }, "cross-Host creating lease");
    expect(await hostB.service.removeWorktree({ projectId, worktreeRoot })).toMatchObject({
      ok: false,
      error: { code: "in-use" },
    });
    releaseSession();
    expect(await creating).toMatchObject({ ok: true });
    hostB.db.prepare("DELETE FROM tasks WHERE worktree_root=?").run(worktreeRoot);
    expect(await hostB.service.removeWorktree({ projectId, worktreeRoot })).toMatchObject({
      ok: true,
    });
  });

  it("lets another Host see removing and refuse a concurrent delete", async () => {
    let releaseRemoval: () => void = () => {};
    let reachedRemoval: () => void = () => {};
    const releaseWait = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      reachedRemoval = resolve;
    });
    const hostA = await createManagedWorktreeFixture({
      releaseWait,
      onRelease: () => reachedRemoval(),
    });
    fixtures.push(hostA);
    const hostB = await hostA.openHost();
    const projectId = hostA.project.id;
    const created = await hostA.service.createTask({ projectId, ref: null });
    if (!created.ok) throw new Error(JSON.stringify(created));
    hostA.db.prepare("DELETE FROM tasks WHERE worktree_root=?").run(created.value.worktreeRoot);
    const removing = hostA.service.removeWorktree({
      projectId,
      worktreeRoot: created.value.worktreeRoot,
    });
    // 到这里 Host A 已取得删除租约并停在 CLI 卸载 ACK 之前。
    await reached;
    expect(
      await hostB.service.removeWorktree({
        projectId,
        worktreeRoot: created.value.worktreeRoot,
      }),
    ).toMatchObject({ ok: false, error: { code: "in-use" } });
    releaseRemoval();
    expect(await removing).toMatchObject({ ok: true });
    expect(
      await hostB.service.isWorktreeAvailable({ worktreeRoot: created.value.worktreeRoot }),
    ).toBe(false);
  });
});
