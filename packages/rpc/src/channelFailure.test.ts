import { afterEach, describe, expect, it, vi } from "vitest";
import { VSBuffer } from "./buffer.js";
import { ChannelClient } from "./channelClient.js";
import { ChannelServer } from "./channelServer.js";
import type { IChannel, IServerChannel } from "./channels.shared.js";
import { Emitter, Event } from "./foundation.js";
import { BufferReader, BufferWriter, deserialize, serialize } from "./serialization.js";

/** RequestType.Promise / EventListen 与 ResponseType.PromiseSuccess / EventFire 的线上编号。 */
const PROMISE_REQUEST = 100;
const EVENT_LISTEN_REQUEST = 102;
const PROMISE_SUCCESS_RESPONSE = 201;
const EVENT_FIRE_RESPONSE = 204;
const EVENT_ERROR_RESPONSE = 205;

afterEach(() => vi.useRealTimers());

interface Harness {
  client: ChannelClient;
  server: ChannelServer<string>;
  logs: { message: string; args: unknown[] }[];
  serverLogs: string[];
  /** 客户端发送失败的帧（含 body 解码异常）会被记录在这里，用于断言宿主不崩。 */
  serverErrors: unknown[];
  clientErrors: unknown[];
  clientSentHeaders: unknown[][];
  serverSentHeaders: unknown[][];
  emitToClient(header: unknown[], body?: unknown): void;
  dispose(): void;
}

function encodeFrame(header: unknown[], body?: unknown): VSBuffer {
  const writer = new BufferWriter();
  serialize(writer, header);
  serialize(writer, body);
  return writer.buffer;
}

function readHeader(buffer: VSBuffer): unknown[] {
  return deserialize(new BufferReader(buffer)) as unknown[];
}

/** 只读私有字段用于泄漏断言，避免为测试新增生产接口。 */
function internals(
  target: object,
): Record<string, { size?: number; has?: (id: number) => boolean }> {
  return target as unknown as Record<string, { size?: number; has?: (id: number) => boolean }>;
}

function createHarness(options: { timeoutDelay?: number } = {}): Harness {
  const toClient = new Emitter<VSBuffer>();
  const toServer = new Emitter<VSBuffer>();
  const logs: { message: string; args: unknown[] }[] = [];
  const serverLogs: string[] = [];
  const serverErrors: unknown[] = [];
  const clientErrors: unknown[] = [];
  const clientSentHeaders: unknown[][] = [];
  const serverSentHeaders: unknown[][] = [];

  // client 必须早于 server 构造，否则 Initialize 帧在 client 订阅前就发出去了。
  const client = new ChannelClient(
    {
      onMessage: toClient.event,
      send: (buffer) => {
        clientSentHeaders.push(readHeader(buffer));
        try {
          toServer.fire(buffer);
        } catch (error) {
          serverErrors.push(error);
        }
      },
    },
    { logger: (message, ...args) => logs.push({ message, args }) },
  );
  const server = new ChannelServer(
    {
      onMessage: toServer.event,
      send: (buffer) => {
        serverSentHeaders.push(readHeader(buffer));
        try {
          toClient.fire(buffer);
        } catch (error) {
          clientErrors.push(error);
        }
      },
    },
    "host",
    options.timeoutDelay ?? 1000,
    false,
    {},
    { logger: (message) => serverLogs.push(message) },
  );

  return {
    client,
    server,
    logs,
    serverLogs,
    serverErrors,
    clientErrors,
    clientSentHeaders,
    serverSentHeaders,
    emitToClient: (header, body) => toClient.fire(encodeFrame(header, body)),
    dispose: () => {
      client.dispose();
      server.dispose();
      toClient.dispose();
      toServer.dispose();
    },
  };
}

function throwingChannel(message = "terminal already closed"): IServerChannel<string> {
  return {
    call: async <T>() => undefined as T,
    listen: () => {
      const error = new Error(message);
      error.name = "TerminalClosedError";
      throw error;
    },
  };
}

describe("RPC 事件订阅失败帧", () => {
  it("listen 同步抛错时回失败帧，不逃逸出 Host 也不进入正常事件流", () => {
    const harness = createHarness();
    harness.server.registerChannel("terminal", throwingChannel());

    const received: unknown[] = [];
    const subscription = harness.client.getChannel<IChannel>("terminal").listen("onData")((event) =>
      received.push(event),
    );

    // 失败没有被抛到 protocol 分发层（否则 Host 会崩）。
    expect(harness.serverErrors).toEqual([]);
    expect(harness.clientErrors).toEqual([]);
    expect(harness.clientSentHeaders.at(-1)?.[0]).toBe(EVENT_LISTEN_REQUEST);
    expect(harness.serverSentHeaders.at(-1)?.[0]).toBe(EVENT_ERROR_RESPONSE);
    // 失败帧不会当成业务事件交给订阅者。
    expect(received).toEqual([]);
    // 只记录路由元数据；远端错误可能包含参数和凭据，不能原样进入生产日志。
    expect(harness.logs).toHaveLength(1);
    expect(harness.logs[0].message).toContain("terminal.onData");
    expect(harness.logs[0].args).toEqual([{ requestId: 0 }]);
    expect(JSON.stringify(harness.logs)).not.toContain("terminal already closed");
    expect(harness.serverLogs).toHaveLength(1);
    // 两端都不留活动订阅。
    expect(internals(harness.client).handlers.size).toBe(0);
    expect(internals(harness.client).activeRequests.size).toBe(0);
    expect(internals(harness.server).activeRequests.size).toBe(0);

    subscription.dispose();
    harness.dispose();
  });

  it("失败帧之后迟到的 EventFire 被丢弃", () => {
    const harness = createHarness();
    harness.server.registerChannel("terminal", throwingChannel());

    const received: unknown[] = [];
    harness.client.getChannel<IChannel>("terminal").listen("onData")((event) =>
      received.push(event),
    );
    const failedId = harness.clientSentHeaders.at(-1)?.[1] as number;

    harness.emitToClient([EVENT_FIRE_RESPONSE, failedId], { line: "迟到数据" });
    expect(received).toEqual([]);

    harness.dispose();
  });

  it.each([new Error("subscribe failed"), "subscribe failed"])(
    "订阅初始化函数同步拒绝 %s 时也回独立失败帧",
    (reason) => {
      const harness = createHarness();
      harness.server.registerChannel("terminal", {
        call: async <T>() => undefined as T,
        listen: () => () => {
          throw reason;
        },
      });
      const received: unknown[] = [];
      harness.client.getChannel<IChannel>("terminal").listen("onData")((data) =>
        received.push(data),
      );
      expect(harness.serverSentHeaders.at(-1)?.[0]).toBe(EVENT_ERROR_RESPONSE);
      expect(harness.serverErrors).toEqual([]);
      expect(harness.clientErrors).toEqual([]);
      expect(received).toEqual([]);
      expect(internals(harness.client).handlers.size).toBe(0);
      expect(internals(harness.client).activeRequests.size).toBe(0);
      expect(internals(harness.server).activeRequests.size).toBe(0);
      expect(harness.logs[0].args[0]).toEqual({ requestId: 0 });
      expect(JSON.stringify(harness.logs)).not.toContain("subscribe failed");
      harness.dispose();
    },
  );

  it("成功订阅仍交付正常事件", () => {
    const harness = createHarness();
    const emitters = new Map<string, Emitter<string>>();
    harness.server.registerChannel("terminal", {
      call: async <T>() => undefined as T,
      listen: <T>(_ctx: string, _event: string, arg?: unknown) => {
        const id = String(arg);
        const emitter = new Emitter<string>();
        emitters.set(id, emitter);
        return emitter.event as Event<T>;
      },
    });

    const received: unknown[] = [];
    harness.client.getChannel<IChannel>("terminal").listen("onData", "session-1")((event) =>
      received.push(event),
    );

    emitters.get("session-1")?.fire("真实事件");
    expect(received).toEqual(["真实事件"]);

    emitters.forEach((emitter) => emitter.dispose());
    harness.dispose();
  });
});

describe("RPC 未知通道", () => {
  it("EventListen 超时回失败帧并清理 pending，迟到注册不重放", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ timeoutDelay: 5 });
    const received: unknown[] = [];
    harness.client.getChannel<IChannel>("ghost").listen("onData")((event) => received.push(event));

    expect(internals(harness.server).pendingRequests.size).toBe(1);
    expect(harness.logs).toEqual([]);
    await vi.advanceTimersByTimeAsync(5);
    expect(harness.serverSentHeaders.at(-1)?.[0]).toBe(EVENT_ERROR_RESPONSE);
    expect(received).toEqual([]);
    expect(harness.logs).toHaveLength(1);
    expect(harness.logs[0].message).toContain("ghost.onData");
    expect(internals(harness.client).handlers.size).toBe(0);
    expect(internals(harness.client).activeRequests.size).toBe(0);
    expect(internals(harness.server).pendingRequests.size).toBe(0);
    const listen = vi.fn(() => Event.None);
    harness.server.registerChannel("ghost", { call: async <T>() => undefined as T, listen });
    await vi.runAllTimersAsync();
    expect(listen).not.toHaveBeenCalled();
    expect(harness.serverErrors).toEqual([]);
    expect(harness.clientErrors).toEqual([]);

    harness.dispose();
  });

  it("EventListen 保留迟注册兼容，只订阅一次并交付事件", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ timeoutDelay: 100 });
    const events = new Emitter<string>();
    const received: unknown[] = [];
    const subscription = harness.client.getChannel("late").listen("onData")((e) =>
      received.push(e),
    );
    const listen = vi.fn();
    harness.server.registerChannel("late", {
      call: async <T>() => undefined as T,
      listen: <T>() => {
        listen();
        return events.event as Event<T>;
      },
    });
    await vi.runAllTimersAsync();
    events.fire("live");
    expect(received).toEqual(["live"]);
    expect(listen).toHaveBeenCalledTimes(1);
    expect(harness.logs).toEqual([]);
    expect(harness.serverLogs).toEqual([]);
    expect(internals(harness.server).pendingRequests.size).toBe(0);
    subscription.dispose();
    expect(internals(harness.server).activeRequests.size).toBe(0);
    events.dispose();
    harness.dispose();
  });

  it("注册前取消订阅清理 pending/timer，不迟到订阅或超时回帧", async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    const subscription = harness.client.getChannel("late").listen("onData")(() => {});
    subscription.dispose();
    expect(internals(harness.server).pendingRequests.size).toBe(0);
    const listen = vi.fn(() => Event.None);
    harness.server.registerChannel("late", { call: async <T>() => undefined as T, listen });
    await vi.runAllTimersAsync();
    expect(listen).not.toHaveBeenCalled();
    expect(harness.logs).toEqual([]);
    expect(harness.serverLogs).toEqual([]);
    harness.dispose();
  });

  it("Promise 保留延迟注册兼容，注册后执行一次且清除计时器", async () => {
    vi.useFakeTimers();
    const harness = createHarness({ timeoutDelay: 100 });
    const result = harness.client.getChannel<IChannel>("late").call("echo", { value: 42 });
    const call = vi.fn();
    harness.server.registerChannel("late", {
      call: async <T>(_ctx: string, _command: string, arg?: unknown) => {
        call();
        return arg as T;
      },
      listen: () => Event.None,
    });
    await vi.runAllTimersAsync();
    expect(await result).toEqual({ value: 42 });
    expect(call).toHaveBeenCalledTimes(1);
    expect(internals(harness.server).pendingRequests.size).toBe(0);
    expect(harness.serverLogs).toEqual([]);
    harness.dispose();
  });

  it("Promise 请求超时仍回 PromiseError（既有行为）", async () => {
    const harness = createHarness({ timeoutDelay: 5 });
    vi.useFakeTimers();
    const result = harness.client
      .getChannel<IChannel>("ghost")
      .call("doIt")
      .catch((reason: unknown) => reason);
    await vi.runAllTimersAsync();
    const error = (await result) as Error;

    expect(error).toBeInstanceOf(Error);
    expect(harness.serverLogs).toEqual(["Unknown channel: ghost"]);
    expect(error.name).toBe("Unknown channel");
    expect(error.message).toContain("timed out after 5ms");
    expect(internals(harness.server).pendingRequests.size).toBe(0);
    const call = vi.fn();
    harness.server.registerChannel("ghost", {
      call: async <T>() => {
        call();
        return undefined as T;
      },
      listen: () => Event.None,
    });
    await vi.runAllTimersAsync();
    expect(call).not.toHaveBeenCalled();

    harness.dispose();
  });
});

it("server 终结会清除未知 Promise 的 pending 与超时帧", async () => {
  vi.useFakeTimers();
  const harness = createHarness({ timeoutDelay: 5 });
  const result = harness.client
    .getChannel<IChannel>("ghost")
    .call("doIt")
    .catch((reason: unknown) => reason);
  expect(internals(harness.server).pendingRequests.size).toBe(1);
  const sentCount = harness.serverSentHeaders.length;
  harness.server.dispose();
  expect(internals(harness.server).pendingRequests.size).toBe(0);
  await vi.runAllTimersAsync();
  expect(harness.serverSentHeaders).toHaveLength(sentCount);
  harness.dispose();
  expect(await result).toBeInstanceOf(Error);
});

describe("RPC 帧解码路由", () => {
  it("未知类型不读取不可解码的 body", () => {
    const incoming = new Emitter<VSBuffer>();
    const protocol = { onMessage: incoming.event, send: () => {} };
    const client = new ChannelClient(protocol);
    const server = new ChannelServer(protocol, "host");
    const writer = new BufferWriter();
    serialize(writer, [999]);
    // Object 标签 + 单字节长度 + 非法 JSON；只有错误读取 body 才会抛错。
    const frame = VSBuffer.concat([writer.buffer, VSBuffer.wrap(Uint8Array.from([5, 1, 123]))]);
    expect(() => incoming.fire(frame)).not.toThrow();
    client.dispose();
    server.dispose();
    incoming.dispose();
  });
  const REQUEST_MARKER = "__rpc_request_body_marker__";
  const RESPONSE_MARKER = "__rpc_response_body_marker__";

  it("双向 protocol 上请求/响应 body 各只解码一次", async () => {
    const originalParse = JSON.parse;
    let requestParses = 0;
    let responseParses = 0;
    JSON.parse = ((text: string, reviver?: (key: string, value: unknown) => unknown) => {
      if (typeof text === "string") {
        if (text.includes(REQUEST_MARKER)) requestParses += 1;
        if (text.includes(RESPONSE_MARKER)) responseParses += 1;
      }
      return originalParse(text, reviver);
    }) as typeof JSON.parse;

    const toLocal = new Emitter<VSBuffer>();
    const sent: VSBuffer[] = [];
    const client = new ChannelClient({
      onMessage: toLocal.event,
      send: (buffer) => sent.push(buffer),
    });
    // 同一个 protocol 上同时挂 client 与 server：对端请求会进 client.onBuffer，
    // 对端响应会进 server.onRawMessage，两侧都必须只解码头。
    const server = new ChannelServer(
      { onMessage: toLocal.event, send: (buffer) => sent.push(buffer) },
      "host",
    );
    server.registerChannel("echo", {
      call: async <T>() => ({ marker: RESPONSE_MARKER }) as T,
      listen: () => Event.None,
    });

    try {
      // 本测试的 send 只收集帧；显式模拟对端 Initialize，不能依赖本端 server 的出站帧。
      toLocal.fire(encodeFrame([200], {}));
      toLocal.fire(encodeFrame([PROMISE_REQUEST, 7, "echo", "call"], { marker: REQUEST_MARKER }));
      await Promise.resolve();
      expect(requestParses).toBe(1);

      const result = client.getChannel<IChannel>("echo").call("read");
      const responseId = (readHeader(sent.at(-1) as VSBuffer)[1] as number) ?? 0;
      toLocal.fire(
        encodeFrame([PROMISE_SUCCESS_RESPONSE, responseId], { marker: RESPONSE_MARKER }),
      );
      expect(await result).toEqual({ marker: RESPONSE_MARKER });
      expect(responseParses).toBe(1);
    } finally {
      JSON.parse = originalParse;
      client.dispose();
      server.dispose();
      toLocal.dispose();
    }
  });
});

describe("RPC 错误字段", () => {
  it("profileId 透传到客户端 rejection", async () => {
    const harness = createHarness();
    harness.server.registerChannel("profile", {
      call: async () => {
        const error = new Error("需要安装远端 profile") as Error & Record<string, unknown>;
        error.name = "RemoteProfilePendingError";
        error.code = "E_PROFILE_PENDING";
        error.profileId = "profile-42";
        throw error;
      },
      listen: () => Event.None,
    });

    const error = (await harness.client
      .getChannel<IChannel>("profile")
      .call("ensure")
      .catch((reason: unknown) => reason)) as Error & Record<string, unknown>;

    expect(error.name).toBe("RemoteProfilePendingError");
    expect(error.code).toBe("E_PROFILE_PENDING");
    expect(error.profileId).toBe("profile-42");

    harness.dispose();
  });
});
