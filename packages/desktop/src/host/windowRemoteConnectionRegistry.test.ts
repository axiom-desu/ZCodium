import { describe, expect, it } from "vitest";
import { buildRemoteWorkspaceIdentity, type RemoteTarget } from "@zcode/shared";
import {
  createWindowRemoteConnectionRegistry,
  type WindowRemoteConnectionConnectRequest,
  type WindowRemoteConnectionHandle,
} from "./windowRemoteConnectionRegistry.js";

interface TestServices {
  id: string;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

interface FakeHandle extends WindowRemoteConnectionHandle<TestServices> {
  disposed: boolean;
  close(): void;
}

function createFakeHandle(sourceServerId?: string, authProof = "proof-shared"): FakeHandle {
  const listeners = new Set<(event: { exitCode: number | null; signal: string | null }) => void>();
  const handle: FakeHandle = {
    services: { id: sourceServerId ?? "unknown" },
    ...(sourceServerId ? { sourceServerId } : {}),
    ...(authProof ? { sourceServerAuthProofDigest: authProof } : {}),
    virtualProjects: false,
    disposed: false,
    dispose() {
      handle.disposed = true;
      listeners.clear();
    },
    onDidClose(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    close() {
      for (const listener of listeners) listener({ exitCode: 1, signal: null });
    },
  };
  return handle;
}

const serverTarget = (url: string, serverId?: string): RemoteTarget => ({
  kind: "server",
  url,
  ...(serverId ? { serverId } : {}),
});

interface RegistryHarness {
  registry: ReturnType<typeof createWindowRemoteConnectionRegistry<TestServices>>;
  requests: WindowRemoteConnectionConnectRequest[];
  handles: FakeHandle[];
  connect: (params: {
    requestId: string;
    target: RemoteTarget;
    workspacePath?: string;
    workspaceIdentity?: string;
    workspacePurpose?: "project" | "conversation";
    confirmSourceServerInstall?: boolean;
    existingSourceServerId?: string;
  }) => ReturnType<
    ReturnType<typeof createWindowRemoteConnectionRegistry<TestServices>>["connect"]
  >;
}

function createHarness(options: {
  /** 每个 connect 请求要返回的 handle；可用 deferred 控制完成时机。 */
  handleFor: (
    request: WindowRemoteConnectionConnectRequest,
  ) => FakeHandle | Promise<FakeHandle> | Deferred<FakeHandle>;
}): RegistryHarness {
  const requests: WindowRemoteConnectionConnectRequest[] = [];
  const handles: FakeHandle[] = [];
  const registry = createWindowRemoteConnectionRegistry<TestServices>({
    connect: async (request) => {
      requests.push(request);
      const value = options.handleFor(request);
      const handle = await ("promise" in value ? value.promise : value);
      handles.push(handle);
      return handle;
    },
    createId: (() => {
      let next = 0;
      return () => `session-${++next}`;
    })(),
  });
  return {
    registry,
    requests,
    handles,
    connect: (params) =>
      registry.connect({
        requestId: params.requestId,
        target: params.target,
        remoteAssets: {},
        ...(params.workspacePath ? { workspacePath: params.workspacePath } : {}),
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        ...(params.workspacePurpose ? { workspacePurpose: params.workspacePurpose } : {}),
        ...(params.confirmSourceServerInstall ? { confirmSourceServerInstall: true } : {}),
        ...(params.existingSourceServerId
          ? { existingSourceServerId: params.existingSourceServerId }
          : {}),
      }),
  };
}

describe("window remote connection registry Source claims", () => {
  it("lets only one owner win when two profiles point at the same Source", async () => {
    const harness = createHarness({ handleFor: () => createFakeHandle("source-1") });

    const first = await harness.connect({
      requestId: "r1",
      target: serverTarget("http://127.0.0.1:1001"),
      workspacePath: "/work-a",
    });
    const second = await harness.connect({
      requestId: "r2",
      target: serverTarget("http://127.0.0.1:1002"),
      workspacePath: "/work-b",
    });

    expect(first.sourceServerId).toBe("source-1");
    expect(second.sourceServerId).toBe("source-1");
    // 第二个 profile 复用了已在线 owner：显式回传复用事实，并释放自己的重复连接。
    expect(second.reusedConnectionTarget).toBeDefined();
    expect(harness.handles).toHaveLength(2);
    expect(harness.handles[1]!.disposed).toBe(true);
    expect(harness.handles[0]!.disposed).toBe(false);
    expect(harness.registry.getStats()).toMatchObject({
      connectionCount: 1,
      logicalSessionCount: 2,
      sourceCount: 1,
    });
    const online = harness.registry.getOnlineSource("source-1");
    expect(online?.services).toBe(harness.handles[0]!.services);
  });

  it("shares one owner connection across workspaces of the same Source", async () => {
    const harness = createHarness({ handleFor: () => createFakeHandle("source-1") });
    await harness.connect({
      requestId: "r1",
      target: serverTarget("http://127.0.0.1:1001"),
      workspacePath: "/work-a",
      workspaceIdentity: "remote:server:source-1:/work-a",
    });
    await harness.connect({
      requestId: "r2",
      target: serverTarget("http://127.0.0.1:1001"),
      workspacePath: "/work-b",
    });

    // 同一 target 走同一 entry，不会为第二个 workspace 建立第二条连接。
    expect(harness.handles).toHaveLength(1);
    expect(harness.registry.getStats()).toMatchObject({
      connectionCount: 1,
      logicalSessionCount: 2,
    });
  });

  it("refuses an identity change instead of routing the old session to a new Source", async () => {
    const harness = createHarness({ handleFor: () => createFakeHandle("source-new") });

    const error = await harness
      .connect({
        requestId: "r1",
        target: serverTarget("http://127.0.0.1:1001"),
        workspacePath: "/work",
        existingSourceServerId: "source-old",
      })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: "source-server-identity-change-pending" });
    expect(harness.registry.getOnlineSource("source-new")).toBeNull();
    expect(harness.registry.getStats().sourceCount).toBe(0);
    // 迟到/不匹配的连接不能留下在线资源。
    expect(harness.handles[0]!.disposed).toBe(true);
  });

  it("takes Source identity from the authenticated handshake, not the advertised target id", async () => {
    const harness = createHarness({ handleFor: () => createFakeHandle("source-real") });
    const descriptor = await harness.connect({
      requestId: "r1",
      target: serverTarget("http://127.0.0.1:1001", "advertised-wrong"),
      workspacePath: "/work",
    });

    expect(descriptor.sourceServerId).toBe("source-real");
    expect(descriptor.target).toMatchObject({ kind: "server", serverId: "source-real" });
    expect(descriptor.workspaceIdentity).toBe("remote:server:source-real:/work");
    expect(harness.registry.getSession(descriptor.remoteSessionId)?.target).toMatchObject({
      serverId: "source-real",
    });
  });

  it("returns the handshake Source id before directory selection without inventing identity", async () => {
    const harness = createHarness({ handleFor: () => createFakeHandle("source-real") });
    const descriptor = await harness.connect({
      requestId: "r1",
      target: serverTarget("http://127.0.0.1:1001", "advertised-wrong"),
    });

    expect(descriptor.sourceServerId).toBe("source-real");
    expect(descriptor.target).toMatchObject({ kind: "server", serverId: "source-real" });
    // 没有真实 workspacePath 时不能从 name/URL 造 canonical identity。
    expect(descriptor.workspaceIdentity).toBeUndefined();
  });

  it("rejects unproven renderer hints without changing the Source descriptor", async () => {
    const harness = createHarness({ handleFor: () => createFakeHandle("source-real") });
    const descriptor = await harness.connect({
      requestId: "r1",
      target: serverTarget("http://127.0.0.1:1001"),
      workspacePath: "/work",
    });

    expect(() =>
      harness.registry.bindWorkspaceContext({
        remoteSessionId: descriptor.remoteSessionId,
        workspacePath: "/srv/app",
        workspaceIdentity: "remote:server:attacker-declared:/srv/app",
        legacyRouteHint: "remote:server:legacy-name:/srv/app",
      }),
    ).toThrowError(expect.objectContaining({ code: "source-server-identity-change-pending" }));

    const session = harness.registry.getSession(descriptor.remoteSessionId);
    expect(session?.workspaceIdentity).toBe(descriptor.workspaceIdentity);
    expect(session?.workspacePath).toBe("/work");
    expect(session?.generation).toBe(descriptor.generation);
  });

  it("cancels a pending connect without registering or leaking a late owner", async () => {
    const pending = deferred<FakeHandle>();
    const harness = createHarness({ handleFor: () => pending });

    const connecting = harness.connect({
      requestId: "r1",
      target: serverTarget("http://127.0.0.1:1001"),
      workspacePath: "/work",
    });
    const settled = connecting.catch((caught: unknown) => caught);
    harness.registry.cancelConnect("r1");
    pending.resolve(createFakeHandle("source-1"));

    const error = await settled;
    expect(error).toBeInstanceOf(Error);
    expect(harness.registry.getStats().sourceCount).toBe(0);
    expect(harness.registry.getOnlineSource("source-1")).toBeNull();
    // 迟到成功必须释放自己的 transport，不能复活已取消的 session。
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.handles).toHaveLength(1);
    expect(harness.handles[0]).toMatchObject({ disposed: true });
  });

  it("keeps the verified legacy route as primary identity, not a canonical alias", async () => {
    const target = { kind: "ssh" as const, host: "example.test", username: "dev" };
    const legacyIdentity = buildRemoteWorkspaceIdentity("/work", target);
    const harness = createHarness({ handleFor: () => createFakeHandle("source-1") });

    const descriptor = await harness.connect({
      requestId: "r1",
      target,
      workspacePath: "/work",
      workspaceIdentity: legacyIdentity,
    });

    expect(descriptor.workspaceIdentity).toBe(legacyIdentity);
    const session = harness.registry.getSession(descriptor.remoteSessionId);
    expect(session?.workspaceIdentity).toBe(legacyIdentity);
    // 旧 route identity 的历史/队列仍可定位同一 session，但不会与其它路径合并。
    expect(
      harness.registry.findSessionForWorkspace({
        workspacePath: "/work",
        workspaceIdentity: legacyIdentity,
      })?.remoteSessionId,
    ).toBe(descriptor.remoteSessionId);
    expect(
      harness.registry.findSessionForWorkspace({
        workspacePath: "/other",
        workspaceIdentity: legacyIdentity,
      }),
    ).toBeNull();
  });

  it("verifies a legacy route hint on bind before using it as the primary key", async () => {
    const target = { kind: "ssh" as const, host: "example.test", username: "dev" };
    const legacyIdentity = buildRemoteWorkspaceIdentity("/work", target);
    const harness = createHarness({ handleFor: () => createFakeHandle("source-1") });
    const descriptor = await harness.connect({ requestId: "r1", target, workspacePath: "/work" });

    await harness.registry.bindWorkspaceContext({
      remoteSessionId: descriptor.remoteSessionId,
      workspacePath: "/work",
      workspaceIdentity: descriptor.workspaceIdentity!,
      workspacePurpose: "project",
      legacyRouteHint: legacyIdentity,
    });

    const session = harness.registry.getSession(descriptor.remoteSessionId);
    expect(session?.workspaceIdentity).toBe(legacyIdentity);
    expect(session?.workspacePurpose).toBe("project");
    expect(session?.generation).toBeGreaterThan(descriptor.generation);
  });

  it("resolves source-scoped services only while the Source owner is online", async () => {
    const harness = createHarness({ handleFor: () => createFakeHandle("source-1") });
    const descriptor = await harness.connect({
      requestId: "r1",
      target: serverTarget("http://127.0.0.1:1001"),
      workspacePath: "/work",
    });

    expect(harness.registry.resolveSourceScopedServices("source-1")).toBe(
      harness.handles[0]!.services,
    );
    expect(() => harness.registry.resolveSourceScopedServices("source-missing")).toThrow(
      /source-missing/u,
    );

    // 连接断开后 Source 索引必须消失，不能留下可解析的假在线。
    harness.handles[0]!.close();
    expect(harness.registry.getOnlineSource("source-1")).toBeNull();
    expect(harness.registry.getStats().sourceCount).toBe(0);
    expect(descriptor.sourceServerId).toBe("source-1");
  });

  it("does not merge same source id without the same authorization proof", async () => {
    const harness = createHarness({
      handleFor: (request) =>
        createFakeHandle(
          "source-1",
          request.target.kind === "server" && request.target.url.endsWith("1002")
            ? "proof-a"
            : "proof-b",
        ),
    });
    await harness.connect({
      requestId: "r1",
      target: serverTarget("http://127.0.0.1:1001"),
      workspacePath: "/work-a",
    });
    harness.requests.length = 0;
    const error = await harness
      .connect({
        requestId: "r2",
        target: serverTarget("http://127.0.0.1:1002"),
        workspacePath: "/work-b",
      })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "source-server-identity-change-pending" });
    // 第二个连接及其迟到资源必须释放，不能成为同一 Source 的第二个在线 owner。
    expect(harness.registry.getStats()).toMatchObject({ sourceCount: 1 });
    expect(harness.handles[1]!.disposed).toBe(true);
  });

  it("keeps two legacy identities on the same path as two logical contexts", async () => {
    const targetA = { kind: "ssh" as const, host: "example.test", username: "alice" };
    const targetB = { ...targetA, username: "bob" };
    const harness = createHarness({ handleFor: () => createFakeHandle("source-1") });
    const first = await harness.connect({
      requestId: "r1",
      target: targetA,
      workspacePath: "/work",
      workspaceIdentity: buildRemoteWorkspaceIdentity("/work", targetA),
    });
    const second = await harness.connect({
      requestId: "r2",
      target: targetB,
      workspacePath: "/work",
      workspaceIdentity: buildRemoteWorkspaceIdentity("/work", targetB),
    });

    expect(first.remoteSessionId).not.toBe(second.remoteSessionId);
    expect(harness.registry.getStats()).toMatchObject({
      connectionCount: 1,
      logicalSessionCount: 2,
      sourceCount: 1,
    });
    expect(
      harness.registry.findSessionForWorkspace({
        workspacePath: "/work",
        workspaceIdentity: buildRemoteWorkspaceIdentity("/work", targetA),
      })?.remoteSessionId,
    ).toBe(first.remoteSessionId);
    expect(
      harness.registry.findSessionForWorkspace({
        workspacePath: "/work",
        workspaceIdentity: buildRemoteWorkspaceIdentity("/work", targetB),
      })?.remoteSessionId,
    ).toBe(second.remoteSessionId);
  });

  it("disposes only the requested Source owner and its logical sessions", async () => {
    const harness = createHarness({ handleFor: () => createFakeHandle("source-1") });
    const descriptor = await harness.connect({
      requestId: "r1",
      target: serverTarget("http://127.0.0.1:1001"),
      workspacePath: "/work",
    });
    await harness.registry.disposeSource("source-1");
    expect(harness.registry.getOnlineSource("source-1")).toBeNull();
    expect(harness.registry.getSession(descriptor.remoteSessionId)).toBeNull();
    expect(harness.handles[0]!.disposed).toBe(true);
  });

  it("passes install confirmation and existing Source id through to the transport", async () => {
    const harness = createHarness({ handleFor: () => createFakeHandle("source-1") });
    await harness.connect({
      requestId: "r1",
      target: serverTarget("http://127.0.0.1:1001"),
      confirmSourceServerInstall: true,
      existingSourceServerId: "source-1",
    });
    expect(harness.requests[0]).toMatchObject({
      confirmSourceServerInstall: true,
      existingSourceServerId: "source-1",
    });
  });
});
