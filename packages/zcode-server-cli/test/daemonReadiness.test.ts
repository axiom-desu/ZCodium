import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runServerCli } from "../src/cli.js";
import { createStoppedServerStatus, type ServerStatus } from "../src/contracts.js";
import { createControlServer } from "../src/ipc/controlServer.js";
import { resolveCanonicalServerLayout } from "../src/runtime/paths.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
  vi.unstubAllEnvs();
});

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function fixture() {
  vi.stubEnv("ZCODE_SERVER_SKIP_SERVICE_REGISTRATION", "1");
  const root = await mkdtemp(join(tmpdir(), "zcode-daemon-readiness-"));
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
  let status: ServerStatus = {
    ...createStoppedServerStatus("3.16.2"),
    state: "starting",
    pid: process.pid,
  };
  const secondRequest = barrier();
  const transition = barrier();
  let calls = 0;
  const commands: string[] = [];
  const server = await createControlServer(layout.controlEndpoint, async (request) => {
    commands.push(request.command);
    calls += 1;
    if (calls === 2) {
      secondRequest.release();
      await transition.promise;
    }
    return status;
  });
  cleanups.push(server.close);
  cleanups.push(async () => {
    transition.release();
  });
  const output: string[] = [];
  return {
    secondRequest,
    transition,
    commands,
    output,
    waitUntilPolling: (pending: Promise<number>) =>
      Promise.race([
        secondRequest.promise,
        pending.then(() => {
          throw new Error("CLI returned before readiness barrier");
        }),
      ]),
    setStatus: (patch: Partial<ServerStatus>) => {
      status = { ...status, ...patch };
    },
    run: (options: Parameters<typeof runServerCli>[2] = {}) =>
      runServerCli(
        ["serve", "--daemon", "--json", "--server-root", root],
        {
          stdout: {
            write: (text) => {
              output.push(text);
            },
          },
        },
        options,
      ),
  };
}

describe("existing daemon readiness through real control socket", () => {
  it("does not return starting/port:null and waits for the owner ready barrier", async () => {
    const f = await fixture();
    const pending = f.run();
    await f.waitUntilPolling(pending);
    expect(f.output).toEqual([]);
    f.setStatus({ state: "ready", host: "127.0.0.1", port: 32123 });
    f.transition.release();
    expect(await pending).toBe(0);
    expect(JSON.parse(f.output.join(""))).toMatchObject({ state: "ready", port: 32123 });
    expect(f.commands.every((command) => command === "status")).toBe(true);
  });

  it("reuses a registered service without registering another service", async () => {
    const f = await fixture();
    vi.stubEnv("ZCODE_SERVER_SKIP_SERVICE_REGISTRATION", "0");
    f.setStatus({ serviceRegistered: true });
    const pending = f.run();
    await f.waitUntilPolling(pending);
    f.setStatus({ state: "ready", host: "127.0.0.1", port: 32123 });
    f.transition.release();
    expect(await pending).toBe(0);
    expect(f.commands.every((command) => command === "status")).toBe(true);
  });

  it.each(["crashed", "crash-loop-stopped", "stopped", "stop-failed"] as const)(
    "fails on %s without returning a successful starting status",
    async (state) => {
      const f = await fixture();
      const pending = f.run();
      await f.waitUntilPolling(pending);
      f.setStatus({ state, lastExitReason: "fixture startup failure" });
      f.transition.release();
      expect(await pending).toBe(1);
      expect(JSON.parse(f.output.join(""))).toMatchObject({
        ok: false,
        error: expect.stringContaining(state),
      });
    },
  );

  it("times out a starting owner without mutating it", async () => {
    const f = await fixture();
    const pending = f.run({ daemonReadiness: { timeoutMs: 150 } });
    await f.waitUntilPolling(pending);
    f.transition.release();
    expect(await pending).toBe(1);
    expect(JSON.parse(f.output.join(""))).toMatchObject({
      ok: false,
      error: expect.stringContaining("Timed out"),
    });
    expect(f.commands.every((command) => command === "status")).toBe(true);
  });

  it("bounds a blocked control read by the readiness deadline", async () => {
    const f = await fixture();
    const pending = f.run({ daemonReadiness: { timeoutMs: 150 } });
    await f.waitUntilPolling(pending);
    expect(await pending).toBe(1);
    expect(JSON.parse(f.output.join(""))).toMatchObject({
      ok: false,
      error: expect.stringContaining("timed out"),
    });
    expect(f.commands.every((command) => command === "status")).toBe(true);
  });

  it("does not probe or spawn when already cancelled", async () => {
    const f = await fixture();
    expect(
      await f.run({
        daemonReadiness: { signal: AbortSignal.abort(new Error("fixture cancelled")) },
      }),
    ).toBe(1);
    expect(f.commands).toEqual([]);
  });

  it("cancels a blocked control read without stopping the shared owner", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const pending = f.run({ daemonReadiness: { signal: controller.signal } });
    await f.waitUntilPolling(pending);
    controller.abort(new Error("fixture cancelled"));
    expect(await pending).toBe(1);
    expect(JSON.parse(f.output.join(""))).toMatchObject({ ok: false, error: "fixture cancelled" });
    expect(f.commands.every((command) => command === "status")).toBe(true);
  });

  it("rejects a ready snapshot without an ingress port", async () => {
    const f = await fixture();
    f.setStatus({ state: "ready" });
    expect(await f.run()).toBe(1);
    expect(JSON.parse(f.output.join(""))).toMatchObject({ ok: false });
  });

  it("allows Core pid/generation to advance while the same control owner becomes ready", async () => {
    const f = await fixture();
    f.setStatus({ pid: null, generation: 1 });
    const pending = f.run();
    await f.waitUntilPolling(pending);
    f.setStatus({
      state: "ready",
      pid: process.pid + 1,
      generation: 2,
      host: "127.0.0.1",
      port: 32123,
    });
    f.transition.release();
    expect(await pending).toBe(0);
    expect(JSON.parse(f.output.join(""))).toMatchObject({
      state: "ready",
      generation: 2,
      port: 32123,
    });
  });
});
