import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createGitCommandProvider } from "../src/git/providers/gitCommandProvider.js";
import { createManagedWorktreeRepo } from "../src/git/managed-worktree/repo.js";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zcode-worktree-test-"));
  roots.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  await writeFile(join(repo, "file.txt"), "base\n");
  git("add", "file.txt");
  git("commit", "-qm", "base");
  return {
    root,
    repo,
    service: createManagedWorktreeRepo({
      commandProvider: createGitCommandProvider(),
      dataBaseDir: () => root,
    }),
  };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("managed Git worktree ownership gates", () => {
  it("creates under the managed layout and deletes only verified, clean, unreferenced worktrees", async () => {
    const { repo, service } = await fixture();
    const created = await service.create(repo, null);
    if (!created.ok) throw new Error(JSON.stringify(created));
    expect(created).toMatchObject({ ok: true });
    if (!created.ok) return;
    expect(await service.list(repo)).toHaveLength(1);
    expect(
      await service.remove(repo, created.value.path, {
        force: true,
        hasTasks: true,
        hasSharedReferences: false,
      }),
    ).toMatchObject({ ok: false, error: { code: "in-use" } });
    expect(
      await service.remove(repo, created.value.path, {
        force: false,
        hasTasks: false,
        hasSharedReferences: true,
      }),
    ).toMatchObject({ ok: false, error: { code: "shared-reference" } });
    expect(
      await service.remove(repo, created.value.path, {
        force: false,
        hasTasks: false,
        hasSharedReferences: false,
      }),
    ).toMatchObject({ ok: true });
  });
  it("refuses dirty worktrees used by tasks and refuses arbitrary user directories", async () => {
    const { root, repo, service } = await fixture();
    const created = await service.create(repo, null);
    if (!created.ok) throw new Error(JSON.stringify(created));
    expect(created).toMatchObject({ ok: true });
    if (!created.ok) return;
    await writeFile(join(created.value.path, "dirty.txt"), "keep me");
    expect(
      await service.remove(repo, created.value.path, {
        force: false,
        hasTasks: true,
        hasSharedReferences: false,
      }),
    ).toMatchObject({ ok: false, error: { code: "dirty" } });
    expect(
      await service.remove(repo, created.value.path, {
        force: true,
        hasTasks: true,
        hasSharedReferences: false,
      }),
    ).toMatchObject({ ok: false, error: { code: "in-use" } });
    expect(
      await service.remove(repo, join(root, "repo"), {
        force: true,
        hasTasks: false,
        hasSharedReferences: false,
      }),
    ).toMatchObject({ ok: false, error: { code: "not-managed" } });
    expect(await service.list(repo)).toHaveLength(1);
  });
});
