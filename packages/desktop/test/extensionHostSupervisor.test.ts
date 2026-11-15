import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildExtensionProcessEnv,
  createExtensionHostSupervisor,
} from "../src/main/extensionHost/supervisor.js";

function input(dir: string, pluginId = "p1") {
  return {
    generation: 1,
    workspaceIdentity: "local:/tmp/ws",
    endpoint: "http://127.0.0.1:1",
    token: "t".repeat(32),
    pluginDir: dir,
    pluginId,
  };
}

describe("extension process environment", () => {
  it("only forwards the explicit allowlist and this plugin's protocol variables", () => {
    process.env.ZCODE_TEST_SECRET = "do-not-leak";
    try {
      const env = buildExtensionProcessEnv(input("/tmp/one", "demo"));
      expect(env.ZCODE_TEST_SECRET).toBeUndefined();
      expect(env.HOME).toBeUndefined();
      expect(env.ZCODE_EXTENSION_HOST_GENERATION).toBe("1");
      expect(env.ZCODE_EXTENSION_HOST_WORKSPACE_IDENTITY).toBe("local:/tmp/ws");
      expect(env.ZCODE_EXTENSION_HOST_PLUGIN_ID).toBe("demo");
      expect(env.ZCODE_EXTENSION_HOST_PLUGIN_DIR).toBe("/tmp/one");
      expect(env.ZCODE_EXTENSION_HOST_TOKEN).toBeUndefined();
      expect(Object.keys(env)).not.toContain("ZCODE_EXTENSION_HOST_TOKEN");
      expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
    } finally {
      delete process.env.ZCODE_TEST_SECRET;
    }
  });
});

describe("extension host supervisor lifecycle", () => {
  it("restarts a crashed process within budget and stops after exhaustion", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-ext-supervisor-"));
    const worker = join(dir, "crash.mjs");
    await writeFile(
      worker,
      `process.stdout.write(JSON.stringify({ type: "ready", generation: 1, pluginId: "p1" }) + "\\n");
setTimeout(() => process.exit(3), 20);
`,
    );
    const supervisor = createExtensionHostSupervisor({
      workerPath: worker,
      maxRestarts: 1,
      restartWindowMs: 60_000,
      startupTimeoutMs: 5_000,
    });
    try {
      const { pid } = await supervisor.start(7, input(dir));
      expect(pid).toBeGreaterThan(0);
      await waitFor(() => supervisor.has(7) === false, 5_000);
      expect(supervisor.has(7)).toBe(false);
    } finally {
      await supervisor.disposeAll();
    }
  }, 20_000);

  it("stops only the matching generation and plugin", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-ext-supervisor-"));
    const worker = join(dir, "idle.mjs");
    await writeFile(
      worker,
      `const pluginId = process.env.ZCODE_EXTENSION_HOST_PLUGIN_ID;
process.stdout.write(JSON.stringify({ type: "ready", generation: 5, pluginId }) + "\\n");
process.stdin.on("data", (chunk) => {
  if (String(chunk).includes("shutdown")) process.exit(0);
});
setInterval(() => {}, 1000);
`,
    );
    const supervisor = createExtensionHostSupervisor({ workerPath: worker });
    try {
      await supervisor.start(9, { ...input(dir, "a"), generation: 5 });
      await supervisor.start(9, { ...input(dir, "b"), generation: 5 });
      expect(supervisor.hasPlugin(9, "a")).toBe(true);
      expect(supervisor.hasPlugin(9, "b")).toBe(true);
      // 窗口换代后的旧停止请求不能误停新进程。
      expect(await supervisor.stop(9, 4)).toBe(false);
      expect(supervisor.has(9)).toBe(true);
      // 按插件撤销只停止目标插件。
      expect(await supervisor.stopPlugin(9, 5, "a")).toBe(true);
      expect(supervisor.hasPlugin(9, "a")).toBe(false);
      expect(supervisor.hasPlugin(9, "b")).toBe(true);
      expect(await supervisor.stop(9, 5)).toBe(true);
      expect(supervisor.has(9)).toBe(false);
    } finally {
      await supervisor.disposeAll();
    }
  }, 20_000);

  it("serializes concurrent starts for the same plugin into one child", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-ext-supervisor-"));
    const marker = join(dir, "spawns.txt");
    const worker = join(dir, "slow.mjs");
    await writeFile(
      worker,
      `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(marker)}, "spawn\\n");
setTimeout(() => {
  process.stdout.write(JSON.stringify({ type: "ready", generation: 1, pluginId: "p1" }) + "\\n");
}, 80);
process.stdin.on("data", (chunk) => { if (String(chunk).includes("shutdown")) process.exit(0); });
setInterval(() => {}, 1000);
`,
    );
    const supervisor = createExtensionHostSupervisor({ workerPath: worker });
    try {
      const [first, second] = await Promise.all([
        supervisor.start(1, input(dir)),
        supervisor.start(1, input(dir)),
      ]);
      expect(first.pid).toBe(second.pid);
      const spawns = (await readFile(marker, "utf8")).trim().split("\n");
      expect(spawns).toHaveLength(1);
    } finally {
      await supervisor.disposeAll();
    }
  }, 20_000);

  it("cleans up a child that never reports ready when the plugin is stopped mid-start", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-ext-supervisor-"));
    const worker = join(dir, "hang.mjs");
    await writeFile(worker, `setInterval(() => {}, 1000);\n`);
    const supervisor = createExtensionHostSupervisor({
      workerPath: worker,
      shutdownTimeoutMs: 100,
    });
    try {
      const starting = supervisor.start(3, input(dir));
      await waitFor(() => supervisor.hasPlugin(3, "p1"), 2_000);
      expect(await supervisor.stopPlugin(3, 1, "p1")).toBe(true);
      await expect(starting).rejects.toThrow();
      expect(supervisor.hasPlugin(3, "p1")).toBe(false);
    } finally {
      await supervisor.disposeAll();
    }
  }, 20_000);

  it("delivers the credential only over the stdin bootstrap frame", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-ext-supervisor-"));
    const capture = join(dir, "capture.json");
    const worker = join(dir, "bootstrap.mjs");
    await writeFile(
      worker,
      `import { writeFileSync } from "node:fs";
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const index = buffer.indexOf("\\n");
  if (index < 0) return;
  const frame = JSON.parse(buffer.slice(0, index));
  writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ frame, env: process.env }));
  process.stdout.write(JSON.stringify({ type: "ready", generation: 1, pluginId: "p1" }) + "\\n");
});
setInterval(() => {}, 1000);
`,
    );
    const secret = "bootstrap-secret".repeat(3);
    const supervisor = createExtensionHostSupervisor({ workerPath: worker });
    try {
      await supervisor.start(8, { ...input(dir), token: secret });
      await waitFor(() => existsSync(capture), 5_000);
      const captured = JSON.parse(await readFile(capture, "utf8")) as {
        frame: { type: string; token: string };
        env: Record<string, string | undefined>;
      };
      expect(captured.frame).toEqual({ type: "bootstrap", token: secret });
      expect(captured.env.ZCODE_EXTENSION_HOST_TOKEN).toBeUndefined();
      expect(captured.env.ZCODE_EXTENSION_HOST_ENDPOINT).toBe("http://127.0.0.1:1");
    } finally {
      await supervisor.disposeAll();
    }
  }, 20_000);

  it("rejects a start when the child reports an activation error before ready", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-ext-supervisor-"));
    const worker = join(dir, "activate-fail.mjs");
    await writeFile(
      worker,
      `process.stdin.resume();
process.stdout.write(JSON.stringify({ type: "error", message: "activation failed" }) + "\\n");
setInterval(() => {}, 1000);
`,
    );
    const supervisor = createExtensionHostSupervisor({
      workerPath: worker,
      startupTimeoutMs: 5_000,
      shutdownTimeoutMs: 100,
    });
    try {
      await expect(supervisor.start(6, input(dir))).rejects.toThrow("activation failed");
      expect(supervisor.hasPlugin(6, "p1")).toBe(false);
    } finally {
      await supervisor.disposeAll();
    }
  }, 20_000);

  it("kills a child that ignores shutdown and SIGTERM within the bound", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-ext-supervisor-"));
    const worker = join(dir, "unresponsive.mjs");
    await writeFile(
      worker,
      `process.on("SIGTERM", () => {});
process.stdin.resume();
process.stdout.write(JSON.stringify({ type: "ready", generation: 1, pluginId: "p1" }) + "\\n");
setInterval(() => {}, 1000);
`,
    );
    const supervisor = createExtensionHostSupervisor({
      workerPath: worker,
      shutdownTimeoutMs: 100,
    });
    try {
      await supervisor.start(10, input(dir));
      const startedAt = Date.now();
      expect(await supervisor.stopPlugin(10, 1, "p1")).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(supervisor.hasPlugin(10, "p1")).toBe(false);
    } finally {
      await supervisor.disposeAll();
    }
  }, 20_000);

  it("does not leave a late child from a failed handshake", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-ext-supervisor-"));
    const worker = join(dir, "fail.mjs");
    await writeFile(worker, `process.stdout.write("not-json\\n"); process.exit(2);\n`);
    const supervisor = createExtensionHostSupervisor({
      workerPath: worker,
      startupTimeoutMs: 2_000,
    });
    try {
      await expect(supervisor.start(4, input(dir))).rejects.toThrow();
      expect(supervisor.hasPlugin(4, "p1")).toBe(false);
    } finally {
      await supervisor.disposeAll();
    }
  }, 20_000);

  it("ignores a ready frame that claims a different plugin", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-ext-supervisor-"));
    const worker = join(dir, "wrong.mjs");
    await writeFile(
      worker,
      `process.stdout.write(JSON.stringify({ type: "ready", generation: 1, pluginId: "other" }) + "\\n");
setInterval(() => {}, 1000);
`,
    );
    const supervisor = createExtensionHostSupervisor({
      workerPath: worker,
      startupTimeoutMs: 300,
    });
    try {
      await expect(supervisor.start(5, input(dir))).rejects.toThrow();
      expect(supervisor.hasPlugin(5, "p1")).toBe(false);
    } finally {
      await supervisor.disposeAll();
    }
  }, 20_000);
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
