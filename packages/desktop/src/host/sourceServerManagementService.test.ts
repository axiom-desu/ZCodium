import { describe, expect, it } from "vitest";
import type { ConnectionProfile, RemoteTarget } from "@zcode/shared";
import { getSourceServerUpdateTarget } from "@zcode/shared";
import type { SourceServerDirectory } from "./sourceServerDirectory.js";
import {
  createSourceServerManagementService,
  type SourceServerManagementRuntime,
} from "./sourceServerManagementService.js";

type FakeDirectory = SourceServerDirectory & {
  readonly removedSources: string[];
  readonly handshakes: Array<{ profileId: string; sourceServerId: string }>;
  readonly ensuredTargets: RemoteTarget[];
  readonly profileUpdates: Array<{ profileId: string; profileDisplayName: string }>;
};

function createDirectory(input: {
  profiles: ConnectionProfile[];
  servers?: Array<{
    sourceServerId: string;
    displayName: string;
    installState: "installed" | "uninstalled";
    declaredWorkspaces: never[];
    preferredProfileId?: string;
  }>;
  resolveTarget?: (profile: ConnectionProfile) => RemoteTarget;
  failRemove?: Error;
}): FakeDirectory {
  const profiles = structuredClone(input.profiles);
  const servers = structuredClone(
    input.servers ?? [
      {
        sourceServerId: "11111111-1111-4111-8111-111111111111",
        displayName: "source",
        installState: "installed" as const,
        declaredWorkspaces: [],
      },
    ],
  );
  const removedSources: string[] = [];
  const handshakes: Array<{ profileId: string; sourceServerId: string }> = [];
  const ensuredTargets: RemoteTarget[] = [];
  const profileUpdates: Array<{ profileId: string; profileDisplayName: string }> = [];
  const directory = {
    async snapshot() {
      return {
        profiles: structuredClone(profiles),
        servers: structuredClone(servers),
        workspaceHistory: [],
      };
    },
    async findProfile(profileId: string) {
      return structuredClone(profiles.find((profile) => profile.profileId === profileId));
    },
    async preferredProfile(sourceServerId: string) {
      return structuredClone(profiles.find((profile) => profile.sourceServerId === sourceServerId));
    },
    async resolveProfileTarget(profile: ConnectionProfile) {
      return structuredClone(input.resolveTarget?.(profile) ?? profile.target);
    },
    async recordHandshake(profileId: string, handshake: { sourceServerId: string }) {
      handshakes.push({ profileId, sourceServerId: handshake.sourceServerId });
      return { identityChanged: false, effectiveProfileId: profileId, effectiveProfile: profile };
    },
    async ensureProfile(target: RemoteTarget) {
      ensuredTargets.push(structuredClone(target));
      const existing = profiles.find((candidate) => candidate.transport === target.kind);
      if (existing) return structuredClone(existing);
      const {
        password: _password,
        privateKeyPassphrase: _passphrase,
        ...storedTarget
      } = target as Extract<RemoteTarget, { kind: "ssh" }>;
      const created = {
        profileId: "33333333-3333-4333-8333-333333333333",
        transport: target.kind,
        target: structuredClone(storedTarget),
        displayName: "created",
        createdAt: 2,
        lifecycleState: "active",
      } as unknown as ConnectionProfile;
      profiles.push(created);
      return structuredClone(created);
    },
    async renameSource() {},
    async renameProfile() {},
    async updateProfile(input: { profileId: string; profileDisplayName: string }) {
      profileUpdates.push({
        profileId: input.profileId,
        profileDisplayName: input.profileDisplayName,
      });
    },
    async setPreferredProfile() {},
    async removeProfile() {},
    async removeSource(sourceServerId: string) {
      if (input.failRemove) throw input.failRemove;
      removedSources.push(sourceServerId);
    },
    onDidChange() {
      return () => undefined;
    },
  } as unknown as FakeDirectory;
  return Object.assign(directory, {
    removedSources,
    handshakes,
    ensuredTargets,
    profileUpdates,
  });
}

function profile(
  transport: "ssh" | "wsl" | "docker",
  target: RemoteTarget,
  sourceServerId = "11111111-1111-4111-8111-111111111111",
): ConnectionProfile {
  return {
    profileId: "22222222-2222-4222-8222-222222222222",
    transport,
    target,
    displayName: "profile",
    createdAt: 1,
    lifecycleState: "active",
    sourceServerId,
  } as ConnectionProfile;
}

function runtime(
  overrides: Partial<SourceServerManagementRuntime> = {},
): SourceServerManagementRuntime {
  return {
    async connect() {
      return { sourceServerId: "11111111-1111-4111-8111-111111111111", version: "3.16.2" };
    },
    async update() {
      return { sourceServerId: "11111111-1111-4111-8111-111111111111", version: "3.16.2" };
    },
    async disconnect() {},
    isOnline() {
      return false;
    },
    ...overrides,
  };
}

describe("SourceServerManagementService", () => {
  it("returns a typed snapshot with online state and no credentials", async () => {
    const directory = createDirectory({
      profiles: [profile("ssh", { kind: "ssh", host: "example.test", username: "alice" })],
    });
    const service = createSourceServerManagementService({
      directory,
      runtime: runtime({
        isOnline: () => true,
        currentVersion: () => "3.16.2",
      }),
    });
    const snapshot = await service.getSnapshot();
    expect(snapshot.states[0]).toMatchObject({
      profileId: "22222222-2222-4222-8222-222222222222",
      sourceServerId: "11111111-1111-4111-8111-111111111111",
      state: "online",
      currentVersion: "3.16.2",
    });
    expect(JSON.stringify(snapshot)).not.toContain("password");
    expect(snapshot.migrationCounts[0]).toEqual({
      sourceServerId: "11111111-1111-4111-8111-111111111111",
      status: "available",
      failedPathCount: 0,
      abandonedPathCount: 0,
    });
    service.dispose();
  });

  it("passes the explicit install confirmation to the runtime and records the handshake", async () => {
    const directory = createDirectory({
      profiles: [profile("ssh", { kind: "ssh", host: "example.test", username: "alice" })],
    });
    let observedConfirm: boolean | undefined;
    const service = createSourceServerManagementService({
      directory,
      runtime: runtime({
        async connect(input) {
          observedConfirm = input.confirmSourceServerInstall;
          return { sourceServerId: "11111111-1111-4111-8111-111111111111", version: "3.16.2" };
        },
        isOnline: () => true,
      }),
    });
    await service.connectProfile("22222222-2222-4222-8222-222222222222", {
      confirmSourceServerInstall: true,
    });
    expect(observedConfirm).toBe(true);
    expect(directory.handshakes).toEqual([
      {
        profileId: "22222222-2222-4222-8222-222222222222",
        sourceServerId: "11111111-1111-4111-8111-111111111111",
      },
    ]);
    service.dispose();
  });

  it("publishes needs-install state for a typed install gate without faking online", async () => {
    const directory = createDirectory({
      profiles: [profile("ssh", { kind: "ssh", host: "example.test", username: "alice" })],
    });
    const service = createSourceServerManagementService({
      directory,
      runtime: runtime({
        async connect() {
          throw Object.assign(new Error("install required"), {
            code: "source-server-install-required",
          });
        },
      }),
    });
    await expect(service.connectProfile("22222222-2222-4222-8222-222222222222")).rejects.toThrow(
      /install required/u,
    );
    const snapshot = await service.getSnapshot();
    expect(snapshot.states[0]).toMatchObject({
      state: "needs-install",
      errorCode: "source-server-install-required",
    });
    expect(snapshot.states[0]?.state).not.toBe("online");
    service.dispose();
  });

  it("rejects a target that changed while the profile target was being resolved", async () => {
    const target: RemoteTarget = {
      kind: "ssh",
      host: "example.test",
      username: "alice",
      port: 22,
    };
    const directory = createDirectory({
      profiles: [profile("ssh", target)],
      resolveTarget: () => ({
        kind: "ssh",
        host: "other.example.test",
        username: "alice",
        port: 22,
      }),
    });
    let updateCalled = false;
    const service = createSourceServerManagementService({
      directory,
      runtime: runtime({
        async update() {
          updateCalled = true;
          return {};
        },
      }),
    });
    await expect(
      service.updateSource({
        profileId: "22222222-2222-4222-8222-222222222222",
        expectedTarget: getSourceServerUpdateTarget(target as never),
        force: true,
      }),
    ).rejects.toMatchObject({ code: "remote-target-changed" });
    expect(updateCalled).toBe(false);
    service.dispose();
  });

  it("rejects an install confirmation whose expected target no longer matches", async () => {
    const directory = createDirectory({
      profiles: [profile("ssh", { kind: "ssh", host: "example.test", username: "alice" })],
    });
    let connectCalled = false;
    const service = createSourceServerManagementService({
      directory,
      runtime: runtime({
        async connect() {
          connectCalled = true;
          return {};
        },
      }),
    });
    await expect(
      service.connectProfile("22222222-2222-4222-8222-222222222222", {
        confirmSourceServerInstall: true,
        expectedTarget: getSourceServerUpdateTarget({
          kind: "ssh",
          host: "other.example.test",
          username: "alice",
          port: 22,
        }),
      }),
    ).rejects.toMatchObject({ code: "remote-target-changed" });
    expect(connectCalled).toBe(false);
    service.dispose();
  });

  it("rejects a target that changed while credentials were being resolved", async () => {
    const directory = createDirectory({
      profiles: [profile("ssh", { kind: "ssh", host: "example.test", username: "alice" })],
      resolveTarget: () => ({ kind: "ssh", host: "changed.example.test", username: "alice" }),
    });
    let connectCalled = false;
    const service = createSourceServerManagementService({
      directory,
      runtime: runtime({
        async connect() {
          connectCalled = true;
          return {};
        },
      }),
    });
    await expect(
      service.connectProfile("22222222-2222-4222-8222-222222222222", {
        confirmSourceServerInstall: true,
        expectedTarget: getSourceServerUpdateTarget({
          kind: "ssh",
          host: "example.test",
          username: "alice",
          port: 22,
        }),
      }),
    ).rejects.toMatchObject({ code: "remote-target-changed" });
    expect(connectCalled).toBe(false);
    service.dispose();
  });

  it("removes a Source only after disconnecting and cleaning Host attachments", async () => {
    const order: string[] = [];
    const directory = createDirectory({
      profiles: [profile("ssh", { kind: "ssh", host: "example.test", username: "alice" })],
      servers: [
        {
          sourceServerId: "11111111-1111-4111-8111-111111111111",
          displayName: "source",
          installState: "installed",
          declaredWorkspaces: [],
        },
      ],
    });
    const removeSource = directory.removeSource.bind(directory);
    directory.removeSource = async (sourceServerId: string) => {
      order.push("directory");
      return removeSource(sourceServerId);
    };
    const service = createSourceServerManagementService({
      directory,
      runtime: runtime({
        async disconnect(sourceServerId) {
          order.push(`disconnect:${sourceServerId}`);
        },
      }),
      onBeforeSourceRemoved: async (sourceServerId) => {
        order.push(`attachment:${sourceServerId}`);
      },
    });
    await service.removeSource("11111111-1111-4111-8111-111111111111");
    expect(order).toEqual([
      "disconnect:11111111-1111-4111-8111-111111111111",
      "attachment:11111111-1111-4111-8111-111111111111",
      "directory",
    ]);
    service.dispose();
  });

  it("refuses removal without the Host attachment cleanup callback", async () => {
    const directory = createDirectory({
      profiles: [profile("ssh", { kind: "ssh", host: "example.test", username: "alice" })],
    });
    const service = createSourceServerManagementService({ directory, runtime: runtime() });
    await expect(
      service.removeSource("11111111-1111-4111-8111-111111111111"),
    ).rejects.toMatchObject({
      code: "source-server-remove-callback-missing",
    });
    service.dispose();
  });

  it("classifies a persistence failure during removal without deleting runtime state twice", async () => {
    const directory = createDirectory({
      profiles: [profile("ssh", { kind: "ssh", host: "example.test", username: "alice" })],
      failRemove: new Error("settings write failed"),
    });
    const service = createSourceServerManagementService({
      directory,
      runtime: runtime(),
      onBeforeSourceRemoved: async () => undefined,
    });
    await expect(
      service.removeSource("11111111-1111-4111-8111-111111111111"),
    ).rejects.toMatchObject({
      code: "source-server-remove-persist-failed",
    });
    service.dispose();
  });

  it("createProfile 复用 directory 的凭据 owner 并保留显示名更新", async () => {
    const directory = createDirectory({ profiles: [] });
    const service = createSourceServerManagementService({ directory, runtime: runtime() });
    const snapshot = await service.createProfile({
      target: {
        kind: "ssh",
        host: "example.test",
        username: "alice",
        password: "secret-password",
      },
      profileDisplayName: "Build box",
      sourceDisplayName: "Build source",
    });
    expect(directory.ensuredTargets).toEqual([
      {
        kind: "ssh",
        host: "example.test",
        username: "alice",
        password: "secret-password",
      },
    ]);
    expect(directory.profileUpdates).toEqual([
      { profileId: "33333333-3333-4333-8333-333333333333", profileDisplayName: "Build box" },
    ]);
    expect(snapshot.profiles).toHaveLength(1);
    // 口令只交给 directory/credential port；管理快照不包含明文。
    expect(JSON.stringify(snapshot)).not.toContain("secret-password");
    service.dispose();
  });

  it("createProfile 拒绝 server 直连 target，不伪造 profile", async () => {
    const directory = createDirectory({ profiles: [] });
    const service = createSourceServerManagementService({ directory, runtime: runtime() });
    await expect(
      service.createProfile({
        target: { kind: "server", url: "https://studio.example" } as never,
      }),
    ).rejects.toMatchObject({ code: "source-server-profile-unsupported-transport" });
    expect(directory.ensuredTargets).toEqual([]);
    service.dispose();
  });
});
