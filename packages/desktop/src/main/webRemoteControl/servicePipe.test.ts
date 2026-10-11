import { describe, expect, it, vi } from "vitest";
import {
  ChannelClient,
  ChannelServer,
  Emitter,
  MessagePortProtocol,
  ProxyChannel,
  VSBuffer,
  type IChannel,
  type IMessagePassingProtocol,
  type MessagePortLike,
  type MessagePortPayload,
} from "@zcode/rpc";
import { encodeWebRemoteControlRpcFrames, WebRemoteControlRpcAssembler } from "@zcode/shared";
import { createWebRemoteControlServicePipe } from "./servicePipe.js";

/**
 * servicePipe 回归测试：证明「手机 → Host」是真实的一条 RPC 链路。
 *
 * 拓扑与线上一致（只是把 WS 换成进程内直连）：
 *
 *   Host ChannelServer ── MessagePortProtocol(serverPort) ──┐
 *                                                           │ fake port pair
 *   （main）servicePipe ◀──── hostPort ◀────────────────────┘
 *        │  sendToMobile: 编码分片 → 装配器（手机接收侧）
 *        ▼
 *   手机侧 IMessagePassingProtocol ── ChannelClient / ProxyChannel.toService
 *
 * 关键回归点：以前 main 也建了一个 ChannelClient，链路两端都是客户端、没有服务端，
 * 手机侧永远收不到 Initialize，调用永远不 settle。这里用真实 ChannelServer 作对端，
 * 只要转发断了就会超时失败。
 */

interface StubServiceShape {
  echo(value: string): Promise<string>;
  repeat(value: string): Promise<string>;
  onDidPing(listener: (value: string) => void): { dispose(): void };
}

function toJsonSafe(payload: MessagePortPayload | Uint8Array): unknown {
  if (payload instanceof Uint8Array) {
    return { __zcodeBytes: Buffer.from(payload).toString("base64") };
  }
  return payload;
}

function jsonSafeToPortPayload(value: unknown): Uint8Array {
  if (value && typeof value === "object" && "__zcodeBytes" in (value as object)) {
    const base64 = (value as { __zcodeBytes?: unknown }).__zcodeBytes;
    if (typeof base64 === "string") return new Uint8Array(Buffer.from(base64, "base64"));
  }
  throw new Error("unexpected non-binary rpc payload in servicePipe test");
}

type PortListener = (event: { data: MessagePortPayload }) => void;

/** 内存 MessagePort 对：postMessage 异步投递到对端监听者，模拟 MessagePort 的消息边界。 */
function createFakePortPair(): { a: MessagePortLike; b: MessagePortLike } {
  const listenersA = new Set<PortListener>();
  const listenersB = new Set<PortListener>();
  const make = (own: Set<PortListener>, peer: Set<PortListener>): MessagePortLike => ({
    addEventListener(_type: "message", listener: PortListener) {
      own.add(listener);
    },
    removeEventListener(_type: "message", listener: PortListener) {
      own.delete(listener);
    },
    postMessage(data: MessagePortPayload) {
      setTimeout(() => {
        // 投递时再取快照：真实 MessagePort 的事件只送给“触发时已注册”的监听者。
        const recipients = Array.from(peer);
        for (const listener of recipients) listener({ data });
      }, 0);
    },
    start() {},
    close() {
      own.clear();
    },
  });
  return { a: make(listenersA, listenersB), b: make(listenersB, listenersA) };
}

function createHarness() {
  // a = Host 进程侧的 port；b = main 侧的 Host port。
  const { a: serverPort, b: hostPort } = createFakePortPair();

  const pingEmitter = new Emitter<string>();
  const pingSubscribed = { value: false };
  const stub = {
    echo: async (value: string) => `echo:${value}`,
    repeat: async (value: string) => value,
    // 记录 Host 侧是否真的建立订阅；EventListen 是异步到达的，用它消除竞态。
    onDidPing: (listener: (value: string) => void) => {
      pingSubscribed.value = true;
      return pingEmitter.event(listener);
    },
  };
  const serverProtocol = new MessagePortProtocol(serverPort);
  const server = new ChannelServer(serverProtocol, "test-ctx");
  server.registerChannel("test-channel", ProxyChannel.fromService(stub));

  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const desktopSeq = { value: 0 };
  const mobileSeq = { value: 0 };
  const mainToMobileAssembler = new WebRemoteControlRpcAssembler();
  const mobileToMainAssembler = new WebRemoteControlRpcAssembler();
  const mobileMessageEmitter = new Emitter<VSBuffer>();

  const pipe = createWebRemoteControlServicePipe({
    hostPort,
    attachmentId: "attachment-test",
    logger,
    // 桌面 → 手机：走真实的分片 + 装配层，不是裸转发。
    sendToMobile(payload) {
      desktopSeq.value += 1;
      const frames = encodeWebRemoteControlRpcFrames(toJsonSafe(payload), {
        streamId: "desktop-test",
        seq: desktopSeq.value,
      });
      for (const frame of frames) {
        for (const event of mainToMobileAssembler.push(frame)) {
          if (event.kind === "message") {
            mobileMessageEmitter.fire(VSBuffer.wrap(jsonSafeToPortPayload(event.message)));
          }
        }
      }
      return true;
    },
  });

  const mobileProtocol: IMessagePassingProtocol = {
    send(buffer) {
      mobileSeq.value += 1;
      const frames = encodeWebRemoteControlRpcFrames(toJsonSafe(buffer.buffer), {
        streamId: "mobile-test",
        seq: mobileSeq.value,
      });
      for (const frame of frames) {
        for (const event of mobileToMainAssembler.push(frame)) {
          if (event.kind === "message") {
            pipe.acceptMobileMessage(jsonSafeToPortPayload(event.message));
          }
        }
      }
    },
    onMessage: mobileMessageEmitter.event,
  };

  const client = new ChannelClient(mobileProtocol);
  const channel = client.getChannel<IChannel>("test-channel");
  const service = ProxyChannel.toService<StubServiceShape>(channel);

  return {
    server,
    serverProtocol,
    client,
    pipe,
    service,
    stub,
    pingEmitter,
    pingSubscribed,
    logger,
    dispose() {
      server.dispose();
      serverProtocol.disconnect();
      client.dispose();
      pipe.dispose();
    },
  };
}

describe("createWebRemoteControlServicePipe", () => {
  it("手机 ChannelClient 能穿过 pipe 收到 Host ChannelServer 的 Initialize", async () => {
    const harness = createHarness();
    const initialized = new Promise<void>((resolve) => {
      harness.client.onDidInitialize(() => resolve());
    });
    await initialized;
    harness.dispose();
  });

  it("手机调用 Host 服务：异步方法返回正确结果", async () => {
    const harness = createHarness();
    const result = await harness.service.echo("hello");
    expect(result).toBe("echo:hello");
    harness.dispose();
  });

  it("Host → 手机：服务端主动 push 一次事件", async () => {
    const harness = createHarness();
    const received: string[] = [];
    const disposable = harness.service.onDidPing((value) => received.push(value));
    // 先确保 EventListen 已到 Host（订阅已建立），再触发事件。
    await vi.waitFor(() => {
      expect(harness.pingSubscribed.value).toBe(true);
    });
    harness.pingEmitter.fire("ping-1");
    await vi.waitFor(() => {
      expect(received).toEqual(["ping-1"]);
    });
    disposable.dispose();
    harness.dispose();
  });

  it("大于单帧上限的载荷在分片/装配层往返后逐字节一致", async () => {
    const harness = createHarness();
    // 900KB 字符串 base64 后 > 1MB（maxFrameBytes），会触发多片往返。
    const large = "x".repeat(900_000);
    const result = await harness.service.repeat(large);
    expect(result).toBe(large);
    harness.dispose();
  });

  it("Host 消息落地失败时只 warn 一次（连续两条仍只一条）", async () => {
    const harness = createHarness();
    const failing = createWebRemoteControlServicePipe({
      hostPort: {
        addEventListener: (_type, listener) => {
          // 连续投递两条，但手机未挂载：只应留下首次 warn。
          listener({ data: new Uint8Array([1, 2, 3]) });
          listener({ data: new Uint8Array([4, 5, 6]) });
        },
        removeEventListener: () => {},
        postMessage: () => {},
        start: () => {},
        close: () => {},
      },
      sendToMobile: () => false,
      attachmentId: "attachment-drop",
      logger: harness.logger,
    });
    expect(harness.logger.warn).toHaveBeenCalledTimes(1);
    failing.dispose();
    harness.dispose();
  });
});
