import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE,
  type SourceServerInstallProgress,
} from "@zcode/shared";
import { createStoppedServerStatus } from "../src/contracts.js";
import { createControlServer } from "../src/ipc/controlServer.js";
import { currentServerTarget } from "../src/runtime/manifest.js";
import { resolveServerLayout } from "../src/runtime/paths.js";
import { ReleaseInstaller } from "../src/runtime/releaseInstaller.js";
import { ReleaseManager } from "../src/runtime/releaseManager.js";
import { runLocalArchiveUpdateCommand } from "../src/runtime/updateCommand.js";

const execFileAsync = promisify(execFile);
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});

interface ArchiveInput {
  version?: string;
  target?: string;
  appVersion?: string;
}

async function createReleaseArchive(options: ArchiveInput = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zcode-r3-archive-src-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const target = options.target ?? currentServerTarget();
  const releaseRoot = join(root, `zcode-server-${target}`);
  await mkdir(join(releaseRoot, "runtime"), { recursive: true });
  await writeFile(join(releaseRoot, "runtime", "server-cli.js"), "// fixture\n");
  await writeFile(
    join(releaseRoot, "manifest.json"),
    `${JSON.stringify(
      {
        product: "zcode-server",
        target,
        appVersion: options.appVersion ?? options.version ?? "3.16.2",
        nodeVersion: "24.14.0",
        entrypoints: {
          cli: "runtime/server-cli.js",
          core: "runtime/server-core.js",
          agent: "runtime/zcode.cjs",
        },
        native: [],
      },
      null,
      2,
    )}\n`,
  );
  const archiveDir = await mkdtemp(join(tmpdir(), "zcode-r3-archive-out-"));
  cleanup.push(() => rm(archiveDir, { recursive: true, force: true }));
  const archivePath = join(archiveDir, `zcode-server-${target}.tar.gz`);
  await execFileAsync("tar", ["-czf", archivePath, "-C", root, "."]);
  return archivePath;
}

function createIo() {
  const lines: string[] = [];
  return { io: { stdout: { write: (value: string) => lines.push(value) } }, lines };
}

async function createTempLayout() {
  const root = await mkdtemp(join(tmpdir(), "zcode-r3-update-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return resolveServerLayout(join(root, "server"));
}

describe("local archive update", () => {
  it("installs the same archive idempotently without leaving incoming releases", async () => {
    const layout = await createTempLayout();
    const archivePath = await createReleaseArchive();
    const { io, lines } = createIo();
    const applyUpdate = vi.fn();

    await runLocalArchiveUpdateCommand(
      ["update", "--from-archive", archivePath, "--json"],
      io,
      true,
      layout,
      applyUpdate,
    );
    const first = await new ReleaseManager(layout).readCurrent();
    expect(first?.version).toBe("3.16.2");
    expect(first?.target).toBe(currentServerTarget());
    expect(lines[0]).toContain('"installed":true');
    expect(await stat(layout.pendingFile).catch(() => undefined)).toBeUndefined();
    const releasesAfterFirst = await readdir(layout.releasesDir);

    await runLocalArchiveUpdateCommand(
      ["update", "--from-archive", archivePath, "--json"],
      io,
      true,
      layout,
      applyUpdate,
    );
    const second = await new ReleaseManager(layout).readCurrent();
    expect(second).toEqual(first);
    expect(await readdir(layout.releasesDir)).toEqual(releasesAfterFirst);
    expect(
      (await readdir(layout.releasesDir)).filter((name) => name.startsWith(".incoming-")),
    ).toEqual([]);
    expect(applyUpdate).not.toHaveBeenCalled();
  });

  it("reports progress only as structured JSON when requested", async () => {
    const layout = await createTempLayout();
    const archivePath = await createReleaseArchive();
    const { io, lines } = createIo();
    await runLocalArchiveUpdateCommand(
      ["update", "--from-archive", archivePath, "--json", "--progress"],
      io,
      true,
      layout,
      vi.fn(),
    );
    const phases = lines
      .map((line) => JSON.parse(line) as Partial<SourceServerInstallProgress>)
      .filter((entry) => entry.type === "source-server-install-progress")
      .map((entry) => entry.phase);
    expect(phases).toEqual(["verify-archive", "extract", "verify"]);
  });

  it("rejects an archive built for a different target before publishing it", async () => {
    const layout = await createTempLayout();
    const archivePath = await createReleaseArchive({
      target: currentServerTarget() === "darwin-arm64" ? "linux-x64" : "darwin-arm64",
    });
    await expect(
      runLocalArchiveUpdateCommand(
        ["update", "--from-archive", archivePath, "--json"],
        createIo().io,
        true,
        layout,
        vi.fn(),
      ),
    ).rejects.toThrow(/Release target mismatch/u);
    expect(await new ReleaseManager(layout).readCurrent()).toBeNull();
  });

  it("refuses to update while tasks run unless --force skips only the busy guard", async () => {
    const layout = await createTempLayout();
    await mkdir(layout.runDir, { recursive: true });
    const control = await createControlServer(layout.controlEndpoint, async (request) => {
      if (request.command === "prepare-update") return { status: "blocked", runningTaskCount: 1 };
      if (request.command === "status") return createStoppedServerStatus("3.16.2");
      throw new Error(`unexpected command: ${request.command}`);
    });
    cleanup.push(control.close);

    const archivePath = await createReleaseArchive();
    const guardedApply = vi.fn();
    await expect(
      runLocalArchiveUpdateCommand(
        ["update", "--from-archive", archivePath, "--json"],
        createIo().io,
        true,
        layout,
        guardedApply,
      ),
    ).rejects.toMatchObject({ code: SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE });
    expect(guardedApply).not.toHaveBeenCalled();
    expect(await new ReleaseManager(layout).readCurrent()).toBeNull();

    const forcedApply = vi.fn();
    await runLocalArchiveUpdateCommand(
      ["update", "--from-archive", archivePath, "--json", "--force"],
      createIo().io,
      true,
      layout,
      forcedApply,
    );
    // force 只跳过 running-task guard；archive/target/完整性校验仍执行，并进入在线 apply。
    expect(forcedApply).toHaveBeenCalledTimes(1);
    expect(await new ReleaseManager(layout).readPending()).not.toBeNull();
  });
  it("rolls back the pending release when tasks start during archive extraction", async () => {
    const layout = await createTempLayout();
    const archivePath = await createReleaseArchive();
    let prepareCalls = 0;
    const control = await createControlServer(layout.controlEndpoint, async (request) => {
      if (request.command === "prepare-update") {
        prepareCalls += 1;
        return prepareCalls === 1
          ? { status: "ready", runningTaskCount: 0 }
          : { status: "blocked", runningTaskCount: 1 };
      }
      throw new Error(`unexpected command: ${request.command}`);
    });
    cleanup.push(control.close);
    const applyUpdate = vi.fn();

    await expect(
      runLocalArchiveUpdateCommand(
        ["update", "--from-archive", archivePath, "--json"],
        createIo().io,
        true,
        layout,
        applyUpdate,
      ),
    ).rejects.toMatchObject({ code: SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE });

    // 第二次忙碌检查拒绝后，本次安装不能继续被选中为 pending。
    expect(await new ReleaseManager(layout).readCurrent()).toBeNull();
    expect(await new ReleaseManager(layout).readPending()).toBeNull();
    expect(applyUpdate).not.toHaveBeenCalled();
  });

  it("preserves a pre-existing legal pending release when the second guard blocks", async () => {
    const layout = await createTempLayout();
    const previousArchive = await createReleaseArchive({ version: "3.16.1" });
    const previous = await new ReleaseInstaller(layout).installArchive({
      archivePath: previousArchive,
      target: currentServerTarget(),
    });
    const archivePath = await createReleaseArchive({ version: "3.16.2" });
    let prepareCalls = 0;
    const control = await createControlServer(layout.controlEndpoint, async (request) => {
      if (request.command === "prepare-update") {
        prepareCalls += 1;
        return prepareCalls === 1
          ? { status: "ready", runningTaskCount: 0 }
          : { status: "blocked", runningTaskCount: 1 };
      }
      throw new Error(`unexpected command: ${request.command}`);
    });
    cleanup.push(control.close);

    await expect(
      runLocalArchiveUpdateCommand(
        ["update", "--from-archive", archivePath, "--json"],
        createIo().io,
        true,
        layout,
        vi.fn(),
      ),
    ).rejects.toMatchObject({ code: SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE });

    // 回滚只能恢复原 pending，不能把别的合法 pending 当成本次产物删掉。
    expect(await new ReleaseManager(layout).readPending()).toEqual(previous);
    expect(await new ReleaseManager(layout).readCurrent()).toBeNull();
  });

  it("serializes concurrent same-version updates without corrupting pending", async () => {
    const layout = await createTempLayout();
    const archivePath = await createReleaseArchive();
    const control = await createControlServer(layout.controlEndpoint, async (request) => {
      if (request.command === "prepare-update") return { status: "ready", runningTaskCount: 0 };
      throw new Error(`unexpected command: ${request.command}`);
    });
    cleanup.push(control.close);
    const applyUpdate = vi.fn(async () => 0);

    const run = () =>
      runLocalArchiveUpdateCommand(
        ["update", "--from-archive", archivePath, "--json"],
        createIo().io,
        true,
        layout,
        applyUpdate,
      );
    const results = await Promise.allSettled([run(), run()]);
    // 同一更新锁：一个成功，另一个要么成功（锁已释放）要么明确 busy；不能两个都写同一 pending。
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(String((result.reason as Error).message)).toMatch(/update is already in progress/u);
      }
    }
    const pending = await new ReleaseManager(layout).readPending();
    expect(pending?.appVersion).toBe("3.16.2");
    expect(await new ReleaseManager(layout).readCurrent()).toBeNull();
    expect(
      (await readdir(layout.releasesDir)).filter((name) => name.startsWith(".incoming-")),
    ).toEqual([]);
  });
});
