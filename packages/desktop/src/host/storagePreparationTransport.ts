import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import {
  shouldSpawnInDetachedProcessGroup,
  terminateProcessTreeAndWait,
} from "@zcode/services/process/processTreeTerminator";

/**
 * Host 视角的存储准备传输层。Worker 与 native child 的差异只在这里适配，
 * 握手、realpath、observePath 与 preparedPaths 复用同一份实现。
 */
export interface StoragePreparationTransport {
  readonly stdin: NodeJS.WritableStream;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  /** 底层线程退出或 native stdio close 后 resolve；返回退出码。 */
  whenExited(): Promise<number | null>;
  /** 终止底层线程/进程树并等待退出；重复调用复用同一飞行。 */
  terminate(): Promise<void>;
  onError(listener: (error: unknown) => void): void;
}

export function createNodeWorkerStorageTransport(options: {
  entry: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
}): StoragePreparationTransport {
  // argv 与既有 CLI Worker 入口保持一致：app-server --stdio --prepare-storage --cwd <cwd>。
  const worker = new Worker(options.entry, {
    argv: options.argv,
    env: options.env,
    stdin: true,
    stdout: true,
    stderr: true,
  });
  const exited = new Promise<number | null>((resolve) => {
    worker.once("exit", (code) => resolve(code));
  });
  let errorListener: ((error: unknown) => void) | undefined;
  worker.once("error", (error) => errorListener?.(error));
  let termination: Promise<void> | undefined;
  return {
    stdin: worker.stdin!,
    stdout: worker.stdout!,
    stderr: worker.stderr!,
    whenExited: () => exited,
    terminate: () => {
      termination ??= worker.terminate().then(
        () => undefined,
        () => undefined,
      );
      return termination;
    },
    onError: (listener) => {
      errorListener = listener;
    },
  };
}

export function createNativeStorageTransport(options: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}): StoragePreparationTransport {
  const ownsProcessGroup = shouldSpawnInDetachedProcessGroup();
  const startedAt = Date.now();
  // 复用 resolved command/args/cwd/env，只追加存储准备参数；Rust 不进入 Worker。
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: "pipe",
    // 与 agent 一致：POSIX 独立进程组，Host 退出时能按组回收；Windows 交给 taskkill /T。
    detached: ownsProcessGroup,
  });
  const exited = new Promise<number | null>((resolve) => {
    // close 保证 stdout/stderr 已关闭，满足「stdout drain + code0」的退出判据。
    child.once("close", (code) => resolve(code));
  });
  let errorListener: ((error: unknown) => void) | undefined;
  child.once("error", (error) => errorListener?.(error));
  let termination: Promise<void> | undefined;
  return {
    stdin: child.stdin!,
    stdout: child.stdout!,
    stderr: child.stderr!,
    whenExited: () => exited,
    terminate: () => {
      // 既有公开 helper 负责 POSIX SIGTERM→SIGKILL 与 Windows taskkill /T；
      // Host 自身被 SIGKILL 时无法运行该逻辑，边界见 spec。
      termination ??= terminateProcessTreeAndWait(child, {
        ...(ownsProcessGroup && child.pid ? { ownedProcessGroupId: child.pid } : {}),
        ...(process.platform === "win32" ? { ownedProcessStartedAtMs: startedAt } : {}),
      }).then(
        () => undefined,
        () => undefined,
      );
      return termination;
    },
    onError: (listener) => {
      errorListener = listener;
    },
  };
}
