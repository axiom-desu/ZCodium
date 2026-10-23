import type { ZCodeProtocolMethod, ZCodeProtocolRequestId } from "@zcode/shared";
import {
  ProtocolRequestError,
  type ParamsSchema,
  type ZCodeProtocolClientRequestOptions,
} from "./server-types.js";
import type { ZCodeProtocolOutboundMessage } from "./server-dispatch-types.js";

const MAX_CLIENT_REQUEST_REANNOUNCE_INTERVAL_MS = 10_000;

interface PendingClientRequest<T> {
  method: string;
  reject: (error: Error) => void;
  resolve: (value: T) => void;
  resultSchema: ParamsSchema<T>;
  requestKeys: Set<string>;
  signal?: AbortSignal;
  timeout?: ReturnType<typeof setTimeout>;
  reannounceTimer?: ReturnType<typeof setTimeout>;
  abortHandler?: () => void;
}

interface ProtocolClientRequestTableOptions {
  /**
   * 每次发送都重新取当前 sink：server 的 setNotificationSink 可以在连接存活期间替换它，
   * 构造时缓存会继续写进已废弃的连接。
   */
  readonly getSink: () => ((message: ZCodeProtocolOutboundMessage) => void) | undefined;
}

/**
 * 反向 RPC（server → client）登记表。原本是 ZCodeProtocolAgentServer 的私有字段，
 * 提取成单实例对象后仍由 server 持有与转发，不产生第二份 pending 事实。
 */
export class ProtocolClientRequestTable {
  private disconnectError?: Error;
  private readonly pending = new Map<string, PendingClientRequest<unknown>>();
  private nextRequestId = 1;
  private readonly options: ProtocolClientRequestTableOptions;

  constructor(options: ProtocolClientRequestTableOptions) {
    this.options = options;
  }

  /** 连接关闭：反向请求已不可能收到响应，先结束 pending 再抛给调用方。 */
  disconnect(error: Error): void {
    this.disconnectError = error;
    const pendingRequests = new Set(this.pending.values());
    for (const pending of pendingRequests) {
      this.cleanup(pending);
      pending.reject(error);
    }
  }

  clearDisconnectError(): void {
    this.disconnectError = undefined;
  }

  request<T>(
    method: ZCodeProtocolMethod,
    params: unknown,
    resultSchema: ParamsSchema<T>,
    options?: ZCodeProtocolClientRequestOptions,
  ): Promise<T> {
    if (this.disconnectError) {
      throw this.disconnectError;
    }
    if (!this.options.getSink()) {
      throw new ProtocolRequestError(-32020, `No ZCode Protocol client is attached for ${method}`);
    }

    return new Promise<T>((resolve, reject) => {
      let active = true;
      const pending: PendingClientRequest<T> = {
        method,
        reject,
        resolve,
        resultSchema,
        requestKeys: new Set(),
        signal: options?.signal,
      };
      const cleanup = () => {
        active = false;
        this.cleanup(pending);
      };
      pending.abortHandler = () => {
        cleanup();
        reject(new ProtocolRequestError(-32021, `Client request cancelled: ${method}`));
      };
      if (options?.signal?.aborted) {
        pending.abortHandler();
        return;
      }
      if (options?.timeoutMs !== undefined) {
        pending.timeout = setTimeout(() => {
          cleanup();
          reject(
            new ProtocolRequestError(-32022, `Client request timed out: ${method}`, {
              timeoutMs: options.timeoutMs,
            }),
          );
        }, options.timeoutMs);
      }
      options?.signal?.addEventListener("abort", pending.abortHandler, { once: true });
      const sendClientRequest = () => {
        if (!active) {
          return;
        }
        const id = `server-${this.nextRequestId++}`;
        const key = String(id);
        pending.requestKeys.add(key);
        this.pending.set(key, pending as PendingClientRequest<unknown>);
        this.options.getSink()?.({
          id,
          method,
          params,
          ...(options?.trace ? { trace: options.trace } : {}),
        });
      };
      sendClientRequest();
      const reannounceIntervalMs =
        options?.reannounceIntervalMs !== undefined &&
        Number.isFinite(options.reannounceIntervalMs) &&
        options.reannounceIntervalMs > 0
          ? Math.floor(options.reannounceIntervalMs)
          : undefined;
      if (reannounceIntervalMs !== undefined) {
        let nextReannounceIntervalMs = reannounceIntervalMs;
        const scheduleReannounce = () => {
          pending.reannounceTimer = setTimeout(() => {
            if (!active) {
              return;
            }
            sendClientRequest();
            nextReannounceIntervalMs = Math.min(
              nextReannounceIntervalMs * 2,
              MAX_CLIENT_REQUEST_REANNOUNCE_INTERVAL_MS,
            );
            scheduleReannounce();
          }, nextReannounceIntervalMs);
        };
        scheduleReannounce();
      }
    });
  }

  resolve(id: ZCodeProtocolRequestId, result: unknown): void {
    const key = String(id);
    const pending = this.pending.get(key);
    if (!pending) {
      return;
    }
    this.cleanup(pending);
    try {
      pending.resolve(pending.resultSchema.parse(result));
    } catch (error) {
      pending.reject(
        error instanceof Error ? error : new Error(`Invalid response: ${pending.method}`),
      );
    }
  }

  reject(id: ZCodeProtocolRequestId, error: Error): void {
    const key = String(id);
    const pending = this.pending.get(key);
    if (!pending) {
      return;
    }
    this.cleanup(pending);
    pending.reject(error);
  }

  private cleanup<T>(pending: PendingClientRequest<T>): void {
    if (pending.timeout) {
      clearTimeout(pending.timeout);
    }
    if (pending.reannounceTimer) {
      clearTimeout(pending.reannounceTimer);
    }
    if (pending.abortHandler) {
      pending.signal?.removeEventListener("abort", pending.abortHandler);
    }
    for (const requestKey of pending.requestKeys) {
      this.pending.delete(requestKey);
    }
    pending.requestKeys.clear();
  }
}
