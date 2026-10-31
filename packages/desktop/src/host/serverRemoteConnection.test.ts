import { createServer as createHttpServer, type Server } from "node:http";
import { Socket } from "node:net";
import { Duplex } from "node:stream";
import { ChannelServer, Emitter, SocketProtocol, VSBuffer, type ISocket } from "@zcode/rpc";
import { IFileService, ServiceCollection } from "@zcode/services";
import type { RawData, WebSocket } from "ws";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import { createWindowRemoteConnectionRegistry } from "./windowRemoteConnectionRegistry.js";
import {
  connectServerRemote,
  connectServerRemoteOverDuplex,
  resolveServerRemoteEndpoints,
} from "./serverRemoteConnection.js";

const disposals: Array<() => Promise<void> | void> = [];

const INGRESS_TOKEN = "ingress-token-for-tests";
const SERVER_INFO = {
  serverId: "source-under-test",
  name: "Test Source",
  version: "3.16.2",
  protocolVersion: 1,
  authRequired: true,
  workspaces: [{ path: "/work" }],
  compatibility: {
    schemaVersion: 1,
    productVersion: "3.16.2",
    minCompatibleVersion: "3.15.1",
  },
  capabilities: {
    desktopContinuous: true,
    websocketRpc: true,
    virtualProjects: true,
  },
};

afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});

function wrapWebSocket(ws: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();
  ws.on("message", (raw: RawData) => {
    const data = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
    onData.fire(VSBuffer.wrap(new Uint8Array(data)));
  });
  ws.on("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  ws.on("error", () => {
    onClose.fire();
    onEnd.fire();
  });
  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer) {
      if (ws.readyState === ws.OPEN) ws.send(buffer.buffer);
    },
    end() {
      ws.close();
    },
    drain: () => Promise.resolve(),
    dispose() {
      ws.close();
    },
  };
}

const fileService = {
  readdir: (params: { path: string }) =>
    Promise.resolve([
      { name: "alpha", path: `${params.path}/alpha`, isDirectory: true },
      { name: "beta.txt", path: `${params.path}/beta.txt`, isDirectory: false },
    ]),
} as unknown as IFileService;

interface LoopbackSourceServer {
  port: number;
  requests: Array<{ method: string; url: string; authorization?: string }>;
  /** 已消费的 capability；第二次 upgrade 必须被拒绝。 */
  consumedCapabilities: Set<string>;
  /** 每个 capability 只能服务一次 WS upgrade。 */
  stop: () => Promise<void>;
}

/**
 * 真实 loopback Source：Bearer 鉴权的 info/capability + 单次 capability 的 /ws/host，
 * WS 上跑真实 ChannelServer（IFileService 走既有 RPC 代理）。
 */
async function startLoopbackSourceServer(
  options: { rejectCapability?: boolean; serverInfo?: typeof SERVER_INFO } = {},
): Promise<LoopbackSourceServer> {
  const serverInfo = options.serverInfo ?? SERVER_INFO;
  const requests: LoopbackSourceServer["requests"] = [];
  const consumedCapabilities = new Set<string>();
  const sockets = new Set<Socket>();
  let capabilityCounter = 0;

  const httpServer: Server = createHttpServer((req, res) => {
    const authorization = req.headers.authorization;
    requests.push({
      method: req.method ?? "",
      url: req.url ?? "",
      ...(authorization ? { authorization } : {}),
    });
    if (authorization !== `Bearer ${INGRESS_TOKEN}`) {
      res.statusCode = 401;
      res.end();
      return;
    }
    if (req.method === "GET" && req.url === "/api/server-info") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(serverInfo));
      return;
    }
    if (req.method === "POST" && req.url === "/api/rpc-host-capability") {
      if (options.rejectCapability) {
        res.statusCode = 403;
        res.end();
        return;
      }
      capabilityCounter += 1;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          capability: `capability-${capabilityCounter}`,
          expiresAt: Date.now() + 60_000,
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  httpServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  const webSocketServer = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (req, socket, head) => {
    const authorization = req.headers.authorization;
    const capability = req.headers["x-zcode-rpc-host-capability"];
    if (
      authorization !== `Bearer ${INGRESS_TOKEN}` ||
      typeof capability !== "string" ||
      consumedCapabilities.has(capability)
    ) {
      socket.destroy();
      return;
    }
    consumedCapabilities.add(capability);
    webSocketServer.handleUpgrade(req, socket, head, (webSocket) => {
      const protocol = new SocketProtocol(wrapWebSocket(webSocket));
      const channelServer = new ChannelServer(protocol, "loopback-source");
      new ServiceCollection()
        .register(IFileService, fileService)
        .exposeOnChannelServer(channelServer);
      webSocket.on("close", () => channelServer.dispose());
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("missing loopback port");

  const stop = async () => {
    for (const client of webSocketServer.clients) client.terminate();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };
  disposals.push(stop);

  return { port: address.port, requests, consumedCapabilities, stop };
}

/** 上层只拿到不透明 Duplex：不可依赖 net.Socket/TCP 专属 API。 */
async function connectOpaqueDuplex(port: number): Promise<Duplex> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const connection = new Socket();
    connection.once("error", reject);
    connection.connect(port, "127.0.0.1", () => {
      connection.off("error", reject);
      resolve(connection);
    });
  });
  const duplex = new Duplex({
    read() {
      socket.resume();
    },
    write(chunk, encoding, callback) {
      if (socket.write(chunk, encoding)) callback();
      else socket.once("drain", callback);
    },
    final(callback) {
      socket.end(callback);
    },
    destroy(error, callback) {
      socket.destroy();
      callback(error);
    },
  });
  socket.pause();
  socket.on("data", (chunk) => {
    if (!duplex.push(chunk)) socket.pause();
  });
  socket.once("end", () => duplex.push(null));
  socket.once("error", (error) => duplex.destroy(error));
  return duplex;
}

describe("Source Server connection endpoints", () => {
  it("maps a base URL to the authenticated info/capability/WS endpoints", () => {
    expect(resolveServerRemoteEndpoints("https://source.example.test/base/")).toEqual({
      infoUrl: "https://source.example.test/base/api/server-info",
      wsUrl: "wss://source.example.test/base/ws",
      hostCapabilityUrl: "https://source.example.test/base/api/rpc-host-capability",
      hostWsUrl: "wss://source.example.test/base/ws/host",
    });
    expect(() => resolveServerRemoteEndpoints("ftp://example.test")).toThrow(/protocol/);
  });
});

describe("connectServerRemoteOverDuplex", () => {
  it("authenticates over one reusable Duplex and serves existing RPC services", async () => {
    const server = await startLoopbackSourceServer();
    let channels = 0;

    const connection = await connectServerRemoteOverDuplex({
      ingressToken: INGRESS_TOKEN,
      createConnection: async () => {
        channels += 1;
        return await connectOpaqueDuplex(server.port);
      },
    });
    disposals.push(() => connection.dispose());

    expect(connection.serverInfo.serverId).toBe("source-under-test");
    expect(connection.serverInfo.capabilities.virtualProjects).toBe(true);
    // 握手声明的能力直接决定是否创建 Project channel 代理。
    expect(connection.services.projectService).toBeDefined();

    const entries = await connection.services.fileService.readdir({ path: "/work" });
    expect(entries.map((entry) => entry.name)).toEqual(["alpha", "beta.txt"]);
    // info、capability 与 WS upgrade 复用同一条通道，不为每个请求另起 tunnel。
    expect(channels).toBe(1);
    expect(server.requests.map((request) => request.url)).toEqual([
      "/api/server-info",
      "/api/rpc-host-capability",
    ]);
    expect(server.requests.every((request) => !request.url.includes("token"))).toBe(true);
  });

  it("rejects a wrong ingress token before opening a channel", async () => {
    const server = await startLoopbackSourceServer();
    const error = await connectServerRemoteOverDuplex({
      ingressToken: "wrong-token",
      createConnection: async () => await connectOpaqueDuplex(server.port),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Server info request failed: 401/u);
  });

  it("releases the channel when the capability request is denied", async () => {
    const server = await startLoopbackSourceServer({ rejectCapability: true });
    const error = await connectServerRemoteOverDuplex({
      ingressToken: INGRESS_TOKEN,
      createConnection: async () => await connectOpaqueDuplex(server.port),
    }).catch((caught: unknown) => caught);

    expect((error as Error).message).toMatch(/Host capability request failed: 403/u);
  });

  it("fails closed on an empty ingress token", async () => {
    await expect(
      connectServerRemoteOverDuplex({
        ingressToken: "   ",
        createConnection: async () => {
          throw new Error("must not connect");
        },
      }),
    ).rejects.toThrow(/ingress token is required/u);
  });
});

describe("connectServerRemote (direct HTTP Bearer)", () => {
  it("connects with an Authorization header and never puts the token in a URL", async () => {
    const server = await startLoopbackSourceServer();
    let capabilityRequests = 0;
    const originalStop = server.stop;

    const connection = await connectServerRemote(
      { kind: "server", url: `http://127.0.0.1:${server.port}`, token: INGRESS_TOKEN },
      {
        fetchImpl: async (input, init) => {
          const url = typeof input === "string" ? input : input.toString();
          if (url.includes("/api/rpc-host-capability")) capabilityRequests += 1;
          return await fetch(url, init);
        },
      },
    );
    disposals.push(() => connection.dispose());

    expect(connection.serverInfo.serverId).toBe("source-under-test");
    expect(capabilityRequests).toBe(1);
    for (const request of server.requests) {
      expect(request.url).not.toContain(INGRESS_TOKEN);
      expect(request.authorization).toBe(`Bearer ${INGRESS_TOKEN}`);
    }
    const entries = await connection.services.fileService.readdir({ path: "/work" });
    expect(entries).toHaveLength(2);
    await originalStop;
  });

  it("aborts the handshake and releases sockets when the caller cancels", async () => {
    const server = await startLoopbackSourceServer();
    const controller = new AbortController();
    const connecting = connectServerRemote(
      { kind: "server", url: `http://127.0.0.1:${server.port}`, token: INGRESS_TOKEN },
      { signal: controller.signal },
    );
    controller.abort(new Error("operator canceled"));
    await expect(connecting).rejects.toThrow(/operator canceled/u);
  });
});

describe("Source identity from a real loopback handshake", () => {
  it("keeps two same-display-name Sources with different authenticated ids at one path distinct", async () => {
    const sourceA = await startLoopbackSourceServer({
      serverInfo: { ...SERVER_INFO, serverId: "source-a", name: "Same Name" },
    });
    const sourceB = await startLoopbackSourceServer({
      serverInfo: { ...SERVER_INFO, serverId: "source-b", name: "Same Name" },
    });
    const registry = createWindowRemoteConnectionRegistry<IServiceAccessor>({
      connect: async (request) => {
        if (request.target.kind !== "server") throw new Error("expected server target");
        const connection = await connectServerRemote(
          request.target,
          request.signal ? { signal: request.signal } : {},
        );
        disposals.push(() => connection.dispose());
        return {
          services: connection.services,
          sourceServerId: connection.serverInfo.serverId,
          virtualProjects: connection.serverInfo.capabilities.virtualProjects === true,
          dispose: () => connection.dispose(),
        };
      },
      createId: (() => {
        let next = 0;
        return () => `session-${++next}`;
      })(),
    });

    const connect = (port: number, requestId: string, advertisedServerId?: string) =>
      registry.connect({
        requestId,
        target: {
          kind: "server",
          url: `http://127.0.0.1:${port}`,
          name: "Same Name",
          token: INGRESS_TOKEN,
          ...(advertisedServerId ? { serverId: advertisedServerId } : {}),
        },
        remoteAssets: {},
        workspacePath: "/srv/app",
      });

    // 真实表单没有 serverId；这里额外传一个错误声明，证明握手会覆盖它。
    const descriptorA = await connect(sourceA.port, "r1", "advertised-wrong");
    const descriptorB = await connect(sourceB.port, "r2");
    expect(descriptorA.workspaceIdentity).toBe("remote:server:source-a:/srv/app");
    expect(descriptorB.workspaceIdentity).toBe("remote:server:source-b:/srv/app");
    expect(descriptorA.workspaceIdentity).not.toBe(descriptorB.workspaceIdentity);
    expect(descriptorA.target).toMatchObject({ serverId: "source-a" });
    expect(descriptorA.target).not.toHaveProperty("token");
    expect(descriptorB.target).toMatchObject({ serverId: "source-b" });
  });
});
