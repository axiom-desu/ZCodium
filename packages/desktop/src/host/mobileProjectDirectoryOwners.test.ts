import { describe, expect, it, vi } from "vitest";
import {
  ChannelClient,
  ChannelServer,
  MessagePortProtocol,
  ProxyChannel,
  type MessagePortLike,
  type MessagePortPayload,
} from "@zcode/rpc";
import {
  IProjectService,
  IZCodeAgentService,
  IZCodeTaskService,
  ServiceCollection,
} from "@zcode/services";
import {
  createMobileProjectDirectoryService,
  type MobileProjectDirectoryOwner,
} from "@zcode/services/node";
import { buildServerRemoteWorkspaceIdentity, type WindowHostAttachmentScope } from "@zcode/shared";
import { guardReplayableTaskCreation } from "./mobileProjectDirectoryAttachment.js";
import {
  createMobileProjectDirectoryAttachmentAssertion,
  createMobileProjectDirectoryOwners,
  resolveMobileProjectDirectoryAvailability,
  type MobileProjectDirectoryCapabilities,
} from "./mobileProjectDirectoryOwners.js";
import {
  createWindowRemoteConnectionRegistry,
  type WindowRemoteConnectionHandle,
} from "./windowRemoteConnectionRegistry.js";

const canonicalA = buildServerRemoteWorkspaceIdentity({
  serverId: "source-a",
  workspacePath: "/repo",
});
const canonicalB = buildServerRemoteWorkspaceIdentity({
  serverId: "source-b",
  workspacePath: "/repo",
});
const legacyIdentity = "remote:ssh:host:22:user:/repo";

function runtimeFor(hostId: string) {
  return { identity: `${hostId}-actor`, generation: 1, workspaceKey: `${hostId}:/repo` };
}

function createFakeServices(params: {
  hostId: string;
  name: string;
  roots: string[];
  onCreate?: (target: unknown, expected: unknown, third?: unknown) => void;
}) {
  const runtime = runtimeFor(params.hostId);
  const projects = {
    readProjects: vi.fn(async () => [
      {
        id: `p-${params.hostId}`,
        name: params.name,
        legacySingleRoot: false,
        deleted: false,
        roots: params.roots.map((rootPath) => ({
          rootPath,
          isPrimary: rootPath === params.roots[0],
          position: 0,
        })),
      },
    ]),
  };
  const agent = {
    getWorkspaceRuntimeIdentity: vi.fn(async () => runtime),
    getClient: vi.fn(() => {
      throw new Error("directory owner must not start an agent");
    }),
  };
  const tasks = {
    createTask: vi.fn(async () => ({ taskId: `${params.hostId}-plain` })),
    createTaskExistingRuntime: vi.fn(
      async (target: unknown, expected: unknown, third?: unknown) => {
        params.onCreate?.(target, expected, third);
        return { taskId: `${params.hostId}-existing` };
      },
    ),
  };
  const services = new ServiceCollection()
    .register(IProjectService, projects as never)
    .register(IZCodeAgentService, agent as never)
    .register(IZCodeTaskService, tasks as never);
  return { services, projects, agent, tasks, runtime };
}

type TestHandle = WindowRemoteConnectionHandle<
  ServiceCollection,
  MobileProjectDirectoryCapabilities
> & { close(): void };

function createHandle(params: {
  services: ServiceCollection;
  sourceServerId?: string;
  capabilities?: MobileProjectDirectoryCapabilities;
}): TestHandle {
  const listeners = new Set<() => void>();
  const handle: TestHandle = {
    services: params.services,
    ...(params.sourceServerId ? { sourceServerId: params.sourceServerId } : {}),
    sourceServerAuthProofDigest: "proof-shared",
    virtualProjects: true,
    capabilities: params.capabilities ?? {},
    dispose() {},
    onDidClose(listener) {
      listeners.add(() => listener({ exitCode: 0, signal: null }));
      return { dispose: () => listeners.delete(listener as never) };
    },
    close() {
      for (const listener of listeners) listener();
    },
  };
  return handle;
}

function createRegistryHarness(params: {
  local: ReturnType<typeof createFakeServices>;
  remoteA: ReturnType<typeof createFakeServices>;
  remoteB: ReturnType<typeof createFakeServices>;
  legacy: ReturnType<typeof createFakeServices>;
}) {
  let nextSession = 0;
  const ids = ["sess-a1", "sess-a2", "sess-a3", "sess-b1"];
  const handles: TestHandle[] = [];
  const registry = createWindowRemoteConnectionRegistry<
    ServiceCollection,
    MobileProjectDirectoryCapabilities
  >({
    createId: () => ids[nextSession++] ?? `sess-${nextSession}`,
    connect: async (request) => {
      const target = request.target;
      if (target.kind === "server" && target.serverId === "source-b") {
        const handle = createHandle({
          services: params.remoteB.services,
          sourceServerId: "source-b",
          capabilities: {},
        });
        handles.push(handle);
        return handle;
      }
      if (target.kind === "ssh") {
        const handle = createHandle({ services: params.legacy.services });
        handles.push(handle);
        return handle;
      }
      const handle = createHandle({
        services: params.remoteA.services,
        sourceServerId: "source-a",
        capabilities: { existingRuntimeAdmission: true },
      });
      handles.push(handle);
      return handle;
    },
  });
  return { registry, handles };
}

async function seedSessions(harness: ReturnType<typeof createRegistryHarness>) {
  const { registry } = harness;
  await registry.connect({
    requestId: "r-a1",
    target: { kind: "server", url: "http://source-a", serverId: "source-a" },
    remoteAssets: {},
    workspacePath: "/repo",
    workspaceIdentity: canonicalA,
  });
  await registry.connect({
    requestId: "r-a2",
    target: { kind: "server", url: "http://source-a", serverId: "source-a" },
    remoteAssets: {},
    workspacePath: "/repo",
    workspaceIdentity: canonicalA,
  });
  await registry.connect({
    requestId: "r-a3",
    target: { kind: "ssh", host: "host", port: 22, username: "user" },
    remoteAssets: {},
    workspacePath: "/repo",
    workspaceIdentity: legacyIdentity,
  });
  await registry.connect({
    requestId: "r-b1",
    target: { kind: "server", url: "http://source-b", serverId: "source-b" },
    remoteAssets: {},
    workspacePath: "/repo",
    workspaceIdentity: canonicalB,
  });
}

async function createFixture() {
  const local = createFakeServices({ hostId: "local", name: "Local", roots: ["/local/repo"] });
  const created: Array<{ target: unknown; expected: unknown; third?: unknown }> = [];
  const remoteA = createFakeServices({
    hostId: "remote:server:source-a",
    name: "Source A",
    roots: ["/repo", "/extra"],
    onCreate: (target, expected, third) => created.push({ target, expected, third }),
  });
  const remoteB = createFakeServices({
    hostId: "remote:server:source-b",
    name: "Source B",
    roots: ["/repo"],
    onCreate: (target, expected, third) => created.push({ target, expected, third }),
  });
  const legacy = createFakeServices({
    hostId: "remote:ssh:host:22:user",
    name: "Legacy same path",
    roots: ["/repo"],
    onCreate: (target, expected, third) => created.push({ target, expected, third }),
  });
  const harness = createRegistryHarness({ local, remoteA, remoteB, legacy });
  await seedSessions(harness);
  return {
    local,
    remoteA,
    remoteB,
    legacy,
    created,
    registry: harness.registry,
    handles: harness.handles,
  };
}

function createOwnersFixture(params: {
  fixture: Awaited<ReturnType<typeof createFixture>>;
  scope: WindowHostAttachmentScope;
  generation?: number;
  services: ServiceCollection;
  capabilities?: MobileProjectDirectoryCapabilities;
}) {
  const getSessionCalls: string[] = [];
  const instrumented = new Proxy(params.fixture.registry, {
    get(target, property, receiver) {
      if (property === "getSession") {
        return (remoteSessionId: string) => {
          getSessionCalls.push(remoteSessionId);
          // sess-a1 是同 Source/path 的另一个 logical session，模拟它已 stale；
          // 本次 attachment 是 sess-a2，不应被无关 session 拖垮。
          if (remoteSessionId === "sess-a1") return null;
          return target.getSession(remoteSessionId);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const owners: MobileProjectDirectoryOwner[] = createMobileProjectDirectoryOwners({
    assertAttachment: createMobileProjectDirectoryAttachmentAssertion({
      registry: instrumented,
      getActiveServices: () => params.fixture.local.services,
      services: params.services,
      attachmentScope: params.scope,
      attachmentGeneration: params.generation ?? 1,
      isDisposed: () => false,
    }),
    attachmentScope: params.scope,
    attachmentGeneration: params.generation ?? 1,
    attachmentServices: params.services,
    attachmentCapabilities: params.capabilities,
    localServices: params.fixture.local.services,
    registry: instrumented,
  });
  return { owners, getSessionCalls };
}

describe("attachment-scoped mobile project directory owners", () => {
  it("binds canonical create to the exact attachment session, not the first same-source/path session", async () => {
    const fixture = await createFixture();
    const scope: WindowHostAttachmentScope = {
      kind: "remote",
      remoteSessionId: "sess-a2",
      workspacePath: "/repo",
      workspaceIdentity: canonicalA,
    };
    const { owners, getSessionCalls } = createOwnersFixture({
      fixture,
      scope,
      services: fixture.remoteA.services,
      capabilities: { existingRuntimeAdmission: true },
    });
    const directory = createMobileProjectDirectoryService({
      assertCurrent: () => {},
      owners: () => owners,
    });

    const roots = await directory.readProjects();
    const byHost = (hostId: string) => roots.filter((root) => root.rootIdentity.hostId === hostId);
    expect(byHost("local").every((root) => !root.enabled)).toBe(true);
    expect(byHost("remote:server:source-b").every((root) => !root.enabled)).toBe(true);
    expect(byHost("remote:ssh:host:22:user").every((root) => !root.enabled)).toBe(true);

    const canonicalRoots = byHost("remote:server:source-a");
    expect(canonicalRoots.map((root) => [root.rootIdentity.rootPath, root.enabled])).toEqual([
      ["/repo", true],
      ["/extra", false],
    ]);
    const attached = canonicalRoots.find((root) => root.enabled)!;
    expect(attached.remoteSessionId).toBe("sess-a2");
    expect(attached.workspaceIdentity).toBe(canonicalA);
    expect(attached.attachmentGeneration).toBe(1);

    await expect(directory.createTask(attached)).resolves.toEqual({
      taskId: "remote:server:source-a-existing",
    });
    expect(fixture.remoteA.tasks.createTaskExistingRuntime).toHaveBeenCalledTimes(1);
    const [target, expected] = fixture.remoteA.tasks.createTaskExistingRuntime.mock.calls[0]!;
    expect(target).toMatchObject({
      workspacePath: "/repo",
      workspaceIdentity: canonicalA,
      remoteSessionId: "sess-a2",
    });
    expect(expected).toEqual(fixture.remoteA.runtime);
    // 远端 RPC 不得收到 in-process 回调；第三个参数只能由对端 Host 注入。
    expect(fixture.remoteA.tasks.createTaskExistingRuntime.mock.calls[0]).toHaveLength(2);
    expect(fixture.remoteA.agent.getClient).not.toHaveBeenCalled();

    // 同 Source/path 的第一个 session（即使已 stale）不是本次 attachment，不能被扫描/复检。
    expect(getSessionCalls).not.toContain("sess-a1");
    expect(getSessionCalls).not.toContain("sess-b1");
  });

  it("does not canonicalize a legacy same-path root while attached to the canonical session", async () => {
    const fixture = await createFixture();
    const scope: WindowHostAttachmentScope = {
      kind: "remote",
      remoteSessionId: "sess-a2",
      workspacePath: "/repo",
      workspaceIdentity: canonicalA,
    };
    const { owners } = createOwnersFixture({
      fixture,
      scope,
      services: fixture.remoteA.services,
      capabilities: { existingRuntimeAdmission: true },
    });
    const directory = createMobileProjectDirectoryService({
      assertCurrent: () => {},
      owners: () => owners,
    });
    const legacyRow = (await directory.readProjects()).find(
      (root) => root.rootIdentity.hostId === "remote:ssh:host:22:user",
    )!;
    expect(legacyRow.enabled).toBe(false);
    // 伪造 enabled 也不能把 legacy root 交给另一个 logical service。
    await expect(
      directory.createTask({
        ...legacyRow,
        enabled: true,
        runtimeIdentity: runtimeFor("remote:ssh:host:22:user"),
      }),
    ).rejects.toThrow("project.stale-attachment");
    expect(fixture.legacy.tasks.createTask).not.toHaveBeenCalled();
    expect(fixture.legacy.tasks.createTaskExistingRuntime).not.toHaveBeenCalled();
  });

  it("binds a legacy attachment to its own session without falling back to the canonical host", async () => {
    const fixture = await createFixture();
    const scope: WindowHostAttachmentScope = {
      kind: "remote",
      remoteSessionId: "sess-a3",
      workspacePath: "/repo",
      workspaceIdentity: legacyIdentity,
    };
    const { owners } = createOwnersFixture({
      fixture,
      scope,
      services: fixture.legacy.services,
      capabilities: { existingRuntimeAdmission: true },
    });
    const directory = createMobileProjectDirectoryService({
      assertCurrent: () => {},
      owners: () => owners,
    });
    const roots = await directory.readProjects();
    const legacyRow = roots.find((root) => root.rootIdentity.hostId === "remote:ssh:host:22:user")!;
    const canonicalRow = roots.find(
      (root) => root.rootIdentity.hostId === "remote:server:source-a",
    )!;
    expect(legacyRow).toMatchObject({
      enabled: true,
      workspaceIdentity: legacyIdentity,
      remoteSessionId: "sess-a3",
    });
    expect(canonicalRow.enabled).toBe(false);
    await expect(directory.createTask(legacyRow)).resolves.toEqual({
      taskId: "remote:ssh:host:22:user-existing",
    });
    expect(fixture.legacy.tasks.createTaskExistingRuntime.mock.calls[0]?.[0]).toMatchObject({
      workspaceIdentity: legacyIdentity,
      remoteSessionId: "sess-a3",
    });
    expect(fixture.remoteA.tasks.createTaskExistingRuntime).not.toHaveBeenCalled();
  });

  it("keeps a local attachment from creating on any remote logical service", async () => {
    const fixture = await createFixture();
    const scope: WindowHostAttachmentScope = { kind: "local" };
    const { owners } = createOwnersFixture({ fixture, scope, services: fixture.local.services });
    const directory = createMobileProjectDirectoryService({
      assertCurrent: () => {},
      owners: () => owners,
    });
    const roots = await directory.readProjects();
    expect(roots.find((root) => root.rootIdentity.hostId === "local")?.enabled).toBe(true);
    expect(
      roots.filter((root) => root.rootIdentity.hostId !== "local").every((root) => !root.enabled),
    ).toBe(true);
    const remoteRoot = roots.find((root) => root.rootIdentity.hostId === "remote:server:source-a")!;
    await expect(
      directory.createTask({
        ...remoteRoot,
        enabled: true,
        runtimeIdentity: fixture.remoteA.runtime,
      }),
    ).rejects.toThrow("project.stale-attachment");
    expect(fixture.remoteA.tasks.createTaskExistingRuntime).not.toHaveBeenCalled();
  });
});

describe("directory availability uses this attachment's services and capability", () => {
  it("does not read local activeServices for a remote attachment", () => {
    const emptyLocal = new ServiceCollection();
    const remote = createFakeServices({
      hostId: "remote:server:source-a",
      name: "A",
      roots: ["/repo"],
    });
    const scope: WindowHostAttachmentScope = {
      kind: "remote",
      remoteSessionId: "sess-a2",
      workspacePath: "/repo",
      workspaceIdentity: canonicalA,
    };
    expect(
      resolveMobileProjectDirectoryAvailability({
        clientMode: "web-remote-replayable",
        attachmentScope: scope,
        services: remote.services,
        capabilities: { existingRuntimeAdmission: true },
      }),
    ).toBe(true);
    // 反例：本地服务完整、远端 capability 缺失时不得宣告目录。
    const local = createFakeServices({ hostId: "local", name: "Local", roots: ["/local/repo"] });
    expect(
      resolveMobileProjectDirectoryAvailability({
        clientMode: "web-remote-replayable",
        attachmentScope: scope,
        services: remote.services,
        capabilities: {},
      }),
    ).toBe(false);
    expect(
      resolveMobileProjectDirectoryAvailability({
        clientMode: "desktop-continuous",
        attachmentScope: scope,
        services: remote.services,
        capabilities: { existingRuntimeAdmission: true },
      }),
    ).toBe(false);
    expect(
      resolveMobileProjectDirectoryAvailability({
        clientMode: "web-remote-replayable",
        attachmentScope: { kind: "local" },
        services: emptyLocal,
      }),
    ).toBe(false);
    expect(
      resolveMobileProjectDirectoryAvailability({
        clientMode: "web-remote-replayable",
        attachmentScope: { kind: "local" },
        services: local.services,
      }),
    ).toBe(true);
  });
});

function createPortPair(): { a: MessagePortLike; b: MessagePortLike } {
  type Listener = (event: { data: MessagePortPayload }) => void;
  const listenersA = new Set<Listener>();
  const listenersB = new Set<Listener>();
  const make = (own: Set<Listener>, peer: Set<Listener>): MessagePortLike => ({
    addEventListener(_type, listener) {
      own.add(listener);
    },
    removeEventListener(_type, listener) {
      own.delete(listener);
    },
    postMessage(data) {
      // 真实 MessagePort 走结构化克隆；函数不可跨 RPC 传递，会在这里抛 DataCloneError。
      const cloned = structuredClone(data);
      setTimeout(() => {
        for (const listener of Array.from(peer)) listener({ data: cloned });
      }, 0);
    },
    start() {},
    close() {
      own.clear();
    },
  });
  return { a: make(listenersA, listenersB), b: make(listenersB, listenersA) };
}

describe("remote typed existing entry over a real ChannelServer/Client", () => {
  it("never serializes an in-process attachment callback across RPC", async () => {
    const pair = createPortPair();
    const serverProtocol = new MessagePortProtocol(pair.a);
    const server = new ChannelServer(serverProtocol, "host");
    const calls: unknown[][] = [];
    server.registerChannel(
      IZCodeTaskService.channelName,
      ProxyChannel.fromService({
        createTaskExistingRuntime: async (...args: unknown[]) => {
          calls.push(args);
          return { taskId: "remote-created" };
        },
      } as never),
    );
    const client = new ChannelClient(new MessagePortProtocol(pair.b));
    const remoteTasks = ProxyChannel.toService<IZCodeTaskService>(
      client.getChannel(IZCodeTaskService.channelName),
    );
    const runtime = runtimeFor("remote:server:source-a");
    const params = {
      workspacePath: "/repo",
      workspaceIdentity: canonicalA,
      remoteSessionId: "sess-a2",
    };
    const guarded = guardReplayableTaskCreation({
      tasks: remoteTasks,
      agent: { getWorkspaceRuntimeIdentity: vi.fn(async () => runtime) } as never,
      supported: true,
      localAdmission: false,
      assertTarget: () => {},
    });
    await expect(guarded.createTask(params as never)).resolves.toEqual({
      taskId: "remote-created",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(2);
    expect(calls[0]?.[0]).toMatchObject(params);
    expect(calls[0]?.[1]).toEqual(runtime);
    client.dispose();
    serverProtocol.disconnect();
    server.dispose();
  });

  it("passes the callback only for an in-process typed existing entry", async () => {
    const runtime = runtimeFor("local");
    const createTaskExistingRuntime = vi.fn(
      async (_params: unknown, _runtime: unknown, assert?: () => void) => {
        assert?.();
        return { taskId: "local-existing" };
      },
    );
    const guarded = guardReplayableTaskCreation({
      tasks: { createTaskExistingRuntime } as never,
      agent: { getWorkspaceRuntimeIdentity: vi.fn(async () => runtime) } as never,
      supported: true,
      localAdmission: false,
      inProcess: true,
      assertTarget: () => {},
    });
    await expect(guarded.createTask({ workspacePath: "/tmp/work" } as never)).resolves.toEqual({
      taskId: "local-existing",
    });
    expect(createTaskExistingRuntime).toHaveBeenCalledTimes(1);
    expect(createTaskExistingRuntime.mock.calls[0]).toHaveLength(3);
    expect(typeof createTaskExistingRuntime.mock.calls[0]?.[2]).toBe("function");
  });
});
