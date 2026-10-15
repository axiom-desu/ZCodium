import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Services resolver 是 runtime 选择的唯一 owner；测试只替换它的返回值，
// 握手、realpath、observePath、preparedPaths 与两个 transport 都走生产实现。
const resolverMock = vi.hoisted(() => ({ resolveDefaultZCodeAgentCommand: vi.fn() }));
vi.mock("@zcode/services/storage-startup", () => ({
  resolveDefaultZCodeAgentCommand: resolverMock.resolveDefaultZCodeAgentCommand,
}));

import { prepareSessionStorage } from "./storagePreparationProcesses.js";

const fixture = fileURLToPath(new URL("./storagePreparationFixture.mjs", import.meta.url));
type TransportKind = "worker" | "native";

function buildCommand(kind: TransportKind, env: Record<string, string>) {
  return {
    command: process.execPath,
    ...(kind === "native" ? { args: [fixture] } : {}),
    supportsStorageStartup: true,
    storagePreparation:
      kind === "worker" ? { kind: "node-worker", entry: fixture } : { kind: "native-process" },
    env,
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "zcode-storage-prep-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function runPreparation(options: {
  kind: TransportKind;
  env?: Record<string, string>;
  signal?: AbortSignal;
  observePath?: (path: string) => Promise<void>;
  preparedPaths?: Set<string>;
  report?: (phase: string) => void;
}) {
  resolverMock.resolveDefaultZCodeAgentCommand.mockReturnValue(
    buildCommand(options.kind, options.env ?? {}),
  );
  return prepareSessionStorage({
    cwd: dir,
    signal: options.signal ?? new AbortController().signal,
    preparedPaths: options.preparedPaths,
    observePath: options.observePath ?? (async () => {}),
    report: options.report ?? (() => {}),
  });
}

describe.each(["worker", "native"] as const)("%s transport", (kind) => {
  it("正常完成并缓存真实 prepared path", async () => {
    const path = join(dir, "session.db");
    const observe = vi.fn(async () => {});
    const preparedPaths = new Set<string>();
    await runPreparation({
      kind,
      env: { STORAGE_PREP_MODE: "ok", STORAGE_PREP_PATH: path },
      observePath: observe,
      preparedPaths,
    });
    expect(observe).toHaveBeenCalledTimes(1);
    expect([...preparedPaths]).toEqual([path]);
  });

  it("同一真实路径第二次复用且不重复 observe", async () => {
    const path = join(dir, "session.db");
    const readyLog = join(dir, "ready.json");
    const observe = vi.fn(async () => {});
    const preparedPaths = new Set<string>();
    await runPreparation({
      kind,
      env: { STORAGE_PREP_MODE: "ok", STORAGE_PREP_PATH: path },
      observePath: observe,
      preparedPaths,
    });
    await runPreparation({
      kind,
      env: { STORAGE_PREP_MODE: "ok", STORAGE_PREP_PATH: path, STORAGE_PREP_READY_LOG: readyLog },
      observePath: observe,
      preparedPaths,
    });
    expect(observe).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(readyLog, "utf8")).reuse).toBe(true);
  });

  it("非法帧失败并终止", async () => {
    const preparedPaths = new Set<string>();
    // 非法帧的具体错误来自 JSON/Zod 解析；这里只要求拒绝且不缓存路径。
    await expect(
      runPreparation({ kind, env: { STORAGE_PREP_MODE: "invalid" }, preparedPaths }),
    ).rejects.toThrow();
    expect(preparedPaths.size).toBe(0);
  });

  it("重复 storagePath 严格失败", async () => {
    await expect(
      runPreparation({ kind, env: { STORAGE_PREP_MODE: "duplicate-path" } }),
    ).rejects.toThrow(/transport_closed/);
  });

  it("storagePrepared 先于 storagePath 失败", async () => {
    await expect(
      runPreparation({ kind, env: { STORAGE_PREP_MODE: "prepared-first" } }),
    ).rejects.toThrow(/transport_closed/);
  });

  it("failed 状态失败", async () => {
    await expect(runPreparation({ kind, env: { STORAGE_PREP_MODE: "failed" } })).rejects.toThrow(
      /open_failed/,
    );
  });

  it("非零退出不缓存 prepared path", async () => {
    const preparedPaths = new Set<string>();
    await expect(
      runPreparation({
        kind,
        env: { STORAGE_PREP_MODE: "nonzero", STORAGE_PREP_PATH: join(dir, "session.db") },
        preparedPaths,
      }),
    ).rejects.toThrow(/transport_closed/);
    expect(preparedPaths.size).toBe(0);
  });

  it("未 prepared 的 code0 失败", async () => {
    const preparedPaths = new Set<string>();
    await expect(
      runPreparation({
        kind,
        env: { STORAGE_PREP_MODE: "no-prepared", STORAGE_PREP_PATH: join(dir, "session.db") },
        preparedPaths,
      }),
    ).rejects.toThrow(/transport_closed/);
    expect(preparedPaths.size).toBe(0);
  });

  it("observePath 失败终止且不缓存", async () => {
    const preparedPaths = new Set<string>();
    await expect(
      runPreparation({
        kind,
        env: { STORAGE_PREP_MODE: "ok", STORAGE_PREP_PATH: join(dir, "session.db") },
        observePath: async () => {
          throw new Error("observe failed");
        },
        preparedPaths,
      }),
    ).rejects.toThrow(/observe failed/);
    expect(preparedPaths.size).toBe(0);
  });

  it("abort 终止准备进程", async () => {
    const controller = new AbortController();
    await expect(
      runPreparation({
        kind,
        env: { STORAGE_PREP_MODE: "hold", STORAGE_PREP_PATH: join(dir, "session.db") },
        signal: controller.signal,
        report: (phase) => {
          if (phase === "ready") controller.abort();
        },
      }),
    ).rejects.toThrow(/transport_closed/);
  });

  it("signal 已 abort 时直接终止", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runPreparation({ kind, env: { STORAGE_PREP_MODE: "hold" }, signal: controller.signal }),
    ).rejects.toThrow(/transport_closed/);
  });
});

describe("native transport cleanup", () => {
  it("abort 后不留下持锁孤儿", async () => {
    const pidLog = join(dir, "pid.txt");
    const controller = new AbortController();
    const outcome = await runPreparation({
      kind: "native",
      env: {
        STORAGE_PREP_MODE: "hold",
        STORAGE_PREP_PID_LOG: pidLog,
        STORAGE_PREP_PATH: join(dir, "session.db"),
      },
      signal: controller.signal,
      report: (phase) => {
        if (phase === "ready") controller.abort();
      },
    }).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(Error);
    const pid = Number(await readFile(pidLog, "utf8"));
    expect(Number.isInteger(pid)).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

describe("unsupported runtime", () => {
  it("缺 storagePreparation descriptor 明确失败", async () => {
    resolverMock.resolveDefaultZCodeAgentCommand.mockReturnValue({
      command: process.execPath,
      supportsStorageStartup: true,
    });
    await expect(
      prepareSessionStorage({
        cwd: dir,
        signal: new AbortController().signal,
        observePath: async () => {},
        report: () => {},
      }),
    ).rejects.toThrow(/unsupported_runtime/);
  });
});
