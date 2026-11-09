import { VSBuffer } from "./buffer.js";
import { type IDisposable, CancellationTokenSource, toDisposable } from "./foundation.js";
import { BufferReader, BufferWriter, deserialize, serialize } from "./serialization.js";
import type { IMessagePassingProtocol } from "./protocol.js";
import type { RPCOptions } from "./logging-middleware.js";
import {
  type IChannelServer,
  type IRawResponse,
  type IServerChannel,
  RequestType,
  ResponseType,
} from "./channels.shared.js";

export class ChannelServer<TContext = string> implements IChannelServer<TContext>, IDisposable {
  private channels = new Map<string, IServerChannel<TContext>>();
  private activeRequests = new Map<number, IDisposable>();
  private pendingRequests = new Map<
    string,
    { request: any; timer: ReturnType<typeof setTimeout> }[]
  >();
  private protocolListener: IDisposable | null;

  constructor(
    private protocol: IMessagePassingProtocol,
    private ctx: TContext,
    private timeoutDelay = 1000,
    private deferInit = false,
    private readonly capabilities: Readonly<Record<string, true>> = {},
    private readonly options: RPCOptions = {},
  ) {
    this.protocolListener = this.protocol.onMessage((msg) => this.onRawMessage(msg));
    if (!this.deferInit) {
      this.sendResponse({ type: ResponseType.Initialize });
    }
  }

  ready(): void {
    this.sendResponse({ type: ResponseType.Initialize });
  }

  registerChannel(channelName: string, channel: IServerChannel<TContext>): void {
    this.channels.set(channelName, channel);
    setTimeout(() => this.flushPendingRequests(channelName), 0);
  }

  private sendResponse(response: IRawResponse): void {
    switch (response.type) {
      case ResponseType.Initialize:
        this.send([response.type], this.capabilities);
        return;
      case ResponseType.PromiseSuccess:
      case ResponseType.PromiseError:
      case ResponseType.EventFire:
      case ResponseType.EventError:
      case ResponseType.PromiseErrorObj:
        this.send([response.type, response.id], response.data);
        return;
    }
  }

  private send(header: any, body: any = undefined): void {
    const writer = new BufferWriter();
    serialize(writer, header);
    serialize(writer, body);
    try {
      this.protocol.send(writer.buffer);
    } catch {
      /* noop */
    }
  }

  private onRawMessage(message: VSBuffer): void {
    // Bug 原因：双向 protocol 的响应也经过此处；先按头路由，只解码本端负责的请求 body。
    const reader = new BufferReader(message);
    const header = deserialize(reader);
    const type = header[0] as RequestType;

    switch (type) {
      case RequestType.Promise:
        this.onPromise({
          type,
          id: header[1],
          channelName: header[2],
          name: header[3],
          arg: deserialize(reader),
        });
        return;
      case RequestType.EventListen:
        this.onEventListen({
          type,
          id: header[1],
          channelName: header[2],
          name: header[3],
          arg: deserialize(reader),
        });
        return;
      case RequestType.PromiseCancel:
      case RequestType.EventDispose:
        this.disposeActiveRequest(header[1]);
        return;
    }
  }

  private onPromise(request: {
    type: RequestType.Promise;
    id: number;
    channelName: string;
    name: string;
    arg: any;
  }): void {
    const channel = this.channels.get(request.channelName);
    if (!channel) {
      this.collectPendingRequest(request);
      return;
    }

    const cts = new CancellationTokenSource();
    let promise: Promise<any>;

    try {
      promise = channel.call(this.ctx, request.name, request.arg, cts.token);
    } catch (error) {
      promise = Promise.reject(error);
    }

    const disposable = toDisposable(() => cts.cancel());
    this.activeRequests.set(request.id, disposable);

    promise
      .then(
        (data) => {
          this.sendResponse({
            id: request.id,
            data,
            type: ResponseType.PromiseSuccess,
          });
        },
        (error) => {
          if (error instanceof Error) {
            const rpcErrorPayload: {
              message: string;
              name: string;
              stack: string[] | undefined;
              code?: unknown;
              kind?: unknown;
              status?: unknown;
              retryAfterMs?: unknown;
              data?: unknown;
              detail?: unknown;
              details?: unknown;
              taskId?: unknown;
              traceId?: unknown;
              profileId?: unknown;
            } = {
              message: error.message,
              name: error.name,
              stack: error.stack ? error.stack.split("\n") : undefined,
            };
            const errorRecord = error as Error & Record<string, unknown>;
            const passthroughKeys = [
              "code",
              "kind",
              "status",
              "retryAfterMs",
              "data",
              "detail",
              "details",
              "taskId",
              "traceId",
              // Bug 原因：远端等待点用 profileId 标识操作线路，白名单遗漏会让客户端丢失恢复目标。
              "profileId",
            ] as const;
            for (const key of passthroughKeys) {
              const value = errorRecord[key];
              if (value !== undefined) {
                rpcErrorPayload[key] = value;
              }
            }
            this.sendResponse({
              id: request.id,
              data: rpcErrorPayload,
              type: ResponseType.PromiseError,
            });
            return;
          }

          this.sendResponse({
            id: request.id,
            data: error,
            type: ResponseType.PromiseErrorObj,
          });
        },
      )
      .finally(() => {
        disposable.dispose();
        this.activeRequests.delete(request.id);
      });
  }

  private onEventListen(request: {
    type: RequestType.EventListen;
    id: number;
    channelName: string;
    name: string;
    arg: any;
  }): void {
    try {
      const channel = this.channels.get(request.channelName);
      if (!channel) {
        // Initialize 可先于反向通道注册；沿用原 pending/超时兼容迟注册，不同步拒绝合法订阅。
        this.collectPendingRequest(request);
        return;
      }

      const disposable = channel.listen(
        this.ctx,
        request.name,
        request.arg,
      )((data) => {
        this.sendResponse({
          id: request.id,
          data,
          type: ResponseType.EventFire,
        });
      });
      this.activeRequests.set(request.id, disposable);
    } catch (error) {
      // Bug 原因：迟到订阅可能被已结束的资源同步拒绝，不能逃逸到协议分发并崩掉 Host。
      // 单独失败帧不会污染终端等业务事件流，也不会登记无法释放的活动订阅。
      // mobile/web 生产端可能关闭本地日志，服务端也必须保留诊断，但不记录原始错误。
      this.options.logger?.(
        `RPC event subscription failed: ${request.channelName}.${request.name}`,
        { requestId: request.id },
      );
      this.sendResponse({
        id: request.id,
        type: ResponseType.EventError,
        data: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof Error && error.stack ? { stack: error.stack.split("\n") } : {}),
        },
      });
    }
  }

  private disposeActiveRequest(id: number): void {
    // 注册前的取消同样是终态，不能让迟到注册复活订阅/调用或留下超时诊断。
    for (const [channelName, requests] of this.pendingRequests) {
      const index = requests.findIndex(({ request }) => request.id === id);
      if (index !== -1) {
        clearTimeout(requests[index].timer);
        requests.splice(index, 1);
        if (requests.length === 0) this.pendingRequests.delete(channelName);
        return;
      }
    }
    const disposable = this.activeRequests.get(id);
    if (!disposable) {
      return;
    }
    disposable.dispose();
    this.activeRequests.delete(id);
  }

  private collectPendingRequest(request: any): void {
    const pendingRequests = this.pendingRequests.get(request.channelName) ?? [];
    if (pendingRequests.length === 0) {
      this.pendingRequests.set(request.channelName, pendingRequests);
    }

    const timer = setTimeout(() => {
      // Bug 原因：超时回帧后旧请求仍留在 pending，迟到注册会重复执行已被拒绝的调用。
      pendingRequests.splice(
        pendingRequests.findIndex((pending) => pending.request === request),
        1,
      );
      if (pendingRequests.length === 0) {
        this.pendingRequests.delete(request.channelName);
      }
      this.options.logger?.(`Unknown channel: ${request.channelName}`, { requestId: request.id });
      this.sendResponse({
        id: request.id,
        data: {
          name: "Unknown channel",
          message: `Channel name '${request.channelName}' timed out after ${this.timeoutDelay}ms`,
          stack: undefined,
        },
        type:
          request.type === RequestType.EventListen
            ? ResponseType.EventError
            : ResponseType.PromiseError,
      });
    }, this.timeoutDelay);

    pendingRequests.push({ request, timer });
  }

  private flushPendingRequests(channelName: string): void {
    const requests = this.pendingRequests.get(channelName);
    if (!requests) {
      return;
    }

    for (const { request, timer } of requests) {
      clearTimeout(timer);
      switch (request.type) {
        case RequestType.Promise:
          this.onPromise(request);
          break;
        case RequestType.EventListen:
          this.onEventListen(request);
          break;
      }
    }
    this.pendingRequests.delete(channelName);
  }

  dispose(): void {
    this.protocolListener?.dispose();
    this.protocolListener = null;
    for (const disposable of this.activeRequests.values()) {
      disposable.dispose();
    }
    this.activeRequests.clear();
    // 连接终结后不能继续持有未知通道请求，或由计时器向已关闭的连接发送失败帧。
    for (const requests of this.pendingRequests.values()) {
      for (const { timer } of requests) clearTimeout(timer);
    }
    this.pendingRequests.clear();
  }
}
