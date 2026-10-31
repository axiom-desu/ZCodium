import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import type { BrowserWindow, MessagePortMain, UtilityProcess } from "electron";
import { ChannelServer, Emitter, SocketProtocol, VSBuffer, type ISocket } from "@zcode/rpc";
import { IFileService, ServiceCollection, type IServiceAccessor } from "@zcode/services";
import {
  HostMessageTypes,
  HostResponseTypes,
  hostIncomingMessageSchema,
  buildRemoteWorkspaceIdentity,
  type RemoteTarget,
  type RemoteWorkspaceSessionEntry,
  type WindowHostAttachmentScope,
} from "@zcode/shared";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRemoteTarget } from "@/lib/remoteConnectionWizard.js";
import {
  buildRemoteWorkspaceSessionMutation,
  loadRemoteTargetCredentials,
  resolveConnectedRemoteWorkspaceIdentity,
  withAuthenticatedServerTarget,
} from "@/lib/remoteWorkspaceHistory.js";
// Desktop 集成测试（Main/main-manager + Host registry + UI reconnect 消费端）：
// 这里使用真实 electron/ws 依赖与真实 loopback Host，因此归 Desktop 测试所有，而不是 UI 单测。
import { createWindowRemoteConnectionRegistry } from "../src/host/windowRemoteConnectionRegistry.js";
import { connectServerRemote } from "../src/host/serverRemoteConnection.js";
import { createRemoteWorkspaceSessionManager } from "../src/main/desktopRemoteSessions.js";
import { reconnectRemoteWorkspaceHistoryEntry } from "@/root/reconnectRemoteWorkspaceHistoryEntry.js";

vi.mock("@/store/remotePinnedTaskStore.js", () => ({
  refreshRemotePinnedTasksForSession: async () => {},
}));
vi.mock("@/store/remoteTimelineTaskStore.js", () => ({
  refreshRemoteTimelineTasksForSession: async () => {},
}));

const electron = vi.hoisted(() => ({ windows: [] as BrowserWindow[] }));
vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => electron.windows,
    fromId: (id: number) => electron.windows.find((win) => win.id === id),
  },
  MessageChannelMain: class {},
}));

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  electron.windows = [];
});

function socketFor(ws: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();
  ws.on("message", (raw: RawData) =>
    onData.fire(
      VSBuffer.wrap(Buffer.concat(Array.isArray(raw) ? raw : [Buffer.from(raw as ArrayBuffer)])),
    ),
  );
  ws.on("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write: (data) => {
      ws.send(data.buffer);
    },
    end: () => ws.close(),
    dispose: () => ws.close(),
    drain: async () => {},
  };
}

/** 仅 loopback 的真实 Bearer + 单次 capability + WS RPC，不读任何用户配置。 */
async function loopback() {
  const token = "fixture-ingress-not-a-user-secret";
  const capabilities = new Set<string>();
  const requests: string[] = [];
  const sockets = new Set<Socket>();
  let sequence = 0;
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    res.setHeader("content-type", "application/json");
    if (req.url === "/team/api/server-info") {
      res.end(
        JSON.stringify({
          serverId: "source-loopback",
          name: "Same Name",
          version: "3.16.2",
          protocolVersion: 1,
          authRequired: true,
          workspaces: [{ path: "/work" }],
          capabilities: { desktopContinuous: true, websocketRpc: true },
        }),
      );
    } else if (req.url === "/team/api/rpc-host-capability" && req.method === "POST") {
      const capability = `fixture-capability-${++sequence}`;
      capabilities.add(capability);
      res.end(JSON.stringify({ capability, expiresAt: Date.now() + 60_000 }));
    } else res.writeHead(404).end();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const wsServer = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const capability = req.headers["x-zcode-rpc-host-capability"];
    if (
      req.url !== "/team/ws/host" ||
      req.headers.authorization !== `Bearer ${token}` ||
      typeof capability !== "string" ||
      !capabilities.delete(capability)
    ) {
      socket.destroy();
      return;
    }
    wsServer.handleUpgrade(req, socket, head, (ws) => {
      const protocol = new SocketProtocol(socketFor(ws));
      const channels = new ChannelServer(protocol, "source-authority-fixture");
      new ServiceCollection()
        .register(IFileService, {
          readdir: async () => [
            { name: "from-loopback", path: "/work/from-loopback", isDirectory: true },
          ],
        } as unknown as IFileService)
        .exposeOnChannelServer(channels);
      ws.once("close", () => {
        channels.dispose();
        protocol.dispose();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture port");
  cleanup.push(async () => {
    for (const ws of wsServer.clients) ws.terminate();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => wsServer.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { token, url: `http://127.0.0.1:${address.port}/team`, requests };
}

/** 只替换 Electron IPC/端口投递；实际 Main manager、registry 与连接器都保留。 */
function mainHarness(
  registry: ReturnType<typeof createWindowRemoteConnectionRegistry<IServiceAccessor>>,
) {
  const scopes: Array<{ clientMode: string; scope: WindowHostAttachmentScope }> = [];
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    postMessage(raw: unknown): void;
  };
  child.pid = 12345;
  child.postMessage = (raw) => {
    const message = hostIncomingMessageSchema.parse(raw);
    if (message.type === HostMessageTypes.ConnectRemoteWorkspace) {
      void registry
        .connect({
          ...message,
          remoteAssets: message.remoteAssets,
          workspacePath: message.workspacePath ?? "/",
        })
        .then(
          (descriptor) => {
            child.emit("message", {
              type: HostResponseTypes.RemoteWorkspaceConnected,
              requestId: message.requestId,
              descriptor,
            });
          },
          (error: unknown) =>
            child.emit("message", {
              type: HostResponseTypes.RemoteWorkspaceConnectFailed,
              requestId: message.requestId,
              error: String(error),
            }),
        );
    } else if (message.type === HostMessageTypes.ProviderProvisioningExecute) {
      queueMicrotask(() =>
        child.emit("message", {
          type: HostResponseTypes.ProviderProvisioningExecutionResult,
          requestId: message.requestId,
          environmentKey: message.environmentKey,
          status: "applied",
        }),
      );
    } else if (message.type === HostMessageTypes.BindRemoteWorkspaceContext) {
      void registry.bindWorkspaceContext(message);
    } else if (message.type === HostMessageTypes.AttachServicePort) {
      registry.resolveScopedServices(message.scope);
      scopes.push({ clientMode: message.clientMode, scope: message.scope });
    }
  };
  const manager = createRemoteWorkspaceSessionManager({
    logger: { info() {}, warn() {}, error() {} },
    windowHostProcessMap: new Map([[7, child as unknown as UtilityProcess]]),
    resolveRemoteAssetDirs: () => ({}),
    createMessageChannel: () => ({
      port1: { close() {} } as MessagePortMain,
      port2: { close() {} } as MessagePortMain,
    }),
  });
  const win = {
    id: 1,
    isDestroyed: () => false,
    webContents: {
      id: 7,
      isDestroyed: () => false,
      send() {},
      postMessage: (_channel: string, payload: { sessionId: string; attachmentId: string }) => {
        queueMicrotask(() => manager.confirmRendererAttachmentReady(7, payload));
      },
    },
  } as unknown as BrowserWindow;
  electron.windows = [win];
  cleanup.push(() => manager.disposeAllAndWaitForAppShutdown("fixture"));
  return { manager, win, scopes };
}

function formTarget(url: string, token: string): RemoteTarget {
  const { target } = buildRemoteTarget(
    { formatMessage: ({ id }) => id },
    {
      kind: "server",
      host: "",
      port: "22",
      username: "",
      sshAuthMethod: "password",
      password: "",
      privateKeyPath: "",
      privateKeyPassphrase: "",
      wslDistro: "",
      dockerContainer: "",
      serverUrl: url,
      serverToken: token,
      serverName: "Same Name",
      serverWorkspacePath: "/work",
    },
  );
  if (!target) throw new Error("form rejected fixture");
  expect(target).not.toHaveProperty("serverId");
  return target;
}

describe("Source form → authenticated loopback Host → actual Main → temporary history/credential ports", () => {
  it("uses the handshake identity through bind/mobile/reconnect and never writes failed credentials", async () => {
    const fixture = await loopback();
    let connects = 0;
    const registry = createWindowRemoteConnectionRegistry<IServiceAccessor>({
      createId: () => `session-${++connects}`,
      connect: async ({ target, signal }) => {
        if (target.kind !== "server") throw new Error("unexpected target");
        const connection = await connectServerRemote(target, { signal });
        return {
          services: connection.services,
          sourceServerId: connection.serverInfo.serverId,
          sourceServerAuthProofDigest: createHash("sha256")
            .update(target.token ?? "")
            .digest("hex"),
          dispose: () => connection.dispose(),
        };
      },
    });
    cleanup.push(() => registry.dispose());
    const { manager, win, scopes } = mainHarness(registry);
    const dir = await mkdtemp(join(tmpdir(), "s9-source-authority-"));
    const historyPath = join(dir, "history.json");
    const credentialsPath = join(dir, "credentials.json");
    await writeFile(historyPath, "[]");
    await writeFile(credentialsPath, "{}");
    const target = formTarget(fixture.url, fixture.token);
    const descriptor = await manager.createRemoteWorkspaceSession(win, target, "form-no-id");
    expect(descriptor.workspaceIdentity).toBe("remote:server:source-loopback:/");
    const connected = {
      sessionId: descriptor.remoteSessionId,
      sourceServerId: descriptor.sourceServerId,
      workspaceIdentity: descriptor.workspaceIdentity,
      target: withAuthenticatedServerTarget(target, descriptor.sourceServerId),
    };
    const actualKey = resolveConnectedRemoteWorkspaceIdentity({
      connected,
      workspacePath: "/work",
    });
    await manager.bindRemoteWorkspaceSessionContext(
      descriptor.remoteSessionId,
      { workspacePath: "/work", workspaceIdentity: actualKey },
      7,
    );
    expect(registry.getSession(descriptor.remoteSessionId)?.workspaceIdentity).toBe(actualKey);
    const services = registry.resolveScopedServices({
      kind: "remote",
      remoteSessionId: descriptor.remoteSessionId,
      workspacePath: "/work",
      workspaceIdentity: actualKey,
    });
    expect(await services.fileService.readdir({ path: "/work" })).toMatchObject([
      { name: "from-loopback" },
    ]);
    manager.attachRemoteWorkspaceSessionHost({
      windowId: 1,
      remoteSessionId: descriptor.remoteSessionId,
      workspacePath: "/work",
      workspaceIdentity: actualKey,
      workspaceKey: actualKey,
      clientMode: "web-remote-replayable",
    });
    const mutation = buildRemoteWorkspaceSessionMutation({
      remoteSessions: [],
      workspacePath: "/work",
      workspaceIdentity: actualKey,
      target: connected.target,
      lastConnectionStatus: "connected",
      touchOpenedAt: true,
    });
    await writeFile(
      credentialsPath,
      JSON.stringify(
        Object.fromEntries(mutation.credentialsToSave.map(({ key, value }) => [key, value])),
      ),
    );
    await writeFile(historyPath, JSON.stringify(mutation.nextRemoteSessions));
    const historyText = await readFile(historyPath, "utf8");
    expect(historyText).not.toContain(fixture.token);
    const history = JSON.parse(historyText) as RemoteWorkspaceSessionEntry[];
    const saved = history[0]!;
    const restored = await loadRemoteTargetCredentials(
      saved.target,
      async (key) =>
        (JSON.parse(await readFile(credentialsPath, "utf8")) as Record<string, string>)[key] ??
        null,
    );
    expect(restored.token).toBe(fixture.token);
    const upsertWorkspaceTab = vi.fn();
    await reconnectRemoteWorkspaceHistoryEntry({
      sessionEntry: saved,
      activateTabByPath: () => true,
      setReconnectingRemoteWorkspaceKeys() {},
      loadCredential: async (key) =>
        (JSON.parse(await readFile(credentialsPath, "utf8")) as Record<string, string>)[key] ??
        null,
      connectRemoteWorkspaceTarget: async (reconnectTarget, requestId, context) => {
        const actual = await manager.createRemoteWorkspaceSession(
          win,
          reconnectTarget,
          requestId,
          context,
        );
        return {
          sessionId: actual.remoteSessionId,
          target: actual.target,
          sourceServerId: actual.sourceServerId,
          workspaceIdentity: actual.workspaceIdentity,
        };
      },
      resolveRemoteWorkspaceCanonicalPath: async () => "/work",
      disposeRemoteWorkspaceSession: async (sessionId) =>
        manager.disposeRemoteWorkspaceSession(sessionId),
      bindRemoteWorkspaceSessionContext: async ({ sessionId, ...context }) =>
        manager.bindRemoteWorkspaceSessionContext(sessionId, context, 7),
      bindRemoteWorkspacePath() {},
      bindRemoteWorkspaceIdentity() {},
      upsertWorkspaceTab,
      commitRemoteWorkspaceSessionMutation: async (next) => {
        await writeFile(historyPath, JSON.stringify(next.nextRemoteSessions));
        return next.entry;
      },
      getRemoteSessions: () => history,
      logger: { warn() {} },
      toast() {},
      options: { throwOnFailure: true },
    });
    expect(upsertWorkspaceTab).toHaveBeenCalledWith(
      "/work",
      expect.objectContaining({ workspaceIdentity: actualKey }),
    );
    expect(scopes.filter(({ clientMode }) => clientMode === "web-remote-replayable")).toHaveLength(
      1,
    );
    expect(scopes.at(-1)?.scope).toMatchObject({ workspaceIdentity: actualKey });
    const beforeCredentials = await readFile(credentialsPath, "utf8");
    const beforeHistory = await readFile(historyPath, "utf8");
    await expect(
      manager.createRemoteWorkspaceSession(
        win,
        formTarget(fixture.url, "wrong-fixture-token"),
        "bad-token",
        { workspacePath: "/work" },
      ),
    ).rejects.toThrow(/401/);
    expect(await readFile(historyPath, "utf8")).toBe(beforeHistory);
    expect(await readFile(credentialsPath, "utf8")).toBe(beforeCredentials);
    expect(fixture.requests.filter((path) => path.endsWith("/api/server-info"))).toHaveLength(2);
    expect(JSON.stringify(registry.listSessions())).not.toContain(fixture.token);
  });

  it("Main/mobile exact scopes distinguish six verified legacy keys on one Source/proof/path", async () => {
    let next = 0;
    const registry = createWindowRemoteConnectionRegistry<IServiceAccessor>({
      createId: () => `legacy-${++next}`,
      connect: async () => ({
        services: {} as IServiceAccessor,
        sourceServerId: "source-shared",
        sourceServerAuthProofDigest: "fixture-proof",
        dispose() {},
      }),
    });
    cleanup.push(() => registry.dispose());
    const { manager, win } = mainHarness(registry);
    const targets: RemoteTarget[] = [
      { kind: "ssh", host: "fixture.invalid", username: "alice" },
      { kind: "ssh", host: "fixture.invalid", username: "bob" },
      { kind: "wsl", distro: "Fixture", user: "alice" },
      { kind: "wsl", distro: "Fixture", user: "bob" },
      { kind: "docker", container: "fixture-a" },
      { kind: "docker", container: "fixture-b" },
    ];
    const keys = new Set<string>();
    let history: RemoteWorkspaceSessionEntry[] = [];
    for (const [index, target] of targets.entries()) {
      const key = buildRemoteWorkspaceIdentity("/work", target);
      const descriptor = await manager.createRemoteWorkspaceSession(
        win,
        target,
        `legacy-${index}`,
        { workspacePath: "/work", workspaceIdentity: key },
      );
      expect(descriptor.workspaceIdentity).toBe(key);
      await manager.bindRemoteWorkspaceSessionContext(
        descriptor.remoteSessionId,
        { workspacePath: "/work", workspaceIdentity: key },
        7,
      );
      expect(() =>
        manager.attachRemoteWorkspaceSessionHost({
          windowId: 1,
          remoteSessionId: descriptor.remoteSessionId,
          workspacePath: "/work",
          workspaceIdentity: key,
          workspaceKey: key,
          clientMode: "web-remote-replayable",
        }),
      ).not.toThrow();
      expect(() =>
        manager.attachRemoteWorkspaceSessionHost({
          windowId: 1,
          remoteSessionId: descriptor.remoteSessionId,
          workspacePath: "/work",
          workspaceIdentity: "remote:server:source-shared:/work",
          workspaceKey: "remote:server:source-shared:/work",
          clientMode: "web-remote-replayable",
        }),
      ).toThrowError(expect.objectContaining({ code: "REMOTE_WORKSPACE_IDENTITY_MISMATCH" }));
      keys.add(key);
      const actualKey = resolveConnectedRemoteWorkspaceIdentity({
        connected: {
          sessionId: descriptor.remoteSessionId,
          target,
          sourceServerId: descriptor.sourceServerId,
          workspaceIdentity: descriptor.workspaceIdentity,
        },
        workspacePath: "/work",
      });
      history = buildRemoteWorkspaceSessionMutation({
        remoteSessions: history,
        workspacePath: "/work",
        workspaceIdentity: actualKey,
        target,
        lastConnectionStatus: "connected",
        touchOpenedAt: true,
      }).nextRemoteSessions;
    }
    expect(history).toHaveLength(6);
    expect(new Set(history.map((entry) => entry.workspaceIdentity))).toEqual(keys);
    expect(keys.size).toBe(6);
    expect(
      registry.findSessionForWorkspace({
        workspacePath: "/work",
        workspaceIdentity: "remote:server:source-shared:/work",
      }),
    ).toBeNull();
  });
});
