import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { Emitter } from "@zcode/rpc";
import type { IRemoteBackend, StdioStream } from "@zcode/server/remote/backend.js";
import type { RemoteTarget } from "@zcode/shared";
import { createCompatibilityManifest } from "@zcode/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  SourceServerInstallRequiredError,
  SourceServerUpgradeRequiredError,
  assertSourceServerHandshakeCompatible,
  connectSourceServerTransport,
} from "./connectSourceServer.js";
import { collectCommand, duplexFromStdio } from "./sourceServerTransportRuntime.js";
import { createSourceServerTransportAdapter, type ServerReleaseAsset } from "./transportAdapter.js";

interface FakeExecResult {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  echo?: boolean;
}

interface FakeBackendOptions {
  probe?: { installed: boolean; version?: string; statusReady?: boolean };
  installResult?: FakeExecResult;
  daemonStatus?: Record<string, unknown>;
  ingressToken?: string;
}

function createStdioStream(result: FakeExecResult): StdioStream {
  const onClose = new Emitter<number>();
  if (result.echo) {
    // proxy-stdio：stdout 只回显 stdin 字节，用于验证 Duplex 字节透明。
    const echo = new PassThrough();
    const stderr = new PassThrough();
    stderr.end();
    // 真实 proxy-stdio 在远端关闭前一直存活；这里只在 dispose 时不额外发 close。
    return { stdin: echo, stdout: echo, stderr, onClose: onClose.event };
  }
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  stdout.end(result.stdout ?? "");
  stderr.end(result.stderr ?? "");
  stdin.end();
  // 必须晚于调用方订阅：真实 backend 的 close 事件也在 stdio 建立之后才可能触发。
  setTimeout(() => onClose.fire(result.exitCode ?? 0), 0);
  return { stdin, stdout, stderr, onClose: onClose.event };
}

function probeOutput(options?: FakeBackendOptions["probe"] & { ready?: boolean }): string {
  const installed = options?.installed === true;
  const ready = options?.statusReady !== false;
  const status = ready
    ? JSON.stringify({ state: "ready", port: 4319, pid: 99, serviceRegistered: false })
    : "";
  return [
    "__ZCODE_PROBE_PLATFORM__",
    "Linux",
    "__ZCODE_PROBE_ARCH__",
    "x86_64",
    "__ZCODE_PROBE_ROOT__",
    "/home/dev/.zcodium-exp/server",
    "__ZCODE_PROBE_KERNEL__",
    "Linux",
    "__ZCODE_PROBE_LIBC__",
    "glibc 2.35",
    "__ZCODE_PROBE_INSTALLED__",
    installed ? "1" : "0",
    "__ZCODE_PROBE_VERSION__",
    installed ? (options?.version ?? "3.16.2") : "",
    "__ZCODE_PROBE_STATUS__",
    status,
    "__ZCODE_PROBE_END__",
    "",
  ].join("\n");
}

class FakeBackend implements IRemoteBackend {
  public readonly execCommands: string[] = [];
  public readonly uploads: Array<{ localPath: string; remotePath: string }> = [];
  public disposed = false;
  public readonly files = new Map<string, string>();

  public constructor(private readonly options: FakeBackendOptions = {}) {}

  public detect(): Promise<{ platform: string; arch: string }> {
    return Promise.resolve({ platform: "linux", arch: "x64" });
  }

  public upload(localPath: string, remotePath: string): Promise<void> {
    this.uploads.push({ localPath, remotePath });
    return Promise.resolve();
  }

  public async exec(command: string): Promise<StdioStream> {
    this.execCommands.push(command);
    if (command.includes("__ZCODE_PROBE_")) {
      return createStdioStream({ stdout: probeOutput(this.options.probe) });
    }
    if (command.includes("command -v tar")) {
      return createStdioStream({ stdout: "tar=tar\nsha256=sha256sum\n" });
    }
    if (command.includes("update --from-archive")) {
      return createStdioStream(
        this.options.installResult ?? {
          stdout: `${JSON.stringify({ phase: "extract" })}\n${JSON.stringify({ ok: true, applied: true })}\n`,
        },
      );
    }
    if (command.includes("serve") && command.includes("--daemon")) {
      return createStdioStream({
        stdout: `${JSON.stringify(
          this.options.daemonStatus ?? {
            state: "ready",
            port: 4319,
            pid: 100,
            serviceRegistered: false,
          },
        )}\n`,
      });
    }
    if (command.includes("proxy-stdio")) {
      return createStdioStream({ echo: true });
    }
    return createStdioStream({ stdout: "" });
  }

  public exists(remotePath: string): Promise<boolean> {
    return Promise.resolve(this.files.has(remotePath));
  }

  public readFile(remotePath: string): Promise<string> {
    const value = this.files.get(remotePath);
    if (value === undefined) return Promise.reject(new Error(`missing ${remotePath}`));
    return Promise.resolve(value);
  }

  public dispose(): void {
    this.disposed = true;
  }
}

const target: RemoteTarget = {
  kind: "docker",
  container: "fake-source",
};

const release: ServerReleaseAsset = {
  localArchivePath: "/tmp/source-server-linux-x64.tar.gz",
  target: "linux-x64",
  version: "3.16.2",
  sha256: "a".repeat(64),
  sizeBytes: 1024,
  urls: [],
};

const compatibilityManifest = createCompatibilityManifest("3.16.2", "3.15.1");

function createAdapter(backend: FakeBackend, calls: RemoteTarget[] = []) {
  return createSourceServerTransportAdapter("docker", {
    createBackend: async (createTarget) => {
      calls.push(createTarget);
      return backend;
    },
    rootReadPath: "~/server",
  });
}

afterEach(() => undefined);

describe("Source Server transport adapter", () => {
  it("probes once, and refuses an unconfirmed install without any upload or install command", async () => {
    const backend = new FakeBackend({ probe: { installed: false } });
    const adapter = createAdapter(backend);

    const error = await connectSourceServerTransport({
      adapter,
      target,
      compatibilityManifest,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SourceServerInstallRequiredError);
    expect((error as SourceServerInstallRequiredError).code).toBe("source-server-install-required");
    expect(backend.execCommands).toHaveLength(1);
    expect(backend.execCommands[0]).toContain("__ZCODE_PROBE_");
    expect(backend.uploads).toHaveLength(0);
  });

  it("returns typed upgrade-required for an installed but too old Source", async () => {
    const backend = new FakeBackend({ probe: { installed: true, version: "3.14.0" } });
    const adapter = createAdapter(backend);

    const error = await connectSourceServerTransport({
      adapter,
      target,
      compatibilityManifest,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SourceServerUpgradeRequiredError);
    expect((error as SourceServerUpgradeRequiredError).upgradeTarget).toBe("server");
    expect(backend.uploads).toHaveLength(0);
  });

  it("installs a confirmed release through upload + CLI update and starts the daemon", async () => {
    const backend = new FakeBackend({ probe: { installed: false } });
    backend.files.set("~/server/run/ingress-token", "token-1\n");
    const adapter = createAdapter(backend, []);

    const prepared = await connectSourceServerTransport({
      adapter,
      target,
      compatibilityManifest,
      confirmSourceServerInstall: true,
      release,
    });

    expect(backend.uploads).toEqual([
      { localPath: release.localArchivePath!, remotePath: expect.stringContaining(".tar.gz") },
    ]);
    const installCommand = backend.execCommands.find((command) =>
      command.includes("update --from-archive"),
    );
    expect(installCommand).toContain("--server-root");
    expect(installCommand).not.toContain("--force");
    expect(installCommand).toContain("ZCODE_SERVER_SKIP_SERVICE_REGISTRATION=1");
    const daemonCommand = backend.execCommands.find((command) => command.includes("serve"));
    expect(daemonCommand).toBeDefined();
    expect(prepared.ingress).toEqual({ port: 4319, ingressToken: "token-1" });
  });

  it("keeps --force scoped to the busy guard only", async () => {
    const backend = new FakeBackend({ probe: { installed: false } });
    backend.files.set("~/server/run/ingress-token", "token-2");
    const adapter = createAdapter(backend);

    await connectSourceServerTransport({
      adapter,
      target,
      compatibilityManifest,
      confirmSourceServerInstall: true,
      release,
      forceUpdate: true,
    });

    const installCommand = backend.execCommands.find((command) =>
      command.includes("update --from-archive"),
    );
    expect(installCommand).toContain("--force");
    // 校验仍走 archive/target/哈希，force 不能跳过安装制品校验。
    expect(installCommand).toContain("update --from-archive");
  });

  it("surfaces typed CLI failures from the archive update", async () => {
    const backend = new FakeBackend({
      probe: { installed: false },
      installResult: {
        exitCode: 1,
        stdout: `${JSON.stringify({
          ok: false,
          code: "source-server-update-running-tasks",
          error: "3 running tasks",
        })}\n`,
      },
    });
    const adapter = createAdapter(backend);

    const error = await connectSourceServerTransport({
      adapter,
      target,
      compatibilityManifest,
      confirmSourceServerInstall: true,
      release,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "source-server-update-running-tasks",
      message: "3 running tasks",
    });
  });

  it("reuses one backend per target across probe, daemon and channel", async () => {
    const backend = new FakeBackend({ probe: { installed: true } });
    backend.files.set("~/server/run/ingress-token", "token-3");
    const created: RemoteTarget[] = [];
    const adapter = createAdapter(backend, created);

    const prepared = await connectSourceServerTransport({
      adapter,
      target,
      compatibilityManifest,
    });
    const duplex = await prepared.openDuplex();
    const echoed = new Promise<Buffer>((resolve) => duplex.once("data", resolve));
    duplex.write(Buffer.from([0, 1, 2, 255]));
    expect(await echoed).toEqual(Buffer.from([0, 1, 2, 255]));
    await expect(prepared.openDuplex()).rejects.toThrow(/already opened/);
    duplex.destroy();

    expect(created).toHaveLength(1);
  });

  it("cancelling a target disposes its backend so a retry starts a new transport", async () => {
    const backend = new FakeBackend({ probe: { installed: true } });
    backend.files.set("~/server/run/ingress-token", "token-4");
    const created: RemoteTarget[] = [];
    const adapter = createSourceServerTransportAdapter("docker", {
      createBackend: async (createTarget) => {
        created.push(createTarget);
        return new FakeBackend({ probe: { installed: true } });
      },
      rootReadPath: "~/server",
    });

    await adapter.probe(target, {});
    adapter.cancel?.(target);
    expect(created).toHaveLength(1);
    await adapter.probe(target, {});
    expect(created).toHaveLength(2);
    adapter.dispose?.();
  });

  it("uses the observed ready status instead of starting a second daemon", async () => {
    const backend = new FakeBackend({ probe: { installed: true, statusReady: true } });
    backend.files.set("~/server/run/ingress-token", "token-5");
    const adapter = createAdapter(backend);

    await adapter.ensureDaemon(
      target,
      {},
      {
        observedStatus: { state: "ready", port: 4319 },
      },
    );

    expect(backend.execCommands.some((command) => command.includes("serve"))).toBe(false);
  });
});

describe("Source Server handshake compatibility", () => {
  it("rejects a Source without a compatibility manifest as requiring a server upgrade", () => {
    expect(() =>
      assertSourceServerHandshakeCompatible(compatibilityManifest, { version: "3.16.2" }),
    ).toThrow(SourceServerUpgradeRequiredError);
  });

  it("uses the strict shared predicate instead of weakening the minimum version", () => {
    expect(
      assertSourceServerHandshakeCompatible(compatibilityManifest, {
        version: "3.16.2",
        compatibility: {
          schemaVersion: 1,
          productVersion: "3.16.2",
          minCompatibleVersion: "3.15.1",
        },
      }).compatible,
    ).toBe(true);

    expect(() =>
      assertSourceServerHandshakeCompatible(compatibilityManifest, {
        version: "3.14.0",
        compatibility: {
          schemaVersion: 1,
          productVersion: "3.14.0",
          minCompatibleVersion: "3.14.0",
        },
      }),
    ).toThrow(SourceServerUpgradeRequiredError);
  });

  it("keeps the typed install gate when a confirmed install has no resolved release", async () => {
    const backend = new FakeBackend({ probe: { installed: false } });
    const adapter = createAdapter(backend);

    const error = await connectSourceServerTransport({
      adapter,
      target,
      compatibilityManifest,
      confirmSourceServerInstall: true,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SourceServerInstallRequiredError);
    expect(backend.uploads).toHaveLength(0);
    expect(backend.execCommands).toHaveLength(1);
  });
});

describe("Source Server transport runtime", () => {
  it("consumes large stderr while the command runs (no backpressure stall)", async () => {
    const stderrChunk = "x".repeat(256 * 1024);
    const stderrPipe = new PassThrough();
    const stdoutPipe = new PassThrough();
    const stream: StdioStream = {
      stdin: new PassThrough(),
      stdout: stdoutPipe,
      stderr: stderrPipe,
      onClose: (listener) => {
        setTimeout(() => listener(0), 5);
        return { dispose: () => undefined };
      },
    };
    const collected = collectCommand(stream);
    for (let index = 0; index < 8; index += 1) stderrPipe.write(stderrChunk);
    stderrPipe.end();
    stdoutPipe.end("done");
    const result = await collected;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("done");
    expect(result.stderr).toHaveLength(stderrChunk.length * 8);
  });

  it("drains 2 MB of real child stderr and still completes the proxy Duplex", async () => {
    // 真实子进程 + 真实管道：stderr 不被 duplexFromStdio 消费时，64 KiB 管道很快写满，
    // 子进程无法退出，stdout 也永远不会 end。不用短超时断言冒充“没有阻塞”。
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
        process.stdin.on("data", (chunk) => process.stdout.write(chunk));
        process.stdin.on("end", () => {
          const chunk = Buffer.alloc(64 * 1024, "x");
          let written = 0;
          const write = () => {
            while (written < 2_000_000) {
              written += chunk.length;
              if (!process.stderr.write(chunk)) {
                process.stderr.once("drain", write);
                return;
              }
            }
            process.stderr.end(() => process.exit(0));
          };
          write();
        });
        `,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
    const stream: StdioStream = {
      stdin: child.stdin!,
      stdout: child.stdout!,
      stderr: child.stderr!,
      onClose: (listener) => {
        const handler = (code: number | null) => listener(code ?? 0);
        child.once("close", handler);
        return { dispose: () => child.off("close", handler) };
      },
    };
    const duplex = duplexFromStdio(stream);
    const echoed: Buffer[] = [];
    duplex.on("data", (chunk) => echoed.push(Buffer.from(chunk)));
    duplex.write("protocol-bytes");
    // 只有 half-close stdin 后子进程才会写 stderr 并退出；readable 侧在此期间必须继续消费。
    duplex.end();
    await new Promise<void>((resolve, reject) => {
      duplex.once("end", resolve);
      duplex.once("error", reject);
      setTimeout(
        () => reject(new Error("proxy-stdio stalled while the child wrote 2 MB to stderr")),
        15_000,
      ).unref();
    });
    expect(Buffer.concat(echoed).toString("utf8")).toBe("protocol-bytes");
    // stdout 的 end 可能早于进程 close；等待真实 close code，确认 stderr 已被完整消费。
    expect(await closed).toBe(0);
    duplex.destroy();
  });
});
