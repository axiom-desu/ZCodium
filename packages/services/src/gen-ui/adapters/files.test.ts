import { mkdtemp, mkdir, readdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getGenUiOutputDirectory } from "@zcode/shared/node";
import { readGenUiDocument } from "./files.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(workspaceIdentity?: string) {
  const root = await mkdtemp(join(tmpdir(), "zcode-gen-ui-"));
  roots.push(root);
  const workspacePath = join(root, "workspace"),
    outputRoot = join(root, "user-data", "visualizations");
  const scope = { workspacePath, workspaceIdentity, sessionId: "test" };
  const directory = getGenUiOutputDirectory(outputRoot, scope);
  await mkdir(workspacePath);
  await mkdir(directory, { recursive: true });
  return { root, outputRoot, directory, target: { ...scope, path: join(directory, "chart.html") } };
}

describe("Gen UI executor file reader", () => {
  it.each([undefined, "ssh:executor:/workspace"])(
    "reads the session output without writing into Git (%s)",
    async (identity) => {
      const { outputRoot, target } = await fixture(identity);
      await writeFile(target.path, '<div id="chart">Hello</div>');
      expect((await readGenUiDocument(target, outputRoot)).html).toContain("Hello");
      expect(await readdir(target.workspacePath)).toEqual([]);
      await expect(
        readGenUiDocument({ ...target, sessionId: "other" }, outputRoot),
      ).rejects.toThrow("session output");
      await expect(
        readGenUiDocument({ ...target, workspaceIdentity: "ssh:other:/workspace" }, outputRoot),
      ).rejects.toThrow("session output");
    },
  );
  it("rejects old workspace paths and symbolic links, including the session directory", async () => {
    const { outputRoot, target, directory } = await fixture();
    const oldPath = join(target.workspacePath, "chart.html");
    await writeFile(oldPath, "outside");
    await expect(readGenUiDocument({ ...target, path: oldPath }, outputRoot)).rejects.toThrow(
      "session output",
    );
    await symlink(oldPath, target.path);
    await expect(readGenUiDocument(target, outputRoot)).rejects.toThrow("symbolic links");
    await rm(directory, { recursive: true });
    await symlink(target.workspacePath, directory, "junction");
    await expect(readGenUiDocument(target, outputRoot)).rejects.toThrow("symbolic links");
  });
  it("rejects an output root redirected into the repository", async () => {
    const { root, target } = await fixture();
    const outputRoot = join(root, "redirected");
    await symlink(target.workspacePath, outputRoot, "junction");
    const path = join(
      getGenUiOutputDirectory(outputRoot, {
        workspacePath: target.workspacePath,
        sessionId: target.sessionId,
      }),
      "chart.html",
    );
    await expect(readGenUiDocument({ ...target, path }, outputRoot)).rejects.toThrow(
      "outside the workspace",
    );
  });
  it("rejects whole documents and files above the byte limit", async () => {
    const { outputRoot, target } = await fixture();
    await writeFile(target.path, "<!doctype html><html><body>not a fragment</body></html>");
    await expect(readGenUiDocument(target, outputRoot)).rejects.toThrow("fragment");
    await writeFile(target.path, "x".repeat(5_000_001));
    await expect(readGenUiDocument(target, outputRoot)).rejects.toThrow("5 MB");
  });
});
