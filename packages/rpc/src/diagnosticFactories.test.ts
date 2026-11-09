import { afterEach, expect, it, vi } from "vitest";
import { IPCClient, IPCServer } from "./ipc.js";
import { createQueuePair } from "./protocol.js";
import { Emitter, Event } from "./foundation.js";
import type { ClientConnectionEvent } from "./ipc.js";
import {
  RemoteAgentConnection,
  RemoteAuthorityResolverService,
  RemoteSocketFactoryService,
  ManagedRemoteConnection,
  RemoteConnectionType,
} from "./remote.js";
import { VSBuffer } from "./buffer.js";
import { BufferWriter, serialize } from "./serialization.js";
import { SocketProtocol } from "./protocol.js";

afterEach(() => vi.useRealTimers());

it("IPC factories forward diagnostics in both directions, without request/error secrets", async () => {
  vi.useFakeTimers();
  const connected = new Emitter<ClientConnectionEvent>();
  const disconnected = new Emitter<void>();
  const clientLogger = vi.fn();
  const serverLogger = vi.fn();
  const server = new IPCServer(connected.event, { logger: serverLogger });
  const [a, b] = createQueuePair();
  connected.fire({ protocol: b, onDidClientDisconnect: disconnected.event });
  const client = new IPCClient(a, "ctx-secret", { logger: clientLogger });
  server.registerChannel("fail", {
    call: async <T>() => undefined as T,
    listen: () => {
      throw new Error("credential-secret");
    },
  });
  await vi.advanceTimersByTimeAsync(10);
  client.getChannel("fail").listen("onData", "argument-secret")(() => {});
  server.getChannel("missing", () => true).listen("onData", "argument-secret")(() => {});
  const missingCall = client
    .getChannel("missing-call")
    .call("read", "argument-secret")
    .catch((error: unknown) => error);
  await vi.runAllTimersAsync();
  expect(await missingCall).toBeInstanceOf(Error);
  expect(serverLogger).toHaveBeenCalledWith("RPC event subscription failed: fail.onData", {
    requestId: 0,
  });
  expect(serverLogger).toHaveBeenCalledWith("Unknown channel: missing-call", { requestId: 1 });
  expect(clientLogger).toHaveBeenCalledWith("RPC event subscription failed: fail.onData", {
    requestId: 0,
  });
  expect(clientLogger).toHaveBeenCalledWith("Unknown channel: missing", { requestId: 0 });
  expect(serverLogger).toHaveBeenCalledWith("RPC event subscription failed: missing.onData", {
    requestId: 0,
  });
  const logs = JSON.stringify([clientLogger.mock.calls, serverLogger.mock.calls]);
  expect(logs).not.toMatch(/ctx-secret|credential-secret|argument-secret/);
  client.dispose();
  server.dispose();
});

it("RemoteAgentConnection forwards options through its real IPCClient", async () => {
  vi.useFakeTimers();
  const data = new Emitter<VSBuffer>();
  const socket = {
    onData: data.event,
    onClose: Event.None,
    onEnd: Event.None,
    write: vi.fn(),
    end() {},
    drain: async () => {},
    dispose() {},
  };
  const resolver = new RemoteAuthorityResolverService();
  resolver.registerResolver("test", {
    resolve: async () => ({
      authority: "test+host",
      connectTo: new ManagedRemoteConnection(1),
      connectionToken: "token-secret",
    }),
  });
  const sockets = new RemoteSocketFactoryService();
  sockets.register(RemoteConnectionType.Managed, {
    supports: () => true,
    connect: async () => socket,
  });
  const logger = vi.fn();
  const connection = new RemoteAgentConnection("test+host", resolver, sockets, { logger });
  const client = await connection.connect();
  // Feed real framed Initialize + EventError through PersistentProtocol.
  const peer = new SocketProtocol({ ...socket, write: (buffer) => data.fire(buffer) });
  const send = (header: unknown[], body: unknown) => {
    const w = new BufferWriter();
    serialize(w, header);
    serialize(w, body);
    peer.send(w.buffer);
  };
  send([200], {});
  client.getChannel("test").listen("onData", "argument-secret")(() => {});
  send([205, 0], { name: "Error", message: "credential-secret", stack: ["credential-secret"] });
  expect(logger).toHaveBeenCalledWith("RPC event subscription failed: test.onData", {
    requestId: 0,
  });
  expect(JSON.stringify(logger.mock.calls)).not.toMatch(/secret/);
  connection.dispose();
  peer.dispose();
  await vi.runAllTimersAsync();
});
