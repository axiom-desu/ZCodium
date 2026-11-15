import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import {
  EXTENSION_HOST_ENV,
  EXTENSION_SHUTDOWN_TIMEOUT_MS,
  EXTENSION_STARTUP_TIMEOUT_MS,
  extensionHostProcessMessageSchema,
  type ExtensionHostProcessMessage,
} from "@zcode/shared/extension-host";

/**
 * 扩展进程 supervisor（Desktop Main 唯一 owner）。
 *
 * 只负责进程生命周期：拉起、ready 握手、崩溃重启预算、优雅停止与强杀兜底。
 * 不解析能力请求、不保存授权或槽位；这些属于窗口 Host 的 `services/extensions`。
 *
 * E6：每个 `(window, pluginId)` 独立进程/凭据；并发 start 串行，停止中不重启，迟到旧 child 不覆盖新代际。
 */
interface ExtensionHostStartInput {
  generation: number;
  workspaceIdentity: string;
  endpoint: string;
  token: string;
  pluginDir: string;
  pluginId: string;
}

interface ExtensionHostSupervisorOptions {
  workerPath?: string;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  maxRestarts?: number;
  restartWindowMs?: number;
  nodePath?: string;
  /** 测试可传 `["--import","tsx", workerPath]`；生产默认只运行打包后的 worker。 */
  spawnArgs?: string[];
  logger?: { info(message: string): void; warn(message: string): void };
}

interface RunningProcess {
  ownerWebContentsId: number;
  pluginId: string;
  generation: number;
  child: ChildProcessWithoutNullStreams;
  ready: boolean;
  /** ready 之前收到的 error 帧：启动失败原因，不能让进程继续被当成 ready。 */
  startupError?: string;
  stopping: boolean;
  stopFlight?: Promise<void>;
  restarts: number;
  restartTimestamps: number[];
  input: ExtensionHostStartInput;
}

interface ExtensionHostSupervisor {
  start(ownerWebContentsId: number, input: ExtensionHostStartInput): Promise<{ pid: number }>;
  /** 停止该窗口该代际的全部插件进程；返回是否命中。 */
  stop(ownerWebContentsId: number, generation: number): Promise<boolean>;
  /** 只停止指定插件；撤销不能误停同窗口其他插件。 */
  stopPlugin(ownerWebContentsId: number, generation: number, pluginId: string): Promise<boolean>;
  has(ownerWebContentsId: number): boolean;
  hasPlugin(ownerWebContentsId: number, pluginId: string): boolean;
  disposeWindow(ownerWebContentsId: number): Promise<void>;
  disposeAll(): Promise<void>;
}

export function createExtensionHostSupervisor(
  options: ExtensionHostSupervisorOptions = {},
): ExtensionHostSupervisor {
  const processes = new Map<string, RunningProcess>();
  const chains = new Map<string, Promise<unknown>>();
  const workerPath = options.workerPath ?? join(import.meta.dirname, "extensionHostWorker.js");
  const startupTimeoutMs = options.startupTimeoutMs ?? EXTENSION_STARTUP_TIMEOUT_MS;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? EXTENSION_SHUTDOWN_TIMEOUT_MS;
  const maxRestarts = options.maxRestarts ?? 3;
  const restartWindowMs = options.restartWindowMs ?? 60_000;
  let disposed = false;

  function processKey(ownerWebContentsId: number, pluginId: string): string {
    return `${ownerWebContentsId}\u0000${pluginId}`;
  }

  function enqueue<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = chains.get(key) ?? Promise.resolve();
    const next = previous.then(run, run);
    chains.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  function spawnProcess(
    ownerWebContentsId: number,
    key: string,
    input: ExtensionHostStartInput,
  ): RunningProcess {
    const child = spawn(options.nodePath ?? process.execPath, options.spawnArgs ?? [workerPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: buildExtensionProcessEnv(input),
      windowsHide: true,
    });
    const record: RunningProcess = {
      ownerWebContentsId,
      pluginId: input.pluginId,
      generation: input.generation,
      child,
      ready: false,
      stopping: false,
      restarts: 0,
      restartTimestamps: [],
      input,
    };
    processes.set(key, record);
    wireChild(key, record);
    // 凭据只经私有 stdin 一次性下发；不写环境变量/argv，ready 前读取并消耗第一帧。
    try {
      record.child.stdin.write(`${JSON.stringify({ type: "bootstrap", token: input.token })}\n`);
    } catch {
      // spawn 失败时的 EPIPE 由 stdin error 处理器吞掉；waitReady 会因 exit 失败。
    }
    return record;
  }

  function wireChild(key: string, record: RunningProcess): void {
    let buffer = "";
    // 进程被强杀时 stdin 可能异步报 EPIPE；不处理会变成 unhandled error。
    record.child.stdin.on("error", () => {});
    record.child.stdout.setEncoding("utf8");
    record.child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) handleMessage(record, line);
        index = buffer.indexOf("\n");
      }
    });
    record.child.on("error", (error) => {
      options.logger?.warn(`extension host spawn error: ${error.message}`);
    });
    record.child.stderr.setEncoding("utf8");
    record.child.stderr.on("data", (chunk: string) => {
      options.logger?.warn(`extension host stderr: ${String(chunk).slice(0, 400)}`);
    });
    record.child.on("exit", (code, signal) => {
      if (disposed) return;
      if (processes.get(key) !== record) return;
      if (record.stopping) {
        processes.delete(key);
        return;
      }
      options.logger?.warn(
        `extension host exited unexpectedly owner=${record.ownerWebContentsId} plugin=${record.pluginId} code=${code ?? "none"} signal=${signal ?? "none"}`,
      );
      void maybeRestart(key, record);
    });
  }

  function handleMessage(record: RunningProcess, line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const message = extensionHostProcessMessageSchema.safeParse(parsed);
    if (!message.success) return;
    const value: ExtensionHostProcessMessage = message.data;
    if (value.type === "ready") {
      // 握手必须同时匹配代际与插件身份，防止错误目录/错误凭据的进程被当成 ready。
      if (value.generation === record.generation && value.pluginId === record.pluginId) {
        record.ready = true;
      }
      return;
    }
    if (value.type === "log") {
      options.logger?.info(`extension host: ${value.message}`);
      return;
    }
    // ready 之前的 error 是启动失败，必须让 start 立即拒绝；ready 之后只是运行期告警。
    if (!record.ready && record.startupError === undefined) {
      record.startupError = value.message;
      return;
    }
    options.logger?.warn(`extension host error: ${value.message}`);
  }

  async function maybeRestart(key: string, record: RunningProcess): Promise<void> {
    await enqueue(key, async () => {
      if (disposed || record.stopping) return;
      if (processes.get(key) !== record) return;
      const now = Date.now();
      record.restartTimestamps = record.restartTimestamps.filter(
        (timestamp) => now - timestamp < restartWindowMs,
      );
      if (record.restartTimestamps.length >= maxRestarts) {
        processes.delete(key);
        options.logger?.warn(
          `extension host restart budget exhausted owner=${record.ownerWebContentsId} plugin=${record.pluginId}`,
        );
        return;
      }
      record.restartTimestamps.push(now);
      const next = spawnProcess(record.ownerWebContentsId, key, record.input);
      next.restarts = record.restarts + 1;
      next.restartTimestamps = record.restartTimestamps;
      options.logger?.info(
        `extension host restarted owner=${record.ownerWebContentsId} plugin=${record.pluginId} attempt=${next.restarts}`,
      );
    });
  }

  function waitReady(record: RunningProcess): Promise<{ pid: number }> {
    if (record.ready && record.child.pid !== undefined) {
      return Promise.resolve({ pid: record.child.pid });
    }
    return new Promise((resolve, reject) => {
      if (record.stopping) {
        reject(new Error("Extension host start was stopped."));
        return;
      }
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Extension host did not report ready in time."));
      }, startupTimeoutMs);
      const onExit = () => {
        // 'exit' 可能先于 stdout 的 error 帧到达；给一帧宽的宽限再判定失败原因。
        setTimeout(() => {
          cleanup();
          reject(new Error(record.startupError ?? "Extension host exited before ready."));
        }, 25);
      };
      const interval = setInterval(() => {
        if (record.startupError !== undefined) {
          cleanup();
          reject(new Error(record.startupError));
          return;
        }
        if (record.stopping) {
          cleanup();
          reject(new Error("Extension host start was stopped."));
          return;
        }
        if (record.ready && record.child.pid !== undefined) {
          cleanup();
          resolve({ pid: record.child.pid });
        }
      }, 20);
      const cleanup = () => {
        clearTimeout(timer);
        clearInterval(interval);
        record.child.off("exit", onExit);
      };
      record.child.once("exit", onExit);
    });
  }

  function stopProcess(record: RunningProcess): Promise<void> {
    if (record.stopFlight) return record.stopFlight;
    record.stopping = true;
    record.stopFlight = (async () => {
      if (record.child.exitCode !== null || record.child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => {
        if (record.child.exitCode !== null || record.child.signalCode !== null) resolve();
        else record.child.once("exit", () => resolve());
      });
      try {
        record.child.stdin.write(`${JSON.stringify({ type: "shutdown" })}\n`);
      } catch {
        // stdin 已关闭时直接进入强杀。
      }
      const graceful = await Promise.race([
        exited.then(() => true),
        delay(shutdownTimeoutMs).then(() => false),
      ]);
      if (!graceful) {
        record.child.kill("SIGTERM");
        const killed = await Promise.race([
          exited.then(() => true),
          delay(1_000).then(() => false),
        ]);
        if (!killed) {
          record.child.kill("SIGKILL");
          await Promise.race([exited, delay(1_000)]);
        }
      }
    })();
    return record.stopFlight;
  }

  async function stopRecord(key: string, record: RunningProcess): Promise<void> {
    // 立即标记并停进程，不排队等待正在进行的 start flight；waitReady 会因 stopping 退出。
    await stopProcess(record);
    if (processes.get(key) === record) processes.delete(key);
  }

  return {
    start(ownerWebContentsId, input) {
      const key = processKey(ownerWebContentsId, input.pluginId);
      return enqueue(key, async () => {
        if (disposed) throw new Error("Extension host supervisor is disposed.");
        const existing = processes.get(key);
        if (existing) {
          if (
            existing.generation === input.generation &&
            existing.ready &&
            existing.child.pid !== undefined
          ) {
            return { pid: existing.child.pid };
          }
          await stopRecord(key, existing);
        }
        const record = spawnProcess(ownerWebContentsId, key, input);
        try {
          const result = await waitReady(record);
          options.logger?.info(
            `extension host started owner=${ownerWebContentsId} plugin=${input.pluginId} generation=${input.generation} pid=${result.pid}`,
          );
          return result;
        } catch (error) {
          record.stopping = true;
          record.child.kill("SIGKILL");
          if (processes.get(key) === record) processes.delete(key);
          throw error;
        }
      });
    },
    async stop(ownerWebContentsId, generation) {
      const records = [...processes.entries()].filter(
        ([, record]) =>
          record.ownerWebContentsId === ownerWebContentsId && record.generation === generation,
      );
      await Promise.all(records.map(([key, record]) => stopRecord(key, record)));
      return records.length > 0;
    },
    async stopPlugin(ownerWebContentsId, generation, pluginId) {
      const key = processKey(ownerWebContentsId, pluginId);
      const record = processes.get(key);
      // 只停止自己代际；窗口已换代的旧请求不能误停新进程。
      if (!record || record.generation !== generation) return false;
      await stopRecord(key, record);
      return true;
    },
    has(ownerWebContentsId) {
      const prefix = `${ownerWebContentsId}\u0000`;
      return [...processes.keys()].some((key) => key.startsWith(prefix));
    },
    hasPlugin(ownerWebContentsId, pluginId) {
      return processes.has(processKey(ownerWebContentsId, pluginId));
    },
    async disposeWindow(ownerWebContentsId) {
      const records = [...processes.entries()].filter(
        ([, record]) => record.ownerWebContentsId === ownerWebContentsId,
      );
      await Promise.all(records.map(([key, record]) => stopRecord(key, record)));
    },
    async disposeAll() {
      disposed = true;
      const records = [...processes.entries()];
      processes.clear();
      await Promise.all(records.map(([, record]) => stopProcess(record)));
    },
  };
}

/** 环境只保留最小运行集合与当前插件协议变量；不继承认证/遥测/代理等宿主环境。 */
export function buildExtensionProcessEnv(input: ExtensionHostStartInput): NodeJS.ProcessEnv {
  const allowlist = [
    "PATH",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "SystemRoot",
    "ComSpec",
    "PATHEXT",
  ] as const;
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "1" };
  for (const key of allowlist) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env[EXTENSION_HOST_ENV.endpoint] = input.endpoint;
  // 凭据不在环境里：token 只经 stdin 的 bootstrap 帧下发。
  env[EXTENSION_HOST_ENV.generation] = String(input.generation);
  env[EXTENSION_HOST_ENV.workspaceIdentity] = input.workspaceIdentity;
  env[EXTENSION_HOST_ENV.pluginDir] = input.pluginDir;
  env[EXTENSION_HOST_ENV.pluginId] = input.pluginId;
  return env;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
