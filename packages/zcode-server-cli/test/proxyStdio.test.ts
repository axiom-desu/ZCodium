import { createServer } from "node:net";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { runProxyStdio } from "../src/server-core/proxyStdio.js";
import { resolveServerLayout } from "../src/runtime/paths.js";

async function writeReadyStatus(serverRoot: string, port: number): Promise<void> {
  const layout = resolveServerLayout(serverRoot);
  await mkdir(layout.runDir, { recursive: true });
  await writeFile(
    layout.statusFile,
    JSON.stringify({
      protocolVersion: 1,
      state: "ready",
      pid: process.pid,
      port,
      host: "127.0.0.1",
      version: "3.16.2",
      generation: 1,
      startedAt: Date.now(),
      lastExitReason: null,
      serviceRegistered: false,
      runningTaskCount: 0,
      crashBudget: { crashCount: 0, nextRestartDelayMs: 1_000, exhausted: false },
      updatedAt: Date.now(),
    }),
  );
}

describe("server proxy-stdio", () => {
  it("forwards arbitrary bytes between stdio and the ready loopback daemon", async () => {
    const echo = createServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
    const address = echo.address();
    if (!address || typeof address === "string") throw new Error("missing echo port");
    const root = await mkdtemp(join(tmpdir(), "zcode-r3-proxy-stdio-"));
    const layout = resolveServerLayout(join(root, "server"));
    await writeReadyStatus(layout.serverRoot, address.port);
    const input = new PassThrough();
    const output = new PassThrough();
    const received: Buffer[] = [];
    output.on("data", (chunk) => received.push(Buffer.from(chunk)));
    const payload = Buffer.from([0, 1, 2, 13, 10, 127, 128, 254, 255]);

    const forwarding = runProxyStdio({ layout, input, output });
    input.end(payload);
    await forwarding;
    await new Promise<void>((resolve) => echo.close(() => resolve()));

    // stdout 必须是精确的远端字节，不能夹带 framing 或诊断。
    expect(Buffer.concat(received)).toEqual(payload);
  });

  it("fails before writing channel bytes when daemon status is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r3-proxy-stdio-missing-"));
    const layout = resolveServerLayout(join(root, "server"));
    const output = new PassThrough();
    const received: Buffer[] = [];
    output.on("data", (chunk) => received.push(Buffer.from(chunk)));
    await expect(runProxyStdio({ layout, input: new PassThrough(), output })).rejects.toMatchObject(
      { code: "daemon-not-ready" },
    );
    expect(received).toEqual([]);
  });

  it("classifies a ready status whose loopback port refuses connections", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r3-proxy-stdio-refused-"));
    const layout = resolveServerLayout(join(root, "server"));
    // 绑定后立即关闭，确保端口没有监听者（避免使用固定端口与并发测试冲突）。
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address();
    if (!address || typeof address === "string") throw new Error("missing probe port");
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    await writeReadyStatus(layout.serverRoot, address.port);
    await expect(
      runProxyStdio({ layout, input: new PassThrough(), output: new PassThrough() }),
    ).rejects.toMatchObject({ code: "daemon-connect-failed" });
  });
  it("releases the bridge when the remote half-closes while stdin stays open", async () => {
    const remote = createServer((socket) => {
      socket.end("remote-bye");
    });
    await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
    const address = remote.address();
    if (!address || typeof address === "string") throw new Error("missing remote port");
    const root = await mkdtemp(join(tmpdir(), "zcode-r3-proxy-half-close-"));
    const layout = resolveServerLayout(join(root, "server"));
    await writeReadyStatus(layout.serverRoot, address.port);
    const input = new PassThrough();
    const output = new PassThrough();
    const received: string[] = [];
    output.on("data", (chunk) => received.push(chunk.toString("utf8")));

    await runProxyStdio({ layout, input, output });
    await new Promise<void>((resolve) => remote.close(() => resolve()));

    expect(received.join("")).toBe("remote-bye");
    // stdin 未结束也不影响远端关闭后的释放；不能靠结束本地 stdin 才收敛。
    expect(input.writableEnded).toBe(false);
  });

  it("destroys the socket and rejects when stdin aborts", async () => {
    const remote = createServer(() => undefined);
    await new Promise<void>((resolve) => remote.listen(0, "127.0.0.1", resolve));
    const address = remote.address();
    if (!address || typeof address === "string") throw new Error("missing remote port");
    const root = await mkdtemp(join(tmpdir(), "zcode-r3-proxy-abort-"));
    const layout = resolveServerLayout(join(root, "server"));
    await writeReadyStatus(layout.serverRoot, address.port);
    const input = new PassThrough();
    const running = runProxyStdio({ layout, input, output: new PassThrough() });
    while (input.listenerCount("error") === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    input.destroy(new Error("aborted"));
    await expect(running).rejects.toThrow("aborted");
    await new Promise<void>((resolve) => remote.close(() => resolve()));
  });
});

describe("server CLI proxy-stdio dispatch", () => {
  it("bridges stdin/stdout without writing diagnostics on success", async () => {
    const { runServerCli } = await import("../src/cli.js");
    const echo = createServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
    const address = echo.address();
    if (!address || typeof address === "string") throw new Error("missing echo port");
    const root = await mkdtemp(join(tmpdir(), "zcode-r3-cli-proxy-"));
    const layout = resolveServerLayout(join(root, "server"));
    await writeReadyStatus(layout.serverRoot, address.port);
    const input = new PassThrough();
    const output = new PassThrough();
    const stdout: string[] = [];
    const stderr: string[] = [];
    output.on("data", (chunk) => stdout.push(chunk.toString("utf8")));
    const running = runServerCli(
      ["proxy-stdio", "--server-root", layout.serverRoot],
      {
        stdout: { write: (value: string) => stdout.push(value) },
        stderr: { write: (value: string) => stderr.push(value) },
      },
      { proxyStdioStreams: { input, output } },
    );
    input.end("rpc-bytes");
    // runServerCli 会 await 桥接完成；stdin 的结束由 pipe 传播为 half-close。
    const exitCode = await running;
    await new Promise<void>((resolve) => echo.close(() => resolve()));
    expect(exitCode).toBe(0);
    expect(stdout.join("")).toContain("rpc-bytes");
    expect(stderr).toEqual([]);
  });

  it("returns a structured daemon-not-ready error on stderr and keeps stdout clean", async () => {
    const { runServerCli } = await import("../src/cli.js");
    const root = await mkdtemp(join(tmpdir(), "zcode-r3-cli-proxy-missing-"));
    const layout = resolveServerLayout(join(root, "server"));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const exitCode = await runServerCli(
      ["proxy-stdio", "--server-root", layout.serverRoot],
      {
        stdout: { write: (value: string) => stdout.push(value) },
        stderr: { write: (value: string) => stderr.push(value) },
      },
      { proxyStdioStreams: { input: new PassThrough(), output: new PassThrough() } },
    );
    expect(exitCode).toBe(1);
    expect(stdout).toEqual([]);
    expect(JSON.parse(stderr.join(""))).toMatchObject({ ok: false, code: "daemon-not-ready" });
  });
});
