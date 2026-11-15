import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createExtensionsService } from "@zcode/services/node";
import { createExtensionHostSupervisor } from "../src/main/extensionHost/supervisor.js";

/**
 * 激活失败必须让 Host 进入 phase=error 并清理本代进程/loopback；不能假 ready。
 * 同时复验：零档位插件必须先有明确同意记录才激活；失败代际不影响随后启动的新实例。
 * 只用临时 HOME/XDG/工作区与 127.0.0.1，真实 child process + stdio。
 */
const WORKSPACE = "ext-activation-ws";
const OWNER = 77;

describe("extension host activation failure", () => {
  let root = "";
  let pluginDir = "";
  let previousHome: string | undefined;
  let previousXdg: string | undefined;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "zcode-ext-activation-"));
    pluginDir = join(root, "extensions");
    previousHome = process.env.HOME;
    previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.HOME = join(root, "home");
    process.env.XDG_CONFIG_HOME = join(root, "xdg-config");
    await mkdir(join(root, "home"), { recursive: true });
    await mkdir(join(root, "workspace", WORKSPACE), { recursive: true });
    await writePlugin(pluginDir, "broken", 'throw new Error("boom during activate");');
    await writePlugin(
      pluginDir,
      "good",
      `const { writeFile } = await import("node:fs/promises");
await writeFile(new URL("./result.json", import.meta.url), JSON.stringify({
  envToken: process.env.ZCODE_EXTENSION_HOST_TOKEN ?? null,
}));`,
    );
  });

  afterAll(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
  });

  it("reports phase error, cleans the generation, then starts a new instance", async () => {
    const workspacePath = join(root, "workspace", WORKSPACE);
    const workspaceIdentity = `local:${workspacePath}`;
    const supervisor = createExtensionHostSupervisor({
      workerPath: new URL("../src/main/extensionHost/worker.ts", import.meta.url).pathname,
      spawnArgs: [
        "--import",
        "tsx",
        new URL("../src/main/extensionHost/worker.ts", import.meta.url).pathname,
      ],
      startupTimeoutMs: 15_000,
      shutdownTimeoutMs: 500,
    });
    const endpoints: string[] = [];
    const service = createExtensionsService({
      grantsFilePath: join(root, "extensions", "grants.json"),
      pluginDir,
      workspaceIdentity: () => workspaceIdentity,
      processSupervisor: {
        start: (input) => {
          endpoints.push(input.endpoint);
          return supervisor.start(OWNER, input);
        },
        stop: (generation) => supervisor.stop(OWNER, generation).then(() => undefined),
        stopPlugin: (generation, pluginId) =>
          supervisor.stopPlugin(OWNER, generation, pluginId).then(() => undefined),
      },
      readSettings: async () => ({ locale: "en-US" }),
      readProjects: async () => [{ id: "p1", name: WORKSPACE }],
    });

    try {
      // 同意前只发现，不加载 main、不 spawn。
      const discovered = await service.getSnapshot();
      expect(discovered.plugins.map((plugin) => plugin.status)).toEqual([
        "needs-consent",
        "needs-consent",
      ]);
      expect(supervisor.has(OWNER)).toBe(false);

      // 激活抛错：start 不能成功，phase=error，本代进程与 loopback 都要清理。
      await service.grant({ pluginId: "broken", grants: [] });
      const failed = await service.start();
      expect(failed.phase).toBe("error");
      expect(failed.error).toContain("boom during activate");
      expect(supervisor.hasPlugin(OWNER, "broken")).toBe(false);
      expect(supervisor.has(OWNER)).toBe(false);
      expect(endpoints).toHaveLength(1);
      await expect(
        fetch(`${endpoints[0]}/capability`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer stale" },
          body: "{}",
        }),
      ).rejects.toThrow();
      await expect(readFile(join(pluginDir, "broken", "result.json"), "utf8")).rejects.toThrow();

      // 撤销失败插件后重新 start：新实例正常 ready，不受旧代际失败影响。
      await service.revoke("broken");
      await service.grant({ pluginId: "good", grants: [] });
      const ready = await service.start();
      expect(ready.phase, ready.error ?? "").toBe("ready");
      expect(ready.generation).toBe(2);
      expect(supervisor.hasPlugin(OWNER, "good")).toBe(true);
      expect(supervisor.hasPlugin(OWNER, "broken")).toBe(false);
      const result = await waitForResult(join(pluginDir, "good", "result.json"));
      expect(result.envToken).toBeNull();
    } finally {
      await service.dispose().catch(() => {});
      await supervisor.disposeAll();
    }
  }, 90_000);
});

async function writePlugin(pluginDir: string, id: string, activateBody: string): Promise<void> {
  const dir = join(pluginDir, id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "extension.json"),
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: `${id} extension`,
      version: "1.0.0",
      main: "extension.mjs",
      capabilities: [],
      grants: [],
    }),
  );
  await writeFile(
    join(dir, "extension.mjs"),
    `export async function activate() {\n${activateBody}\n}\n`,
  );
}

async function waitForResult(path: string): Promise<{ envToken?: string | null }> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const raw = await readFile(path, "utf8").catch(() => null);
    if (raw) return JSON.parse(raw) as { envToken?: string | null };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("extension did not publish its result in time");
}
