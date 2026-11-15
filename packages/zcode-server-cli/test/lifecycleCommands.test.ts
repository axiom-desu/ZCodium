import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runServerCli } from "../src/cli.js";
import { createStoppedServerStatus, type ServerStatus } from "../src/contracts.js";
import { createControlServer } from "../src/ipc/controlServer.js";
import { DataRootLock } from "../src/runtime/lock.js";
import { resolveCanonicalServerLayout } from "../src/runtime/paths.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
  vi.unstubAllEnvs();
});

async function fixture() {
  vi.stubEnv("ZCODE_SERVER_SKIP_SERVICE_REGISTRATION", "1");
  const root = await mkdtemp(join(tmpdir(), "zcode-lifecycle-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  for (const key of [
    "HOME",
    "USERPROFILE",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "APPDATA",
    "LOCALAPPDATA",
    "ZCODE_DATA_BASE_DIR",
  ])
    vi.stubEnv(key, root);
  const layout = await resolveCanonicalServerLayout(root);
  const output: string[] = [];
  return {
    root,
    layout,
    output,
    run: (argv: string[]) =>
      runServerCli(argv, {
        stdout: { write: (text) => output.push(text) },
      }),
  };
}

function status(patch: Partial<ServerStatus>): ServerStatus {
  return { ...createStoppedServerStatus("3.17.2"), ...patch };
}

describe("server CLI lifecycle commands", () => {
  it("stop --wait 在没有 daemon 时立即输出最终 stopped，而不是 ack", async () => {
    const { root, output, run } = await fixture();
    const code = await run(["stop", "--wait", "--json", "--server-root", root]);
    expect(code).toBe(0);
    expect(JSON.parse(output.join(""))).toMatchObject({ state: "stopped", pid: null });
  });

  it("running-tasks --json 原样返回可信任务数组，null 表示清单不可用", async () => {
    const { root, layout, output, run } = await fixture();
    const tasks = [
      { sessionId: "s-1", workspacePath: "/workspace/one", workspaceIdentity: "remote:one" },
    ];
    const server = await createControlServer(layout.controlEndpoint, async (request) =>
      request.command === "running-tasks" ? tasks : null,
    );
    cleanups.push(server.close);
    const code = await run(["running-tasks", "--json", "--server-root", root]);
    expect(code).toBe(0);
    expect(JSON.parse(output.join(""))).toEqual(tasks);
  });

  it("stop --wait 等到锁释放且出现比基线新的 stopped 快照", async () => {
    const { root, layout, output, run } = await fixture();
    const running = status({ state: "ready", pid: process.pid, updatedAt: 100 });
    await mkdir(layout.runDir, { recursive: true });
    await writeFile(layout.statusFile, JSON.stringify(running));
    const lock = new DataRootLock(layout.lockFile);
    await lock.acquire();
    cleanups.push(() => lock.release());
    let stopRequests = 0;
    const server = await createControlServer(layout.controlEndpoint, async (request) => {
      if (request.command !== "stop") return running;
      stopRequests += 1;
      // Supervisor 收口顺序：落盘 stopped → 关闭 control → 释放锁。
      await writeFile(
        layout.statusFile,
        JSON.stringify(status({ state: "stopped", updatedAt: 101 })),
      );
      await lock.release();
      return { stopping: true };
    });
    cleanups.push(server.close);
    const code = await run(["stop", "--wait", "--json", "--server-root", root]);
    expect(code).toBe(0);
    expect(stopRequests).toBe(1);
    expect(JSON.parse(output.join(""))).toMatchObject({ state: "stopped", updatedAt: 101 });
  });
});
