import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createManagedWorktreeFixture,
  type ManagedWorktreeFixture,
  type ManagedWorktreeFixtureOptions,
} from "./fixtures/managedWorktreeFixture.js";

const fixtures: ManagedWorktreeFixture[] = [];
async function fixture(options: ManagedWorktreeFixtureOptions = {}) {
  const value = await createManagedWorktreeFixture(options);
  fixtures.push(value);
  return value;
}
afterEach(async () => {
  for (const value of fixtures.splice(0)) await value.dispose();
});

describe("managed worktree task lifecycle", () => {
  it("creates a worktree task through real admission and deletes it after release", async () => {
    const { project, repository, db, service, releases } = await fixture();
    const created = await service.createTask({ projectId: project.id, ref: null });
    if (!created.ok) throw new Error(JSON.stringify(created));
    const tasks = repository.listTasksByWorktree({ worktreeRoot: created.value.worktreeRoot });
    expect(tasks).toMatchObject([{ taskId: created.value.taskId, projectId: project.id }]);
    expect(
      (await service.listWorktrees({ projectId: project.id })).groups[0]?.worktrees,
    ).toMatchObject([
      { path: created.value.worktreeRoot, tasks: [{ taskId: created.value.taskId }] },
    ]);
    // 有任务使用时 dirty 拒绝删除。
    await writeFile(join(created.value.worktreeRoot, "changed.txt"), "dirty\n");
    expect(
      await service.removeWorktree({
        projectId: project.id,
        worktreeRoot: created.value.worktreeRoot,
      }),
    ).toMatchObject({ ok: false, error: { code: "dirty" } });
    // 任务释放后方可删除（force 不能替代释放）。
    db.prepare("DELETE FROM tasks WHERE worktree_root=?").run(created.value.worktreeRoot);
    execFileSync("git", ["checkout", "--", "."], {
      cwd: created.value.worktreeRoot,
      stdio: "ignore",
    });
    execFileSync("git", ["clean", "-fdq"], { cwd: created.value.worktreeRoot, stdio: "ignore" });
    expect(
      await service.removeWorktree({
        projectId: project.id,
        worktreeRoot: created.value.worktreeRoot,
      }),
    ).toMatchObject({ ok: true });
    expect((await service.listWorktrees({ projectId: project.id })).groups).toEqual([]);
    expect(await service.isWorktreeAvailable({ worktreeRoot: created.value.worktreeRoot })).toBe(
      false,
    );
    // 删除前必须等待真实 CLI 卸载 ACK；卸载目录就是本次 worktree，不含其他 workspace 的目录。
    expect(
      releases.some(
        (call) =>
          call.directory === created.value.worktreeRoot &&
          // 任务行已释放时仍用项目 root 的既有 CLI 进程请求卸载；directory 限定目标。
          call.workspacePath === project.roots[0]!.rootPath,
      ),
    ).toBe(true);
  });

  it("rejects running tasks, shared directory references and stale ownership", async () => {
    const { project, repository, service, active, directory, repoPath } = await fixture();
    const created = await service.createTask({ projectId: project.id, ref: null });
    if (!created.ok) throw new Error(JSON.stringify(created));
    active.add(created.value.taskId);
    expect(
      await service.removeWorktree({
        projectId: project.id,
        worktreeRoot: created.value.worktreeRoot,
      }),
    ).toMatchObject({ ok: false, error: { code: "in-use", detail: "running" } });
    active.clear();
    // 未标记 worktree_root 的同目录任务属于共享引用，不能借删除清掉。
    repository.reserveCreatedTask({
      task: { workspacePath: join(created.value.worktreeRoot, "child"), taskId: "shared-task" },
      projectId: project.id,
      additionalDirectories: [created.value.worktreeRoot],
    });
    expect(
      await service.removeWorktree({
        projectId: project.id,
        worktreeRoot: created.value.worktreeRoot,
      }),
    ).toMatchObject({ ok: false, error: { code: "shared-reference" } });
    // 任意用户仓库/非受管路径一律 not-managed。
    const outside = join(directory, "outside");
    await mkdir(outside);
    execFileSync("git", ["init", "-q"], { cwd: outside });
    expect(
      await service.removeWorktree({ projectId: project.id, worktreeRoot: outside }),
    ).toMatchObject({ ok: false, error: { code: "not-managed" } });
    expect(
      await service.removeWorktree({ projectId: project.id, worktreeRoot: repoPath }),
    ).toMatchObject({ ok: false, error: { code: "not-managed" } });
  });

  it("retains a failed result without an authoritative reservation receipt", async () => {
    const { project, service, db } = await fixture({ sessionFails: "none", releaseReleases: [] });
    const created = await service.createTask({ projectId: project.id, ref: null });
    expect(created).toMatchObject({ ok: false, error: { code: "session-failed" } });
    expect((await service.listWorktrees({ projectId: project.id })).groups).toHaveLength(1);
    const rows = db
      .prepare("SELECT count(*) AS count FROM tasks WHERE worktree_root IS NOT NULL")
      .get() as { count: number };
    expect(rows.count).toBe(0);
  });

  it("retains a forwarded unknown result even when both receipt and product projection are absent", async () => {
    const { project, service, repository, releases } = await fixture({
      sessionFails: "forwarded-invisible",
      releaseReleases: [],
    });
    const created = await service.createTask({ projectId: project.id, ref: null });
    expect(created).toMatchObject({
      ok: false,
      error: { code: "session-failed", detail: expect.stringContaining("worktree retained") },
    });
    const groups = (await service.listWorktrees({ projectId: project.id })).groups;
    expect(groups).toHaveLength(1);
    const path = groups[0]!.worktrees[0]!.path;
    expect(repository.listTasksByWorktree({ worktreeRoot: path })).toEqual([]);
    expect(await service.isWorktreeAvailable({ worktreeRoot: path })).toBe(true);
    expect(releases).toEqual([]);
  });

  it("cleans up only when the existing reservation proves the session was never claimed", async () => {
    const { project, service, db } = await fixture({
      sessionFails: "reserved",
      releaseReleases: [],
    });
    const created = await service.createTask({ projectId: project.id, ref: null });
    expect(created).toMatchObject({ ok: false, error: { code: "session-failed" } });
    expect((await service.listWorktrees({ projectId: project.id })).groups).toEqual([]);
    const rows = db
      .prepare("SELECT count(*) AS count FROM tasks WHERE worktree_root IS NOT NULL")
      .get() as { count: number };
    expect(rows.count).toBe(0);
  });

  it("retains the worktree and task row when the session may already be forwarded", async () => {
    const { project, repository, db, service } = await fixture({ sessionFails: "forwarded" });
    const created = await service.createTask({ projectId: project.id, ref: null });
    expect(created).toMatchObject({ ok: false, error: { code: "session-failed" } });
    if (created.ok) throw new Error("unreachable");
    expect(created.error.detail).toContain("worktree retained");
    const groups = (await service.listWorktrees({ projectId: project.id })).groups;
    expect(groups).toHaveLength(1);
    const worktree = groups[0]!.worktrees[0]!;
    // 目录、DB 预留行、运行态都没有被失败路径清掉。
    expect(worktree.tasks).toMatchObject([{ taskId: expect.any(String), projectId: project.id }]);
    expect(await service.isWorktreeAvailable({ worktreeRoot: worktree.path })).toBe(true);
    expect(repository.listTasksByWorktree({ worktreeRoot: worktree.path })).toHaveLength(1);
    // 后续管理入口在任务释放后仍能安全重试删除。
    db.prepare("DELETE FROM tasks WHERE worktree_root=?").run(worktree.path);
    expect(
      await service.removeWorktree({ projectId: project.id, worktreeRoot: worktree.path }),
    ).toMatchObject({ ok: true });
    expect(await service.isWorktreeAvailable({ worktreeRoot: worktree.path })).toBe(false);
  });

  it("retains when an unclaimed reservation is contradicted by a live CLI session", async () => {
    const { project, service } = await fixture({
      sessionFails: "reserved",
      releaseReleases: ["sess-live"],
    });
    const created = await service.createTask({ projectId: project.id, ref: null });
    expect(created).toMatchObject({ ok: false, error: { code: "session-failed" } });
    const groups = (await service.listWorktrees({ projectId: project.id })).groups;
    expect(groups).toHaveLength(1);
    const worktreeRoot = groups[0]!.worktrees[0]!.path;
    expect(await service.isWorktreeAvailable({ worktreeRoot })).toBe(true);
    // CLI 没有驻留会话后，管理入口可以重试并成功删除。
    expect(await service.removeWorktree({ projectId: project.id, worktreeRoot })).toMatchObject({
      ok: true,
    });
  });

  it("blocks deletion until CLI release ACK is idle, and never force-deletes live sessions", async () => {
    const busy = await fixture({ releaseBusy: true });
    const created = await busy.service.createTask({ projectId: busy.project.id, ref: null });
    if (!created.ok) throw new Error(JSON.stringify(created));
    busy.db.prepare("DELETE FROM tasks WHERE worktree_root=?").run(created.value.worktreeRoot);
    expect(
      await busy.service.removeWorktree({
        projectId: busy.project.id,
        worktreeRoot: created.value.worktreeRoot,
      }),
    ).toMatchObject({ ok: false, error: { code: "in-use", detail: "running" } });
    expect(
      await busy.service.isWorktreeAvailable({ worktreeRoot: created.value.worktreeRoot }),
    ).toBe(true);

    const failing = await fixture({ releaseFails: true });
    const second = await failing.service.createTask({ projectId: failing.project.id, ref: null });
    if (!second.ok) throw new Error(JSON.stringify(second));
    failing.db.prepare("DELETE FROM tasks WHERE worktree_root=?").run(second.value.worktreeRoot);
    expect(
      await failing.service.removeWorktree({
        projectId: failing.project.id,
        worktreeRoot: second.value.worktreeRoot,
      }),
    ).toMatchObject({ ok: false, error: { code: "session-close-failed" } });
    expect(
      await failing.service.isWorktreeAvailable({ worktreeRoot: second.value.worktreeRoot }),
    ).toBe(true);
  });

  it("rejects removal when a terminal still holds the worktree cwd", async () => {
    const { project, service, db, terminalPaths } = await fixture();
    const created = await service.createTask({ projectId: project.id, ref: null });
    if (!created.ok) throw new Error(JSON.stringify(created));
    db.prepare("DELETE FROM tasks WHERE worktree_root=?").run(created.value.worktreeRoot);
    terminalPaths.push(created.value.worktreeRoot);
    expect(
      await service.removeWorktree({
        projectId: project.id,
        worktreeRoot: created.value.worktreeRoot,
      }),
    ).toMatchObject({ ok: false, error: { code: "in-use", detail: "terminal" } });
    expect(await service.isWorktreeAvailable({ worktreeRoot: created.value.worktreeRoot })).toBe(
      true,
    );
  });

  it("forks through real forkAssistant contract cwd and reserves the same child session", async () => {
    const { project, repository, service, forks } = await fixture();
    const created = await service.forkTask({
      projectId: project.id,
      sourceTaskId: "parent-task",
      sourceWorkspacePath: join(project.roots[0]!.rootPath),
      target: { rowId: 3, entityId: "assistant-3" },
      baseRevision: 7,
      baseLogEpoch: "epoch-1",
      ref: null,
    });
    if (!created.ok) throw new Error(JSON.stringify(created));
    expect(forks).toMatchObject([
      {
        target: { rowId: 3, entityId: "assistant-3" },
        targetCwd: {
          cwd: created.value.worktreeRoot,
          childSessionId: created.value.taskId,
        },
      },
    ]);
    expect(
      repository.listTasksByWorktree({ worktreeRoot: created.value.worktreeRoot }),
    ).toMatchObject([{ taskId: created.value.taskId, projectId: project.id }]);
    expect(
      (await service.listWorktrees({ projectId: project.id })).groups[0]?.worktrees[0]?.tasks,
    ).toMatchObject([{ taskId: created.value.taskId }]);
  });

  it("refuses worktree creation/fork when CLI lacks worktreeCwd and rolls back failed forks", async () => {
    const unsupported = await fixture({ supportsWorktreeCwd: false });
    expect(
      await unsupported.service.createTask({ projectId: unsupported.project.id, ref: null }),
    ).toMatchObject({ ok: false, error: { code: "unsupported-agent" } });
    expect(
      await unsupported.service.forkTask({
        projectId: unsupported.project.id,
        sourceTaskId: "parent-task",
        sourceWorkspacePath: unsupported.repoPath,
        target: { rowId: 1, entityId: "assistant-1" },
        baseRevision: 1,
        baseLogEpoch: "epoch-1",
      }),
    ).toMatchObject({ ok: false, error: { code: "unsupported-agent" } });
    expect(
      (await unsupported.service.listWorktrees({ projectId: unsupported.project.id })).groups,
    ).toEqual([]);

    const failing = await fixture({ forkFails: true, releaseReleases: [] });
    expect(
      await failing.service.forkTask({
        projectId: failing.project.id,
        sourceTaskId: "parent-task",
        sourceWorkspacePath: failing.repoPath,
        target: { rowId: 1, entityId: "assistant-1" },
        baseRevision: 1,
        baseLogEpoch: "epoch-1",
      }),
    ).toMatchObject({ ok: false, error: { code: "session-failed" } });
    expect((await failing.service.listWorktrees({ projectId: failing.project.id })).groups).toEqual(
      [],
    );
  });

  it("never deletes on a forked child session id mismatch and allows later removal", async () => {
    const { project, repository, db, service } = await fixture({ forkMismatch: true });
    expect(
      await service.forkTask({
        projectId: project.id,
        sourceTaskId: "parent-task",
        sourceWorkspacePath: project.roots[0]!.rootPath,
        target: { rowId: 2, entityId: "assistant-2" },
        baseRevision: 4,
        baseLogEpoch: "epoch-1",
        ref: null,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: "session-failed", detail: "child session id mismatch" },
    });
    const groups = (await service.listWorktrees({ projectId: project.id })).groups;
    expect(groups).toHaveLength(1);
    const worktreeRoot = groups[0]!.worktrees[0]!.path;
    expect(repository.listTasksByWorktree({ worktreeRoot })).toHaveLength(1);
    expect(await service.isWorktreeAvailable({ worktreeRoot })).toBe(true);
    // 管理入口在任务释放后仍能重试。
    db.prepare("DELETE FROM tasks WHERE worktree_root=?").run(worktreeRoot);
    expect(await service.removeWorktree({ projectId: project.id, worktreeRoot })).toMatchObject({
      ok: true,
    });
  });
});
