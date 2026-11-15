import type { PoolEntry } from "./pool-entry.js";

/** lease 关闭时释放本 lease 的连接；session 隔离的 entry 会因此立即关闭。 */
interface LeaseCancellationOptions {
  isPoolClosed(): boolean;
  releaseLeases(): Array<Promise<void> | undefined>;
}

interface LeaseCancellation {
  readonly signal: AbortSignal;
  assertOpen(): void;
  /** caller 取消 + lease 关闭；connect 等待用它，不触碰共享连接。 */
  callerSignal(signal?: AbortSignal): AbortSignal;
  /** caller + lease + entry 三路合并；在途 tool/resource/elicitation 用它。 */
  requestSignal(entry: PoolEntry, signal?: AbortSignal): AbortSignal;
  wait<T>(work: Promise<T>, signal?: AbortSignal): Promise<T>;
  close(): Promise<void>;
}

/**
 * 每个 lease 一份取消域：close 一次性中止在途 connect 等待与 tool/resource/elicitation 请求。
 * 它不拥有连接——entry 的 controller 归 pool-entry 生命周期，这里只负责合并与等待。
 */
export function createLeaseCancellation(options: LeaseCancellationOptions): LeaseCancellation {
  const shutdown = new AbortController();
  let closed = false;
  let closing: Promise<void> | undefined;
  const assertOpen = () => {
    if (closed || options.isPoolClosed()) throw new Error("MCP session lease is closed");
  };
  const callerSignal = (signal?: AbortSignal) =>
    signal ? AbortSignal.any([shutdown.signal, signal]) : shutdown.signal;
  const requestSignal = (entry: PoolEntry, signal?: AbortSignal) =>
    AbortSignal.any([shutdown.signal, entry.controller.signal, ...(signal ? [signal] : [])]);
  const wait = async <T>(work: Promise<T>, signal = shutdown.signal): Promise<T> => {
    signal.throwIfAborted();
    let abort: (() => void) | undefined;
    try {
      const value = await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
        }),
      ]);
      signal.throwIfAborted();
      return value;
    } finally {
      if (abort) signal.removeEventListener("abort", abort);
    }
  };
  return {
    signal: shutdown.signal,
    assertOpen,
    callerSignal,
    requestSignal,
    wait,
    close() {
      closing ??= (async () => {
        closed = true;
        shutdown.abort(new Error("MCP session lease closed"));
        await Promise.allSettled(options.releaseLeases());
      })();
      return closing;
    },
  };
}
