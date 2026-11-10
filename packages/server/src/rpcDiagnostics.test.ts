import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { ChannelClient, Emitter, Event, SocketProtocol, VSBuffer } from "@zcode/rpc";
import { ServiceCollection } from "@zcode/services";
import { createStdioServer } from "./stdio.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it("production stdio diagnoses EventError and unknown channels via safe stderr, not stdout text", async () => {
  vi.useFakeTimers();
  vi.stubEnv("NODE_ENV", "production");
  const stdin = new PassThrough();
  vi.spyOn(process, "stdin", "get").mockReturnValue(stdin as unknown as typeof process.stdin);
  const outgoing = new Emitter<VSBuffer>();
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    // stdout 只能写协议字节，日志文本会破坏整个 stdio 连接。
    if (typeof chunk === "string") throw new Error("stdio stdout must contain only protocol bytes");
    outgoing.fire(VSBuffer.wrap(new Uint8Array(chunk)));
    return true;
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const info = vi.spyOn(console, "log").mockImplementation(() => {});
  const peer = new SocketProtocol({
    onData: outgoing.event,
    onClose: Event.None,
    onEnd: Event.None,
    write: (buffer) => {
      stdin.write(buffer.buffer);
    },
    end() {},
    drain: async () => {},
    dispose() {},
  });
  const client = new ChannelClient(peer);
  const services = new ServiceCollection().register(
    { channelName: "diagnostic" },
    {
      onDynamicData: (_arg: string) => {
        throw new Error("credential-secret");
      },
    },
  );
  const server = createStdioServer(services);
  try {
    const received = vi.fn();
    client.getChannel("diagnostic").listen("onDynamicData", "argument-secret")(received);
    client.getChannel("missing").listen("onData", "argument-secret")(received);
    const promise = client
      .getChannel("missing-call")
      .call("read", "argument-secret")
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await promise).toBeInstanceOf(Error);
    expect(received).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      "RPC event subscription failed: [omitted]",
      expect.any(Object),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      "Unknown channel: [omitted]",
      expect.any(Object),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(
      /secret|missing-call|diagnostic\.onDynamicData/,
    );
    expect(info).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalled();
  } finally {
    client.dispose();
    await server.stop();
    peer.dispose();
    outgoing.dispose();
  }
});
