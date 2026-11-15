import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createExtensionsService } from "@zcode/services/node";
import { createExtensionHostSupervisor } from "../src/main/extensionHost/supervisor.js";

/**
 * E6 安全链路：两个已同意插件各自独立进程/凭据，A 不能声称 B；未同意插件不激活；
 * 撤销只停目标插件；start/stop 并发、挂起 close 与 workspace 变化都清理旧状态。
 * 只用临时 HOME/工作区与 127.0.0.1。
 */
const WORKSPACE = "ext-security-ws";
const OWNER = 42;

describe("extension host identity and lifecycle security", () => {
  let root = "";
  let pluginDir = "";
  let previousHome: string | undefined;
  let previousXdg: string | undefined;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "zcode-ext-security-"));
    pluginDir = join(root, "extensions");
    previousHome = process.env.HOME;
    previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.HOME = join(root, "home");
    process.env.XDG_CONFIG_HOME = join(root, "xdg-config");
    await mkdir(join(root, "home"), { recursive: true });
    await mkdir(join(root, "workspace", WORKSPACE), { recursive: true });
    for (const id of ["alpha", "beta", "gamma"]) await writePlugin(pluginDir, id);
    await writeZeroGrantPlugin(pluginDir, "delta");
  });

  afterAll(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
  });

  it("binds credentials per plugin and cleans lifecycle races", async () => {
    const workspacePath = join(root, "workspace", WORKSPACE);
    let workspaceIdentity = `local:${workspacePath}`;
    const seen: Array<{ token: string; pluginId: string; endpoint: string; pid: number }> = [];
    const logs: string[] = [];
    const supervisor = createExtensionHostSupervisor({
      workerPath: new URL("../src/main/extensionHost/worker.ts", import.meta.url).pathname,
      spawnArgs: [
        "--import",
        "tsx",
        new URL("../src/main/extensionHost/worker.ts", import.meta.url).pathname,
      ],
      startupTimeoutMs: 15_000,
      shutdownTimeoutMs: 500,
      logger: { info: (message) => logs.push(message), warn: (message) => logs.push(message) },
    });
    const service = createExtensionsService({
      grantsFilePath: join(root, "extensions", "grants.json"),
      pluginDir,
      workspaceIdentity: () => workspaceIdentity,
      processSupervisor: {
        async start(input) {
          const started = await supervisor.start(OWNER, input);
          seen.push({
            token: input.token,
            pluginId: input.pluginId,
            endpoint: input.endpoint,
            pid: started.pid,
          });
          return started;
        },
        stop: (generation) => supervisor.stop(OWNER, generation).then(() => undefined),
        stopPlugin: (generation, pluginId) =>
          supervisor.stopPlugin(OWNER, generation, pluginId).then(() => undefined),
      },
      readSettings: async () => ({ locale: "en-US" }),
      readProjects: async () => [{ id: "p1", name: WORKSPACE }],
    });

    try {
      // 只有 alpha/beta 有用户同意记录；gamma 只被发现，不激活。
      await service.grant({ pluginId: "alpha", grants: ["projects.read"] });
      await service.grant({ pluginId: "beta", grants: ["projects.read"] });
      const started = await service.start();
      expect(started.phase, started.error ?? "").toBe("ready");
      expect(seen.map((item) => item.pluginId).sort()).toEqual(["alpha", "beta"]);
      expect(supervisor.hasPlugin(OWNER, "gamma")).toBe(false);
      await expect(readFile(join(pluginDir, "gamma", "result.json"), "utf8")).rejects.toThrow();

      const alpha = await waitForResult(join(pluginDir, "alpha", "result.json"));
      const beta = await waitForResult(join(pluginDir, "beta", "result.json"));
      const alphaSeen = seen.find((item) => item.pluginId === "alpha")!;
      const betaSeen = seen.find((item) => item.pluginId === "beta")!;
      expect(alphaSeen.token.length).toBeGreaterThan(0);
      expect(alphaSeen.token).not.toBe(betaSeen.token);
      // 凭据不再出现在子进程环境里；插件看不到自己的 token，更看不到 peer token。
      expect(alpha.envToken).toBeNull();
      expect(beta.envToken).toBeNull();
      expect(logs.join("\n")).not.toContain(alphaSeen.token);
      expect(logs.join("\n")).not.toContain(betaSeen.token);
      // 同 UID 仍能读 /proc，但环境里已经没有任何长效 token。
      if (process.platform === "linux") {
        for (const item of [alphaSeen, betaSeen]) {
          const environ = await readFile(`/proc/${item.pid}/environ`, "utf8").catch(() => "");
          expect(environ).not.toContain(item.token);
        }
      }
      expect(started.slots.map((slot) => slot.pluginId).sort()).toEqual(["alpha", "beta"]);

      const body = (pluginId: string) => ({
        v: 1,
        generation: started.generation,
        workspaceIdentity,
        pluginId,
        capabilityId: "settings.get",
      });
      // A 的合法凭据 + body 声称 B：网关按认证身份拒绝，不查 B 的授权。
      const spoof = await call(alphaSeen.endpoint, alphaSeen.token, body("beta"));
      expect(spoof).toMatchObject({ ok: false, code: "unauthorized" });
      const reverse = await call(betaSeen.endpoint, betaSeen.token, body("alpha"));
      expect(reverse).toMatchObject({ ok: false, code: "unauthorized" });
      expect(await call(alphaSeen.endpoint, alphaSeen.token, body("alpha"))).toMatchObject({
        ok: true,
      });
      expect(
        await call(alphaSeen.endpoint, alphaSeen.token, {
          ...body("alpha"),
          capabilityId: "context.get",
        }),
      ).toMatchObject({ ok: true, result: { workspaceIdentity } });

      // 撤销 alpha 只停 alpha；beta 的槽位与进程仍在。
      const revoked = await service.revoke("alpha");
      expect(revoked.slots.map((slot) => slot.pluginId)).toEqual(["beta"]);
      expect(supervisor.hasPlugin(OWNER, "alpha")).toBe(false);
      expect(supervisor.hasPlugin(OWNER, "beta")).toBe(true);
      const stale = await fetch(`${alphaSeen.endpoint}/capability`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${alphaSeen.token}` },
        body: JSON.stringify(body("alpha")),
      });
      expect(stale.status).toBe(401);

      // 挂起连接不能阻止 close：发一个不完整的 body，然后 stop。
      const hanging = await openHangingRequest(betaSeen.endpoint, betaSeen.token);
      const stoppedAt = Date.now();
      await service.stop();
      expect(Date.now() - stoppedAt).toBeLessThan(3_000);
      await waitFor(() => hanging.closed(), 2_000);
      expect(hanging.closed()).toBe(true);
      expect(supervisor.has(OWNER)).toBe(false);

      // start 与 stop 并发：最终必须是 stopped，且没有遗留进程。
      await Promise.allSettled([service.start(), service.stop()]);
      const raced = await service.getSnapshot();
      expect(raced.phase).toBe("stopped");
      expect(raced.generation).toBe(0);
      expect(supervisor.has(OWNER)).toBe(false);

      // workspace 变化清空旧槽位与旧代际；旧进程被停止。
      const restarted = await service.start();
      expect(restarted.phase, restarted.error ?? "").toBe("ready");
      expect(restarted.slots.length).toBeGreaterThan(0);
      workspaceIdentity = `local:${join(root, "workspace", "other")}`;
      const changed = await service.getSnapshot();
      expect(changed.phase).toBe("stopped");
      expect(changed.generation).toBe(0);
      expect(changed.slots).toEqual([]);
      await waitFor(() => supervisor.has(OWNER) === false, 3_000);
    } finally {
      await service.dispose().catch(() => {});
      await supervisor.disposeAll();
    }
  }, 90_000);

  it("does not activate a zero-grant plugin until the user consents to running it", async () => {
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
    const service = createExtensionsService({
      grantsFilePath: join(root, "extensions", "grants.json"),
      pluginDir,
      workspaceIdentity: () => workspaceIdentity,
      processSupervisor: {
        start: (input) => supervisor.start(OWNER, input),
        stop: (generation) => supervisor.stop(OWNER, generation).then(() => undefined),
        stopPlugin: (generation, pluginId) =>
          supervisor.stopPlugin(OWNER, generation, pluginId).then(() => undefined),
      },
      readSettings: async () => ({ locale: "en-US" }),
      readProjects: async () => [{ id: "p1", name: WORKSPACE }],
    });
    const deltaResult = join(pluginDir, "delta", "result.json");
    try {
      // 零档位插件同样没有同意记录：只被发现，不加载 main、不 spawn。
      const discovered = await service.getSnapshot();
      const delta = discovered.plugins.find((plugin) => plugin.pluginId === "delta");
      expect(delta?.status).toBe("needs-consent");
      expect(delta?.declared).toEqual([]);
      expect(supervisor.hasPlugin(OWNER, "delta")).toBe(false);
      await expect(readFile(deltaResult, "utf8")).rejects.toThrow();

      // 空档位 grant 是明确的运行同意。
      await service.grant({ pluginId: "delta", grants: [] });
      const started = await service.start();
      expect(started.phase, started.error ?? "").toBe("ready");
      expect(supervisor.hasPlugin(OWNER, "delta")).toBe(true);
      const result = await waitForResult(deltaResult);
      expect(result.envToken).toBeNull();
    } finally {
      await service.dispose().catch(() => {});
      await supervisor.disposeAll();
    }
  }, 60_000);
});

async function writePlugin(pluginDir: string, id: string): Promise<void> {
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
      capabilities: ["settings.get", "projects.list", "context.get"],
      grants: ["projects.read"],
      protocols: { projects: 1 },
      slots: [{ id: `status-${id}`, slot: "status.composer", title: id }],
    }),
  );
  await writeFile(
    join(dir, "extension.mjs"),
    `import { writeFile } from "node:fs/promises";
export async function activate(ctx) {
  const record = { envToken: process.env.ZCODE_EXTENSION_HOST_TOKEN ?? null };
  record.settings = await ctx.settings.get();
  record.projects = await ctx.projects.list();
  await ctx.slots.contribute([{ id: "status-${id}", slot: "status.composer", title: "${id}" }]);
  await writeFile(new URL("./result.json", import.meta.url), JSON.stringify(record));
  return () => {};
}
`,
  );
}

async function writeZeroGrantPlugin(pluginDir: string, id: string): Promise<void> {
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
    `import { writeFile } from "node:fs/promises";
export async function activate() {
  await writeFile(new URL("./result.json", import.meta.url), JSON.stringify({
    envToken: process.env.ZCODE_EXTENSION_HOST_TOKEN ?? null,
  }));
}
`,
  );
}

async function call(
  endpoint: string,
  token: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${endpoint}/capability`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Record<string, unknown>;
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

function openHangingRequest(endpoint: string, token: string): Promise<{ closed(): boolean }> {
  const url = new URL(endpoint);
  return new Promise((resolve, reject) => {
    let closed = false;
    const socket = connect(Number(url.port), url.hostname, () => {
      socket.write(
        "POST /capability HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer " +
          token +
          "\r\nContent-Type: application/json\r\nContent-Length: 100000\r\n\r\n{",
      );
      // 消费服务端 FIN，确保 close/end 事件会被处理；否则 paused socket 不会推进。
      socket.resume();
      socket.on("close", () => {
        closed = true;
        socket.destroy();
      });
      socket.on("end", () => {
        closed = true;
      });
      resolve({ closed: () => closed || socket.destroyed || socket.readableEnded });
    });
    socket.on("error", reject);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
