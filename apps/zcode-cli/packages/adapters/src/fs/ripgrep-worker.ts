import { Worker } from "node:worker_threads";
import type { RgArg, RipgrepBufferedResult } from "ripgrep";
import { createAbortError, isAbortError } from "./path-errors.js";

const DEFAULT_RIPGREP_TIMEOUT_MS = 30_000;

type RipgrepWorker = Pick<Worker, "once" | "terminate">;

interface RipgrepWorkerData {
  args: string[];
  preopens: Record<string, string>;
}

interface SerializedWorkerError {
  code?: unknown;
  message?: string;
  name?: string;
  stack?: string;
}

type RipgrepWorkerMessage =
  | { type: "result"; result: RipgrepBufferedResult }
  | { type: "error"; error: SerializedWorkerError };

export type RipgrepWorkerFactory = (workerData: RipgrepWorkerData) => RipgrepWorker;

let ripgrepWorkerFactoryForTests: RipgrepWorkerFactory | undefined;
let ripgrepTimeoutMsForTests: number | undefined;

const RIPGREP_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");

function serializeError(error) {
  if (!(error instanceof Error)) {
    return { message: String(error), name: "Error" };
  }
  return {
    code: "code" in error ? error.code : undefined,
    message: error.message,
    name: error.name,
    stack: error.stack,
  };
}

(async () => {
  try {
    const { ripgrep } = await import("ripgrep");
    const result = await ripgrep(workerData.args, {
      buffer: true,
      env: {},
      nodeWasi: false,
      preopens: workerData.preopens,
      returnOnExit: true,
    });
    parentPort.postMessage({ type: "result", result });
  } catch (error) {
    parentPort.postMessage({ type: "error", error: serializeError(error) });
  }
})();
`;

export class RipgrepRuntimeFailure extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super("Bundled ripgrep WASM failed to run");
    this.name = "RipgrepRuntimeFailure";
    this.cause = cause;
  }
}

class RipgrepTimeoutFailure extends Error {
  constructor(timeoutMs: number) {
    super(
      `ripgrep search timed out after ${timeoutMs}ms. The search was terminated before it completed.`,
    );
    this.name = "RipgrepTimeoutFailure";
  }
}

export function setRipgrepWorkerFactory(factory: RipgrepWorkerFactory | undefined): () => void {
  const previous = ripgrepWorkerFactoryForTests;
  ripgrepWorkerFactoryForTests = factory;
  return () => {
    ripgrepWorkerFactoryForTests = previous;
  };
}

export function setRipgrepTimeoutMs(timeoutMs: number | undefined): () => void {
  const previous = ripgrepTimeoutMsForTests;
  ripgrepTimeoutMsForTests = timeoutMs;
  return () => {
    ripgrepTimeoutMsForTests = previous;
  };
}

export async function runBundledRipgrep(
  args: readonly RgArg[],
  preopens: Record<string, string>,
  options: { signal?: AbortSignal } = {},
): Promise<RipgrepBufferedResult> {
  try {
    return await runBundledRipgrepWorker(args, preopens, {
      signal: options.signal,
      timeoutMs: ripgrepTimeoutMsForTests ?? DEFAULT_RIPGREP_TIMEOUT_MS,
    });
  } catch (error) {
    if (isAbortError(error) || error instanceof RipgrepTimeoutFailure) {
      throw error;
    }
    throw new RipgrepRuntimeFailure(error);
  }
}

function runBundledRipgrepWorker(
  args: readonly RgArg[],
  preopens: Record<string, string>,
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<RipgrepBufferedResult> {
  if (options.signal?.aborted) {
    return Promise.reject(createAbortError("ripgrep search was cancelled before it started"));
  }

  // 不能在 agent 主线程里直接运行 WASI ripgrep。大目录搜索会占住 Node
  // event loop，导致 session/stop 虽然绕过协议队列，却没有机会被 agent 处理。
  // 放到 Worker 后，用户 stop 和超时都能从主线程 terminate 这个搜索执行单元。
  const worker = createRipgrepWorker({
    args: args.map(String),
    preopens,
  });

  return new Promise<RipgrepBufferedResult>((resolve, reject) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const terminateWorker = (): void => {
      const termination = worker.terminate();
      if (typeof termination === "object" && termination !== null && "catch" in termination) {
        void termination.catch(() => undefined);
      }
    };

    const cleanup = (): void => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      options.signal?.removeEventListener("abort", handleAbort);
    };

    const settle = (settler: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      settler();
    };

    const handleAbort = (): void => {
      terminateWorker();
      settle(() => reject(createAbortError("ripgrep search was cancelled")));
    };

    options.signal?.addEventListener("abort", handleAbort, { once: true });
    timeoutId = setTimeout(() => {
      terminateWorker();
      settle(() => reject(new RipgrepTimeoutFailure(options.timeoutMs)));
    }, options.timeoutMs);

    worker.once("message", (message: unknown) => {
      settle(() => {
        const parsed = message as Partial<RipgrepWorkerMessage>;
        if (parsed.type === "result" && parsed.result) {
          resolve(parsed.result);
          return;
        }
        if (parsed.type === "error") {
          reject(deserializeWorkerError(parsed.error));
          return;
        }
        reject(new Error("ripgrep worker returned an unknown message"));
      });
    });

    worker.once("error", (error: Error) => {
      settle(() => reject(error));
    });

    worker.once("exit", (code: number) => {
      if (settled) return;
      settle(() => reject(new Error(`ripgrep worker exited before returning a result: ${code}`)));
    });
  });
}

function createRipgrepWorker(workerData: RipgrepWorkerData): RipgrepWorker {
  return (
    ripgrepWorkerFactoryForTests?.(workerData) ??
    new Worker(RIPGREP_WORKER_SOURCE, {
      eval: true,
      workerData,
    })
  );
}

function deserializeWorkerError(serialized: SerializedWorkerError | undefined): Error {
  const error = new Error(serialized?.message ?? "ripgrep worker failed");
  error.name = serialized?.name ?? "Error";
  if (serialized?.stack) {
    error.stack = serialized.stack;
  }
  if (serialized && "code" in serialized) {
    Object.assign(error, { code: serialized.code });
  }
  return error;
}
