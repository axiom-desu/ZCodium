import { describe, expect, it, vi } from "vitest";
import { buildServerRemoteWorkspaceIdentity, type RemoteTarget } from "@zcode/shared";
import {
  createWindowRemoteConnectionRegistry,
  type WindowRemoteConnectionCloseEvent,
  type WindowRemoteConnectionHandle,
} from "./windowRemoteConnectionRegistry.js";

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

const sourceId = "11111111-1111-4111-8111-111111111111";
const target: RemoteTarget = { kind: "ssh", host: "example.test", username: "dev" };

interface FakeHandle extends WindowRemoteConnectionHandle<{ id: string }> {
  close(): void;
}

function createHandle(): FakeHandle {
  const listeners = new Set<(event: WindowRemoteConnectionCloseEvent) => void>();
  const handle: FakeHandle = {
    services: { id: "remote" },
    sourceServerId: sourceId,
    sourceServerAuthProofDigest: "proof",
    dispose() {},
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

function harness(options: {
  handle?: FakeHandle;
  prepareWorkspaceIdentity?: (
    handle: WindowRemoteConnectionHandle<{ id: string }>,
    input: {
      sourceServerId: string;
      workspacePath: string;
      stableWorkspaceIdentity: string;
      legacyRouteHint?: string;
      signal?: AbortSignal;
    },
  ) => Promise<void>;
  onSessionClosed?: (event: WindowRemoteConnectionCloseEvent & { remoteSessionId: string }) => void;
  releaseWorkspace?: (
    services: { id: string },
    context: { workspacePath: string; workspaceIdentity?: string },
  ) => Promise<void>;
}) {
  const handle = options.handle ?? createHandle();
  const registry = createWindowRemoteConnectionRegistry<{ id: string }>({
    connect: async () => handle,
    createId: (() => {
      let next = 0;
      return () => `session-${++next}`;
    })(),
    ...(options.prepareWorkspaceIdentity
      ? { prepareWorkspaceIdentity: options.prepareWorkspaceIdentity }
      : {}),
    ...(options.onSessionClosed ? { onSessionClosed: options.onSessionClosed } : {}),
    ...(options.releaseWorkspace ? { releaseWorkspace: options.releaseWorkspace } : {}),
  });
  return { registry, handle };
}

async function connectOnline(
  registry: ReturnType<typeof harness>["registry"],
  workspacePath = "/remote/project",
) {
  return await registry.connect({
    requestId: `req-${workspacePath}`,
    target,
    remoteAssets: {},
    workspacePath,
  });
}

async function waitForPending(pending: Array<Deferred<void>>, index: number): Promise<void> {
  for (let attempt = 0; attempt < 20 && !pending[index]; attempt += 1) {
    await Promise.resolve();
  }
  if (!pending[index]) throw new Error(`prepare call ${index} was not started`);
}

describe("registry 目录准备与生命周期 flight", () => {
  it("取消 bind 信号后不登记 ready，迟到结果不能写新 generation", async () => {
    const pending: Array<Deferred<void>> = [];
    let calls = 0;
    const handle = createHandle();
    const { registry } = harness({
      handle,
      prepareWorkspaceIdentity: () => {
        calls += 1;
        const next = deferred<void>();
        pending.push(next);
        return next.promise;
      },
    });
    const connecting = connectOnline(registry, "/remote/other");
    await waitForPending(pending, 0);
    pending[0]!.resolve();
    const descriptor = await connecting;
    calls = 0;
    const controller = new AbortController();
    const bind = registry.bindWorkspaceContext({
      remoteSessionId: descriptor.remoteSessionId,
      workspacePath: "/remote/project",
      workspaceIdentity: buildServerRemoteWorkspaceIdentity({
        serverId: sourceId,
        workspacePath: "/remote/project",
      }),
      signal: controller.signal,
    });
    expect(calls).toBe(1);
    controller.abort();
    await expect(bind).rejects.toMatchObject({ name: "AbortError" });
    await waitForPending(pending, 1);
    pending[1]!.resolve();
    await Promise.resolve();
    // 取消/迟到结果不能提交新 identity/generation，旧 attachment 仍可解析。
    const session = registry.getSession(descriptor.remoteSessionId);
    expect(session?.workspacePath).toBe("/remote/other");
    expect(session?.workspaceIdentity).toBe(descriptor.workspaceIdentity);
    expect(session?.generation).toBe(descriptor.generation);
    expect(
      registry.resolveScopedServices({
        kind: "remote",
        remoteSessionId: descriptor.remoteSessionId,
        workspacePath: "/remote/other",
        workspaceIdentity: descriptor.workspaceIdentity!,
      }),
    ).toBe(handle.services);
    expect(() =>
      registry.resolveScopedServices({
        kind: "remote",
        remoteSessionId: descriptor.remoteSessionId,
        workspacePath: "/remote/project",
        workspaceIdentity: buildServerRemoteWorkspaceIdentity({
          serverId: sourceId,
          workspacePath: "/remote/project",
        }),
      }),
    ).toThrow(/不匹配/u);
    await registry.dispose();
  });

  it("旧 generation 的目录准备不能覆盖新一代 bind", async () => {
    const pending: Array<Deferred<void>> = [];
    const { registry } = harness({
      prepareWorkspaceIdentity: () => {
        const next = deferred<void>();
        pending.push(next);
        return next.promise;
      },
    });
    const connecting = connectOnline(registry, "/remote/other");
    await waitForPending(pending, 0);
    pending[0]!.resolve();
    const descriptor = await connecting;
    const firstBind = registry.bindWorkspaceContext({
      remoteSessionId: descriptor.remoteSessionId,
      workspacePath: "/remote/a",
      workspaceIdentity: buildServerRemoteWorkspaceIdentity({
        serverId: sourceId,
        workspacePath: "/remote/a",
      }),
    });
    const secondBind = registry.bindWorkspaceContext({
      remoteSessionId: descriptor.remoteSessionId,
      workspacePath: "/remote/b",
      workspaceIdentity: buildServerRemoteWorkspaceIdentity({
        serverId: sourceId,
        workspacePath: "/remote/b",
      }),
    });
    await waitForPending(pending, 1);
    await waitForPending(pending, 2);
    pending[2]!.resolve();
    await expect(secondBind).resolves.toBeUndefined();
    pending[1]!.resolve();
    await expect(firstBind).rejects.toBeInstanceOf(Error);
    await registry.dispose();
  });

  it("WSL 取消 rebind 保留旧 session 与旧 workspace runtime", async () => {
    const pending: Array<Deferred<void>> = [];
    const releases: string[] = [];
    const { registry } = harness({
      prepareWorkspaceIdentity: () => {
        const next = deferred<void>();
        pending.push(next);
        return next.promise;
      },
      releaseWorkspace: async (_services, context) => {
        releases.push(context.workspacePath);
      },
    });
    const target = { kind: "wsl" as const, distro: "Ubuntu", user: "dev" };
    const connecting = registry.connect({
      requestId: "wsl-connect",
      target,
      remoteAssets: {},
      workspacePath: "/home/dev/a",
    });
    await waitForPending(pending, 0);
    pending[0]!.resolve();
    const descriptor = await connecting;
    const before = registry.getSession(descriptor.remoteSessionId);
    expect(before?.workspacePath).toBe("/home/dev/a");
    const generation = before!.generation;

    const controller = new AbortController();
    const bind = registry.bindWorkspaceContext({
      remoteSessionId: descriptor.remoteSessionId,
      workspacePath: "/home/dev/b",
      workspaceIdentity: buildServerRemoteWorkspaceIdentity({
        serverId: sourceId,
        workspacePath: "/home/dev/b",
      }),
      signal: controller.signal,
    });
    await waitForPending(pending, 1);
    controller.abort();
    await expect(bind).rejects.toMatchObject({ name: "AbortError" });
    pending[1]!.resolve();
    await Promise.resolve();
    const after = registry.getSession(descriptor.remoteSessionId);
    expect(after?.workspacePath).toBe("/home/dev/a");
    expect(after?.workspaceIdentity).toBe(descriptor.workspaceIdentity);
    expect(after?.generation).toBe(generation);
    // 取消没有释放旧 runtime，也没有登记候选 runtime。
    expect(releases).toEqual([]);
    await registry.dispose();
  });

  it("WSL 回到旧 workspace 时先等待目标 release，再提交新 generation", async () => {
    const pending: Array<Deferred<void>> = [];
    const releases: Array<{ path: string; resolve: () => void }> = [];
    const { registry } = harness({
      prepareWorkspaceIdentity: () => {
        const next = deferred<void>();
        pending.push(next);
        return next.promise;
      },
      releaseWorkspace: async (_services, context) => {
        if (context.workspacePath !== "/home/dev/a") return;
        const gate = deferred<void>();
        releases.push({ path: context.workspacePath, resolve: () => gate.resolve() });
        await gate.promise;
      },
    });
    const target = { kind: "wsl" as const, distro: "Ubuntu", user: "dev" };
    const connecting = registry.connect({
      requestId: "wsl-connect",
      target,
      remoteAssets: {},
      workspacePath: "/home/dev/a",
    });
    await waitForPending(pending, 0);
    pending[0]!.resolve();
    const descriptor = await connecting;

    const bindB = registry.bindWorkspaceContext({
      remoteSessionId: descriptor.remoteSessionId,
      workspacePath: "/home/dev/b",
      workspaceIdentity: buildServerRemoteWorkspaceIdentity({
        serverId: sourceId,
        workspacePath: "/home/dev/b",
      }),
    });
    await waitForPending(pending, 1);
    pending[1]!.resolve();
    await bindB;
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    expect(registry.getSession(descriptor.remoteSessionId)?.workspacePath).toBe("/home/dev/b");

    const backToA = registry.bindWorkspaceContext({
      remoteSessionId: descriptor.remoteSessionId,
      workspacePath: "/home/dev/a",
      workspaceIdentity: buildServerRemoteWorkspaceIdentity({
        serverId: sourceId,
        workspacePath: "/home/dev/a",
      }),
    });
    await waitForPending(pending, 2);
    pending[2]!.resolve();
    // 目标 workspace 的上一代 release 尚未完成时不得提交，旧 session 继续可用。
    await Promise.resolve();
    expect(registry.getSession(descriptor.remoteSessionId)?.workspacePath).toBe("/home/dev/b");
    releases[0]!.resolve();
    await backToA;
    expect(registry.getSession(descriptor.remoteSessionId)?.workspacePath).toBe("/home/dev/a");
    await registry.dispose();
  });

  it("同一 Source 的 lifecycle flight 互斥，本机阶段可取消", async () => {
    const { registry } = harness({});
    await connectOnline(registry);
    const flight = registry.beginSourceLifecycleOperation({
      kind: "update",
      profileId: "profile-a",
      sourceServerId: sourceId,
    });
    flight.setLocalStageCancelable(true);
    expect(() =>
      registry.beginSourceLifecycleOperation({
        kind: "restart",
        profileId: "profile-a",
        sourceServerId: sourceId,
      }),
    ).toThrowError(/生命周期操作进行中/);
    expect(registry.cancelSourceUpdateLocalStage("profile-a")).toBe(true);
    expect(flight.signal.aborted).toBe(true);
    flight.end();
    const next = registry.beginSourceLifecycleOperation({
      kind: "update",
      profileId: "profile-a",
      sourceServerId: sourceId,
    });
    next.setLocalStageCancelable(false);
    expect(registry.cancelSourceUpdateLocalStage("profile-a")).toBe(false);
    next.end();
    await registry.dispose();
  });

  it("停机/重启期间旧连接 close 是预期断线，不走普通 sessionClosed", async () => {
    const closed: string[] = [];
    const { registry, handle } = harness({
      onSessionClosed: (event) => closed.push(event.remoteSessionId),
    });
    await connectOnline(registry);
    const flight = registry.beginSourceLifecycleOperation({
      kind: "restart",
      profileId: "profile-a",
      sourceServerId: sourceId,
    });
    handle.close();
    expect(closed).toEqual([]);
    flight.end();
    await registry.dispose();
  });
});
