import { afterEach, expect, it, vi } from "vitest";
import {
  BufferWriter,
  Emitter,
  Event,
  SocketProtocol,
  VSBuffer,
  serialize,
  type MessagePortPayload,
} from "@zcode/rpc";
import { connectViaProtocol, connectViaWebSocket } from "./websocket.js";
import { connectViaMessagePort, createMessagePortServiceConnection } from "./messageport.js";

function frame(header: unknown[], body: unknown): VSBuffer {
  const writer = new BufferWriter();
  serialize(writer, header);
  serialize(writer, body);
  return writer.buffer;
}
const failure = { name: "SecretError", message: "credential-secret", stack: ["credential-secret"] };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("protocol factory delivers EventError to injected logger in production without bodies", () => {
  vi.stubEnv("NODE_ENV", "production");
  const incoming = new Emitter<VSBuffer>();
  const logger = vi.fn();
  const services = connectViaProtocol({ onMessage: incoming.event, send() {} }, { logger });
  incoming.fire(frame([200], {}));
  services.fileWatcherService.onDynamicChange("watcher-secret")(() => {});
  incoming.fire(frame([205, 0], failure));
  expect(logger).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(logger.mock.calls)).not.toContain("secret");
  incoming.dispose();
});

it.each(["connection", "accessor"])("MessagePort %s factory forwards logger", (kind) => {
  vi.stubEnv("NODE_ENV", "production");
  let listener: ((e: { data: MessagePortPayload }) => void) | undefined;
  const port = {
    addEventListener: (_type: string, fn: typeof listener) => {
      listener = fn;
    },
    removeEventListener() {},
    postMessage() {},
    start() {},
    close() {},
  } as unknown as MessagePort;
  const logger = vi.fn();
  const connection =
    kind === "connection" ? createMessagePortServiceConnection(port, { logger }) : undefined;
  const services = connection?.services ?? connectViaMessagePort(port, { logger });
  listener?.({ data: frame([200], {}).buffer });
  services.fileWatcherService.onDynamicChange("watcher-secret")(() => {});
  listener?.({ data: frame([205, 0], failure).buffer });
  expect(logger).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(logger.mock.calls)).not.toContain("secret");
  connection?.dispose();
});

it("WebSocket factory forwards logger through SocketProtocol, preserving lifecycle callbacks", async () => {
  vi.stubEnv("NODE_ENV", "production");
  const listeners = new Map<string, ((event: any) => void)[]>();
  const emit = (type: string, event: unknown) =>
    listeners.get(type)?.forEach((listener) => listener(event));
  class Socket {
    static OPEN = 1;
    readyState = 1;
    binaryType = "";
    addEventListener(type: string, listener: (event: any) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    }
    send() {}
    close() {}
  }
  vi.stubGlobal("WebSocket", Socket);
  const logger = vi.fn();
  const onOpenSocket = vi.fn();
  const onClose = vi.fn();
  const pending = connectViaWebSocket("ws://example.invalid/?token=token-secret", {
    logger,
    onOpenSocket,
    onClose,
  });
  emit("open", {});
  const services = await pending;
  const peer = new SocketProtocol({
    onData: Event.None,
    onClose: Event.None,
    onEnd: Event.None,
    write: (b) =>
      emit("message", {
        data: b.buffer.buffer.slice(b.buffer.byteOffset, b.buffer.byteOffset + b.byteLength),
      }),
    end() {},
    drain: async () => {},
    dispose() {},
  });
  peer.send(frame([200], {}));
  services.fileWatcherService.onDynamicChange("watcher-secret")(() => {});
  peer.send(frame([205, 0], failure));
  expect(logger).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(logger.mock.calls)).not.toContain("secret");
  expect(onOpenSocket).toHaveBeenCalledTimes(1);
  emit("close", { code: 1000, reason: "", wasClean: true });
  expect(onClose).toHaveBeenCalledWith({ code: 1000, reason: "", wasClean: true });
  peer.dispose();
});
