import { realpath } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { Worker } from "node:worker_threads";
import { createInterface } from "node:readline";
import { z } from "zod";
import {
  databaseStartupErrorCodeSchema,
  databaseMigrationFactsSchema,
  type DatabaseMigrationFacts,
  databaseStartupErrorDetailsSchema,
  zcodeStoragePreparationFrameSchema,
  type DatabaseStartupState,
} from "@zcode/shared";
import { resolveDefaultZCodeAgentCommand } from "@zcode/services/storage-startup";
import {
  createNativeStorageTransport,
  createNodeWorkerStorageTransport,
  type StoragePreparationTransport,
} from "./storagePreparationTransport.js";

type Phase = NonNullable<DatabaseStartupState["databasePhase"]>;
const workerMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("progress"),
      migration: databaseMigrationFactsSchema.optional(),
      phase: z.enum([
        "checking",
        "waiting_for_lock",
        "migrating",
        "committing",
        "maintaining",
        "ready",
      ]),
    })
    .strict(),
  z
    .object({
      type: z.literal("done"),
      backupSkipped: z.boolean().optional(),
      backupSkippedPhases: z.array(z.string()).max(8).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("failed"),
      errorCode: databaseStartupErrorCodeSchema,
      migration: databaseMigrationFactsSchema.optional(),
      ...databaseStartupErrorDetailsSchema.shape,
    })
    .strict(),
]);
const statusError = (
  kind: string,
  details?: {
    sqliteCode?: number;
    systemCode?: string;
    migrationId?: string;
    migration?: DatabaseMigrationFacts;
  },
  databaseId?: string,
) =>
  Object.assign(new Error(`Storage preparation failed: ${kind}`), {
    kind,
    errcode: details?.sqliteCode,
    code: details?.systemCode,
    migrationId: details?.migrationId,
    migrationUpdate:
      databaseId && details?.migration ? { databaseId, migration: details.migration } : undefined,
  });

interface HostStoragePreparationResult {
  backupSkipped: boolean;
  backupSkippedPhases: string[];
}

export function prepareHostStorage(
  path: string,
  report: (phase: Phase, migration?: DatabaseMigrationFacts) => void,
  signal: AbortSignal,
  hostId?: string,
): Promise<HostStoragePreparationResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./tasksStorageWorker.js", import.meta.url), {
      workerData: { path, ...(hostId ? { hostId } : {}) },
    });
    let done = false;
    let storageResult: HostStoragePreparationResult = {
      backupSkipped: false,
      backupSkippedPhases: [],
    };
    let failure: unknown;
    let firstState = false;
    const firstStateTimer = setTimeout(() => {
      failure = statusError("startup_status_timeout");
      void worker.terminate();
    }, 30_000);
    const abort = () => {
      failure = statusError("transport_closed");
      void worker.terminate();
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.on("message", (raw: unknown) => {
      const result = workerMessageSchema.safeParse(raw);
      if (!result.success) {
        failure = statusError("transport_closed");
        void worker.terminate();
        return;
      }
      firstState = true;
      clearTimeout(firstStateTimer);
      const message = result.data;
      if (message.type === "progress") report(message.phase, message.migration);
      else if (message.type === "done") {
        done = true;
        storageResult = {
          backupSkipped: message.backupSkipped ?? false,
          backupSkippedPhases: message.backupSkippedPhases ?? [],
        };
      } else failure = statusError(message.errorCode, message, "tasks-index");
    });
    worker.once("error", (error) => {
      failure = error;
    });
    worker.once("exit", (code) => {
      clearTimeout(firstStateTimer);
      signal.removeEventListener("abort", abort);
      if (done && code === 0 && !failure && firstState) resolve(storageResult);
      else reject(failure ?? statusError("transport_closed"));
    });
    if (signal.aborted) abort();
  });
}

function waitForStdoutClose(stream: NodeJS.ReadableStream): Promise<void> {
  return new Promise((resolve) => {
    const target = stream as NodeJS.ReadableStream & {
      destroyed?: boolean;
      readableEnded?: boolean;
    };
    const done = () => {
      target.off("end", done);
      target.off("close", done);
      target.off("error", done);
      resolve();
    };
    if (target.destroyed || target.readableEnded) {
      done();
      return;
    }
    target.once("end", done);
    target.once("close", done);
    target.once("error", done);
  });
}

/** TS Worker 与 native 进程共用的握手、reuse 与失败路径；transport 只提供 IO 与退出。 */
async function runStoragePreparation(
  transport: StoragePreparationTransport,
  options: {
    signal: AbortSignal;
    report: (
      phase: Phase,
      details?: { databaseId: string; migration?: DatabaseMigrationFacts },
    ) => void;
    preparedPaths?: Set<string>;
    observePath: (path: string) => Promise<void>;
  },
): Promise<void> {
  const input = transport.stdin;
  const lines = createInterface({ input: transport.stdout });
  // 退出事件可能早于 stdout end；先开始观察，避免漏掉 end 永久挂起。
  const stdoutClosed = waitForStdoutClose(transport.stdout);
  let settled = false;
  let prepared = false;
  let pathReceived = false;
  let preparedPath: string | undefined;
  let inputClosed = false;
  let failure: unknown;
  let termination: Promise<void> | undefined;

  const terminate = () => {
    termination ??= transport.terminate().catch(() => undefined);
    return termination;
  };
  const fail = (error: unknown) => {
    if (settled) return;
    failure ??= error;
    void terminate();
  };
  const abort = () => fail(statusError("transport_closed"));
  const firstStateTimer = setTimeout(() => fail(statusError("startup_status_timeout")), 30_000);
  options.signal.addEventListener("abort", abort, { once: true });
  // stdout 只有有界控制帧；stderr 排空但不把可能含本地路径的原始文本上报。
  transport.stderr.resume();
  input.on("error", (error) => {
    // 收到 storagePrepared 后子进程可自行退出；此时写端关闭产生的 EPIPE 不代表准备失败。
    if (prepared || inputClosed) return;
    fail(error);
  });

  const handleStoragePath = async (rawPath: string) => {
    try {
      // 仅复用同一次准备中已成功关闭的真实库，不能按不同 cwd 误判为不同数据库。
      preparedPath = await realpath(rawPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return resolvePath(rawPath);
        throw error;
      });
      if (settled || failure || options.signal.aborted) return;
      const reuse = options.preparedPaths?.has(preparedPath) ?? false;
      if (!reuse) await options.observePath(rawPath);
      if (settled || failure || options.signal.aborted) return;
      input.write(`${JSON.stringify({ method: "startup/storagePathReady", reuse })}\n`);
    } catch (error) {
      fail(error);
    }
  };

  lines.on("line", (line) => {
    try {
      if (line.length > 65536) throw statusError("transport_closed");
      const frame = zcodeStoragePreparationFrameSchema.parse(JSON.parse(line));
      clearTimeout(firstStateTimer);
      if (frame.method === "startup/storagePath") {
        // 同一轮只接受一个真实路径；重复帧即协议越界，不能覆盖 preparedPath。
        if (pathReceived) throw statusError("transport_closed");
        pathReceived = true;
        void handleStoragePath(frame.params.path);
        return;
      }
      if (frame.method === "startup/storagePrepared") {
        // prepared 必须先于 path；否则是无 path 的伪成功或握手顺序被破坏。
        if (!pathReceived) throw statusError("transport_closed");
        prepared = true;
        inputClosed = true;
        try {
          input.end();
        } catch {
          /* 进程已退出时关闭写端失败不影响已收到的 storagePrepared。 */
        }
        return;
      }
      if (frame.params.phase === "failed")
        fail(
          statusError(
            frame.params.errorCode ?? "sql_failed",
            frame.params,
            frame.params.databaseId,
          ),
        );
      else
        options.report(frame.params.phase, {
          databaseId: frame.params.databaseId,
          migration: frame.params.migration,
        });
    } catch (error) {
      fail(error);
    }
  });
  transport.onError((error) => fail(error));
  // 进入时 signal 已 abort 时不会再派发 abort 事件，必须显式收口。
  if (options.signal.aborted) abort();

  const [exitCode] = await Promise.all([transport.whenExited(), stdoutClosed]);
  settled = true;
  clearTimeout(firstStateTimer);
  options.signal.removeEventListener("abort", abort);
  lines.close();
  // 失败/中止路径必须等进程树清理完成再结算，不能只观察到 root 退出就返回。
  if (termination) await termination;
  if (exitCode === 0 && prepared && !failure) {
    // 只有 stdout 排空、退出码为 0 且收到 storagePrepared 才缓存真实路径。
    if (preparedPath) options.preparedPaths?.add(preparedPath);
    return;
  }
  if (failure) throw failure;
  throw statusError("transport_closed");
}

/** 准备单个 workspace 的会话库；transport 由 Services resolver 的 descriptor 唯一决定。 */
export async function prepareSessionStorage(options: {
  cwd: string;
  env?: Record<string, string>;
  signal: AbortSignal;
  report: (
    phase: Phase,
    details?: { databaseId: string; migration?: DatabaseMigrationFacts },
  ) => void;
  preparedPaths?: Set<string>;
  observePath: (path: string) => Promise<void>;
}): Promise<void> {
  const command = resolveDefaultZCodeAgentCommand({
    workspacePath: options.cwd,
    workspaceKey: options.cwd,
    presentationSurface: "desktop",
  });
  const descriptor = command?.storagePreparation;
  if (!command?.supportsStorageStartup || !descriptor) throw statusError("unsupported_runtime");
  // resolved cwd 优先于调用方 cwd；env 沿用既有优先级：process.env < options.env < command.env。
  const cwd = command.cwd ?? options.cwd;
  const env = { ...process.env, ...options.env, ...command.env };
  const transport =
    descriptor.kind === "node-worker"
      ? createNodeWorkerStorageTransport({
          entry: descriptor.entry,
          argv: ["app-server", "--stdio", "--prepare-storage", "--cwd", cwd],
          env,
        })
      : createNativeStorageTransport({
          command: command.command,
          args: [...(command.args ?? []), "--prepare-storage", "--cwd", cwd],
          cwd,
          env,
        });
  await runStoragePreparation(transport, options);
}
