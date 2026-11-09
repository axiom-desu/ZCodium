import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setDataBaseDir } from "@zcode/services/node";
import { SSHHostKeyStore, type SSHHostKeyRejection } from "./sshKnownHosts.js";
import type { ConnectConfig } from "ssh2";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  commands: [] as Array<{ command: string; args: string[] }>,
  identity: "noise before identity\n__ZCODE_WSL_IDENTITY__\nubuntu\nfixture\n/home/fixture\n",
  daemonError: "",
  identityError: false,
}));

vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  function child() {
    return Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
      pid: undefined,
      exitCode: null,
      signalCode: null,
    });
  }
  return {
    spawn: vi.fn((command: string, args: string[]) => {
      fixture.commands.push({ command, args });
      const process = child();
      queueMicrotask(() => process.emit("spawn"));
      return process;
    }),
    execFile: vi.fn(
      (
        command: string,
        args: string[],
        options: { encoding: string },
        callback: (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void,
      ) => {
        fixture.commands.push({ command, args });
        const process = child();
        queueMicrotask(() => {
          const isVersion = args[0] === "version";
          const failure = isVersion
            ? fixture.daemonError
            : command === "wsl.exe" && fixture.identityError
              ? "fixture identity unavailable"
              : "";
          const output =
            command === "wsl.exe"
              ? fixture.identity
              : args[0] === "ps"
                ? JSON.stringify({ ID: "fixture-id", Names: "fixture", State: "running" })
                : isVersion
                  ? "1.0"
                  : "/home/fixture";
          callback(
            failure ? new Error(failure) : null,
            options.encoding === "buffer" ? Buffer.from(output) : output,
            options.encoding === "buffer" ? Buffer.from(failure) : failure,
          );
          process.emit("close", failure ? 1 : 0);
        });
        return process;
      },
    ),
  };
});

vi.mock("ssh2", async () => {
  const { EventEmitter } = await import("node:events");
  class Client extends EventEmitter {
    connect = vi.fn();
    end = vi.fn();
    exec = vi.fn();
  }
  return { Client };
});

vi.mock("./wsl-detect.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./wsl-detect.js")>()),
  isWSLAvailable: async () => true,
  listWSLDistros: async () => [{ name: "Ubuntu", isDefault: true, state: "Running", version: 2 }],
}));

import { spawn } from "node:child_process";
import { SSHBackend } from "./ssh-backend.js";
import { WSLBackend } from "./wsl-backend.js";
import { DockerBackend } from "./docker-backend.js";
import { isDockerAvailable, probeDockerDaemon } from "./docker-detect.js";

type TestClient = EventEmitter & {
  connect: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
};
type SSHInternals = {
  client: TestClient;
  ensureConnected(): Promise<void>;
  execSimple(command: string): Promise<string>;
  connected: boolean;
  hostKeyRejection: SSHHostKeyRejection | null;
};
let backends: Array<{ dispose(): void }>;
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "p2-backend-fixture-"));
  setDataBaseDir(directory);
  vi.stubEnv("HOME", directory);
  vi.stubEnv("USERPROFILE", directory);
  vi.stubEnv("XDG_CONFIG_HOME", join(directory, "config"));
  vi.stubEnv("XDG_DATA_HOME", join(directory, "data"));
  vi.stubEnv("SSH_AUTH_SOCK", "");
  backends = [];
  fixture.commands = [];
  fixture.identity =
    "noise before identity\n__ZCODE_WSL_IDENTITY__\nubuntu\nfixture\n/home/fixture\n";
  fixture.identityError = false;
  fixture.daemonError = "";
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  for (const backend of backends) backend.dispose();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setDataBaseDir(null);
  await rm(directory, { recursive: true, force: true });
});

function ssh() {
  const backend = new SSHBackend({
    host: "127.0.0.1",
    username: "fixture",
    password: "fixture-password",
  });
  backends.push(backend);
  const internals = backend as unknown as SSHInternals;
  return { backend, internals, client: internals.client };
}
function channel() {
  return Object.assign(new PassThrough(), { stdin: new PassThrough(), stderr: new PassThrough() });
}

describe("SSH backend 连接所有权", () => {
  it("dispose 立即拒绝所有在途 connect，不等待 ready/error/close", async () => {
    const { backend, internals, client } = ssh();
    const first = internals.ensureConnected();
    const second = internals.ensureConnected();
    const failures = Promise.all([
      expect(first).rejects.toThrow("已释放"),
      expect(second).rejects.toThrow("已释放"),
    ]);
    expect(client.connect).toHaveBeenCalledOnce();
    backend.dispose();
    await failures;
    expect(client.listenerCount("ready")).toBe(0);
    expect(client.listenerCount("error")).toBe(1);
    client.emit("ready");
    client.emit("error", new Error("late fixture error"));
    expect(internals.connected).toBe(false);
    await expect(internals.ensureConnected()).rejects.toThrow("已释放");
  });

  it("旧 close 不是新尝试的失败出口；connect 同步异常也摘掉监听", async () => {
    const { internals, client } = ssh();
    client.connect.mockImplementationOnce(() => {
      throw new Error("fixture sync connect failure");
    });
    await expect(internals.ensureConnected()).rejects.toThrow("fixture sync connect failure");
    expect(client.listenerCount("ready")).toBe(0);
    expect(client.listenerCount("error")).toBe(1);
    const pending = internals.ensureConnected();
    const successor = internals.client;
    expect(successor).not.toBe(client);
    client.emit("close");
    client.emit("ready");
    expect(internals.connected).toBe(false);
    successor.emit("ready");
    await pending;
    expect(internals.connected).toBe(true);
  });

  it.each(["end", "close"])("仅 %s 也立即拒绝所有 waiter，旧事件不污染后继", async (event) => {
    const { backend, internals, client } = ssh();
    const disconnect = vi.fn();
    backend.onDidDisconnect(disconnect);
    const first = internals.ensureConnected();
    const second = internals.ensureConnected();
    const failed = Promise.all([
      expect(first).rejects.toThrow("就绪"),
      expect(second).rejects.toThrow("就绪"),
    ]);
    client.emit(event);
    await failed;
    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.listenerCount("ready")).toBe(0);
    const retry = internals.ensureConnected();
    const successor = internals.client;
    expect(successor).not.toBe(client);
    expect(successor.connect).toHaveBeenCalledOnce();
    client.emit("ready");
    client.emit("error", new Error("late fixture error"));
    client.emit("end");
    client.emit("close");
    expect(internals.connected).toBe(false);
    expect(disconnect).not.toHaveBeenCalled();
    successor.emit("ready");
    await retry;
    client.emit("close");
    expect(internals.connected).toBe(true);
    expect(disconnect).not.toHaveBeenCalled();
    successor.emit("end");
    successor.emit("close");
    expect(disconnect).toHaveBeenCalledExactlyOnceWith({ reason: "end" });
  });

  it("已建立连接 end 后重连，旧 close/error 不得断开后继", async () => {
    const { backend, internals, client } = ssh();
    const disconnect = vi.fn();
    backend.onDidDisconnect(disconnect);
    const first = internals.ensureConnected();
    client.emit("ready");
    await first;
    client.emit("end");
    expect(disconnect).toHaveBeenCalledExactlyOnceWith({ reason: "end" });
    const retry = internals.ensureConnected();
    const successor = internals.client;
    client.emit("close");
    client.emit("error", new Error("late fixture error"));
    successor.emit("ready");
    await retry;
    client.emit("close");
    expect(internals.connected).toBe(true);
    expect(disconnect).toHaveBeenCalledOnce();
    successor.emit("close");
    expect(disconnect).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenLastCalledWith({ reason: "close" });
  });

  it("旧异步 TOFU 拒绝与额外验证提示不得污染后继", async () => {
    let rejectOldKey: () => void = () => {};
    vi.spyOn(SSHHostKeyStore.prototype, "verify").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          rejectOldKey = () =>
            resolve({ outcome: "reject", reason: "store-error", detail: "fixture" });
        }),
    );
    const { internals, client } = ssh();
    const first = internals.ensureConnected();
    const config = client.connect.mock.calls[0]?.[0] as ConnectConfig;
    const verify = vi.fn();
    (config.hostVerifier as (key: Buffer, verify: (valid: boolean) => void) => void)(
      Buffer.from("fixture"),
      verify,
    );
    const failed = expect(first).rejects.toThrow("fixture failure");
    client.emit("error", new Error("fixture failure"));
    await failed;
    const retry = internals.ensureConnected();
    const successor = internals.client;
    rejectOldKey();
    await vi.waitFor(() => expect(verify).toHaveBeenCalledExactlyOnceWith(false));
    expect(internals.hostKeyRejection).toBeNull();
    client.emit("keyboard-interactive", "", "", "", [{ prompt: "OTP", echo: false }], vi.fn());
    const retryFailed = expect(retry).rejects.toThrow("检查用户名、密码或私钥");
    successor.emit("error", { level: "client-authentication" });
    await retryFailed;
  });

  it("ready 后 timeout 按 keepalive 上报，且只上报一次", async () => {
    const { backend, internals, client } = ssh();
    const disconnect = vi.fn();
    backend.onDidDisconnect(disconnect);
    const ready = internals.ensureConnected();
    client.emit("ready");
    await ready;
    client.emit("error", Object.assign(new Error("fixture timeout"), { level: "client-timeout" }));
    client.emit("close");
    expect(disconnect).toHaveBeenCalledOnce();
    expect(disconnect.mock.calls[0]?.[0].error.message).toContain("心跳");
  });

  it.each(["error", "end", "close"])("%s 仍优先保留 TOFU 结构化拒绝原因", async (event) => {
    const { internals, client } = ssh();
    const pending = internals.ensureConnected();
    client.emit("keyboard-interactive", "", "", "", [{ prompt: "OTP", echo: false }], () => {});
    internals.hostKeyRejection = { hostKey: "fixture", reason: "changed", detail: "fixture" };
    const failed = expect(pending).rejects.toThrow("中间人");
    client.emit(event, { level: "client-authentication" });
    await failed;
  });

  it("额外验证证据每次 connect 重置，密码提示轮数不影响认证", async () => {
    const { internals, client } = ssh();
    const pending = internals.ensureConnected();
    const finish = vi.fn();
    client.emit("keyboard-interactive", "", "", "", [{ prompt: "OTP", echo: false }], finish);
    const failed = expect(pending).rejects.toMatchObject({
      message: expect.stringContaining("额外验证"),
      code: "remote-authentication-unsupported",
      retryable: false,
    });
    client.emit("error", { level: "client-authentication" });
    await failed;
    const retry = internals.ensureConnected();
    const successor = internals.client;
    const retryFailed = expect(retry).rejects.toThrow("检查用户名、密码或私钥");
    for (let round = 0; round < 3; round++) {
      successor.emit(
        "keyboard-interactive",
        "",
        "",
        "",
        [{ prompt: "Password:", echo: false }],
        finish,
      );
    }
    successor.emit("error", { level: "client-authentication" });
    await retryFailed;
  });
});

describe("SSH backend 退出状态", () => {
  it.each([
    [null, "SIGKILL", 137],
    [undefined, undefined, 255],
    [0, undefined, 0],
    [7, undefined, 7],
  ])("stream exit %s/%s 只通知一次", async (code, signal, expected) => {
    const { backend, internals, client } = ssh();
    const ready = internals.ensureConnected();
    client.emit("ready");
    await ready;
    const stream = channel();
    client.exec.mockImplementation(
      (_command: string, callback: (error: null, stream: unknown) => void) =>
        callback(null, stream),
    );
    const result = await backend.exec("fixture");
    const listener = vi.fn();
    result.onClose(listener);
    stream.emit("exit", code, signal);
    stream.emit("close");
    expect(listener).toHaveBeenCalledExactlyOnceWith(expected);
  });

  it("只有无状态 close 也不能成功；buffered exec 保留迟到输出及真实 exit", async () => {
    const { backend, internals, client } = ssh();
    const ready = internals.ensureConnected();
    client.emit("ready");
    await ready;
    let stream = channel();
    client.exec.mockImplementation(
      (_command: string, callback: (error: null, stream: unknown) => void) =>
        callback(null, stream),
    );
    const output = await backend.exec("fixture");
    stream.emit("close");
    const listener = vi.fn();
    output.onClose(listener);
    await Promise.resolve();
    expect(listener).toHaveBeenCalledExactlyOnceWith(255);
    stream = channel();
    const buffered = internals.execSimple("fixture");
    stream.emit("exit", 0);
    stream.emit("data", Buffer.from("late fixture stdout"));
    stream.emit("close");
    await expect(buffered).resolves.toBe("late fixture stdout");
    stream = channel();
    const killed = internals.execSimple("fixture");
    const failed = expect(killed).rejects.toThrow("code 137");
    stream.emit("exit", null, "SIGKILL");
    stream.emit("close", 0);
    await failed;
  });
});

describe("WSL backend 身份与流", () => {
  function wsl(user?: string) {
    const backend = new WSLBackend({ kind: "wsl", distro: "ubuntu", user });
    // Linux CI 只替换本机平台准入，不运行真实 WSL；身份命令/解析与 owned child 路径仍执行。
    vi.spyOn(
      backend as unknown as { ensureAvailable(): Promise<void> },
      "ensureAvailable",
    ).mockResolvedValue();
    backends.push(backend);
    return backend;
  }

  it("哨兵忽略前噪音，列表规范 distro，identity 不加载 profile", async () => {
    const backend = wsl();
    await expect(backend.resolveIdentity()).resolves.toEqual({ distro: "Ubuntu", user: "fixture" });
    const args = fixture.commands.find(({ command }) => command === "wsl.exe")?.args ?? [];
    expect(args).toContain("--noprofile");
    expect(args).toContain("--norc");
    expect(args).not.toContain("-lc");
    await backend.resolveIdentity();
    expect(fixture.commands).toHaveLength(1);
  });

  it.each([
    ["noise\nUbuntu\nfixture\n/home/fixture", "身份标记"],
    ["__ZCODE_WSL_IDENTITY__\nUbuntu\nbad/user\n/home/fixture", "user 无效"],
  ])("无效身份拒绝且失败不缓存", async (output, message) => {
    const backend = wsl();
    fixture.identity = output;
    await expect(backend.resolveIdentity()).rejects.toThrow(message);
    fixture.identity = "__ZCODE_WSL_IDENTITY__\nUbuntu\nfixture\n/home/fixture";
    await expect(backend.resolveIdentity()).resolves.toEqual({ distro: "Ubuntu", user: "fixture" });
    expect(fixture.commands).toHaveLength(2);
  });

  it("有效身份以实际 user 为准，保留指定 launch user 的路由", async () => {
    const backend = wsl("requested-fixture");
    await expect(backend.resolveIdentity()).resolves.toEqual({ distro: "Ubuntu", user: "fixture" });
    expect(fixture.commands[0]?.args.slice(0, 4)).toEqual([
      "-d",
      "Ubuntu",
      "-u",
      "requested-fixture",
    ]);
  });

  it("CLI 身份探测失败后允许重新探测", async () => {
    const backend = wsl();
    fixture.identityError = true;
    await expect(backend.resolveIdentity()).rejects.toThrow("fixture identity unavailable");
    fixture.identityError = false;
    await expect(backend.resolveIdentity()).resolves.toEqual({ distro: "Ubuntu", user: "fixture" });
  });

  it("WSL signal exit 不再当成功", async () => {
    const stream = await wsl().exec("fixture");
    const child = vi.mocked(spawn).mock.results.at(-1)?.value as EventEmitter;
    const listener = vi.fn();
    stream.onClose(listener);
    child.emit("exit", null, "SIGTERM");
    child.emit("close", null, "SIGTERM");
    expect(listener).toHaveBeenCalledExactlyOnceWith(143);
  });
});

describe("Docker backend 诊断与流", () => {
  function docker() {
    const backend = new DockerBackend({ kind: "docker", container: "fixture" });
    backends.push(backend);
    return backend;
  }

  it("原始 daemon probe 保留 CLI 原因，availability 仍提供布尔接口", async () => {
    fixture.daemonError = "fixture daemon socket permission denied";
    await expect(probeDockerDaemon()).rejects.toThrow(fixture.daemonError);
    await expect(isDockerAvailable()).resolves.toBe(false);
  });

  it("失败诊断清旧成功缓存，返回显式 unknown 并允许重试", async () => {
    const backend = docker();
    await backend.diagnoseExecFailure();
    fixture.daemonError = "fixture daemon socket permission denied";
    await expect(backend.diagnoseExecFailure()).rejects.toMatchObject({
      code: "remote-connection-unknown",
      message: expect.stringContaining(fixture.daemonError),
    });
    fixture.daemonError = "";
    await expect(backend.diagnoseExecFailure()).resolves.toBeUndefined();
    expect(fixture.commands.filter(({ args }) => args[0] === "version")).toHaveLength(3);
  });

  it("初次 daemon 探测失败不缓存，普通调用即可重试", async () => {
    const backend = docker();
    fixture.daemonError = "fixture daemon unavailable";
    await expect(backend.exec("fixture")).rejects.toMatchObject({
      code: "remote-connection-unknown",
    });
    fixture.daemonError = "";
    await expect(backend.exec("fixture")).resolves.toHaveProperty("onClose");
    expect(fixture.commands.filter(({ args }) => args[0] === "version")).toHaveLength(2);
  });

  it("daemon 成功缓存供普通调用复用；诊断健康 daemon 不替换命令失败", async () => {
    const backend = docker();
    await backend.exec("fixture");
    await backend.exec("fixture");
    expect(fixture.commands.filter(({ args }) => args[0] === "version")).toHaveLength(1);
    await expect(backend.diagnoseExecFailure()).resolves.toBeUndefined();
    expect(fixture.commands.filter(({ args }) => args[0] === "version")).toHaveLength(2);
  });

  it("Docker signal exit 不再当成功", async () => {
    const stream = await docker().exec("fixture");
    const child = vi.mocked(spawn).mock.results.at(-1)?.value as EventEmitter;
    const listener = vi.fn();
    stream.onClose(listener);
    child.emit("exit", null, "SIGKILL");
    child.emit("close", null, "SIGKILL");
    expect(listener).toHaveBeenCalledExactlyOnceWith(137);
  });
});
