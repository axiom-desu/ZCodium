import { describe, expect, it, vi } from "vitest";
import {
  SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE,
  SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE,
  SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE,
  type ConnectionProfile,
  type RemoteTarget,
  type SourceServerManagementSnapshot,
} from "@zcode/shared";
import {
  prepareSourceConnection,
  type SourceConnectionManagementPort,
} from "@/lib/sourceServerWizardFlow.js";

function snapshot(
  overrides: Partial<SourceServerManagementSnapshot> = {},
): SourceServerManagementSnapshot {
  return {
    generation: 1,
    profiles: [],
    servers: [],
    workspaceHistory: [],
    states: [],
    failedPathCount: 0,
    abandonedPathCount: 0,
    migrationCounts: [],
    ...overrides,
  };
}

const sshProfile: ConnectionProfile = {
  profileId: "22222222-2222-4222-8222-222222222222",
  transport: "ssh",
  target: { kind: "ssh", host: "host.example", port: 22, username: "dev" },
  displayName: "Build box",
  createdAt: 1,
  lifecycleState: "active",
} as ConnectionProfile;

function createManagement(overrides: Partial<SourceConnectionManagementPort> = {}) {
  const connectProfile = vi.fn(async () => snapshot({ generation: 2, profiles: [sshProfile] }));
  const createProfile = vi.fn(async () => snapshot({ generation: 2, profiles: [sshProfile] }));
  const updateSource = vi.fn(async () => snapshot({ generation: 3, profiles: [sshProfile] }));
  const getSnapshot = vi.fn(async () => snapshot({ profiles: [sshProfile] }));
  const management: SourceConnectionManagementPort = {
    getSnapshot,
    createProfile,
    connectProfile,
    updateSource,
    ...overrides,
  };
  // 返回“生效”的 mock：覆盖项优先，调用断言必须针对实际注入 management 的函数。
  return {
    management,
    connectProfile: management.connectProfile as typeof connectProfile,
    createProfile: management.createProfile as typeof createProfile,
    updateSource: management.updateSource as typeof updateSource,
    getSnapshot: management.getSnapshot as typeof getSnapshot,
  };
}

const sshTarget: RemoteTarget = {
  kind: "ssh",
  host: "host.example",
  port: 22,
  username: "dev",
  password: "secret",
};

describe("Source 连接编排", () => {
  it("server 直连与缺少管理端口时跳过 profile 编排", async () => {
    const { management, connectProfile, createProfile } = createManagement();
    await expect(
      prepareSourceConnection({
        management,
        target: { kind: "server", url: "https://studio.example" },
        snapshot: snapshot(),
      }),
    ).resolves.toEqual({ kind: "skipped" });
    await expect(
      prepareSourceConnection({
        management: undefined,
        target: sshTarget,
        snapshot: snapshot(),
      }),
    ).resolves.toEqual({ kind: "skipped" });
    expect(connectProfile).not.toHaveBeenCalled();
    expect(createProfile).not.toHaveBeenCalled();
  });

  it("已有 profile 时直接连接，并冻结规范化的 expectedTarget", async () => {
    const { management, connectProfile } = createManagement();
    const result = await prepareSourceConnection({
      management,
      target: sshTarget,
      snapshot: snapshot({ profiles: [sshProfile] }),
    });
    expect(connectProfile).toHaveBeenCalledWith(sshProfile.profileId, {
      confirmSourceServerInstall: false,
      expectedTarget: { kind: "ssh", host: "host.example", port: 22, username: "dev" },
    });
    expect(result).toMatchObject({ kind: "ready", profileId: sshProfile.profileId });
  });

  it("没有 profile 时先经管理 ABI 建 profile，再连接", async () => {
    const { management, createProfile, connectProfile } = createManagement();
    const result = await prepareSourceConnection({
      management,
      target: sshTarget,
      snapshot: snapshot(),
      profileDisplayName: "Build box",
    });
    expect(createProfile).toHaveBeenCalledWith({
      target: sshTarget,
      profileDisplayName: "Build box",
    });
    expect(connectProfile).toHaveBeenCalled();
    expect(result).toMatchObject({ kind: "ready" });
  });

  it("未确认安装只返回 preview 与冻结目标，不创建连接", async () => {
    const error = Object.assign(new Error("install"), {
      code: SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE,
    });
    const installSnapshot = snapshot({
      generation: 4,
      profiles: [sshProfile],
      states: [
        {
          profileId: sshProfile.profileId,
          state: "needs-install",
          installPreview: { version: "3.16.2", sizeBytes: 4096 },
          availableVersion: "3.16.2",
          updatedAt: 1,
        },
      ],
    });
    const { management, connectProfile } = createManagement({
      connectProfile: vi.fn(async () => {
        throw error;
      }),
      getSnapshot: vi.fn(async () => installSnapshot),
    });
    const result = await prepareSourceConnection({
      management,
      target: sshTarget,
      snapshot: installSnapshot,
    });
    expect(result).toMatchObject({
      kind: "install-required",
      confirmation: {
        profileId: sshProfile.profileId,
        kind: "install",
        expectedTarget: { kind: "ssh", host: "host.example", port: 22, username: "dev" },
        preview: { version: "3.16.2", sizeBytes: 4096 },
      },
    });
    expect(connectProfile).toHaveBeenCalledTimes(1);
  });

  it("显式确认安装带同一 expectedTarget 重试，目标变更归类为 failed", async () => {
    const targetChanged = Object.assign(new Error("target changed"), {
      code: "remote-target-changed",
    });
    const { management, connectProfile } = createManagement({
      connectProfile: vi.fn(async () => {
        throw targetChanged;
      }),
    });
    const result = await prepareSourceConnection({
      management,
      target: sshTarget,
      snapshot: snapshot({ profiles: [sshProfile] }),
      confirmSourceServerInstall: true,
      expectedTarget: { kind: "ssh", host: "host.example", port: 22, username: "dev" },
    });
    expect(connectProfile).toHaveBeenCalledWith(sshProfile.profileId, {
      confirmSourceServerInstall: true,
      expectedTarget: { kind: "ssh", host: "host.example", port: 22, username: "dev" },
    });
    expect(result).toMatchObject({
      kind: "failed",
      classification: { kind: "target-changed", code: "remote-target-changed" },
    });
  });

  it("running-task busy 返回任务清单；force 先 updateSource 再连接", async () => {
    const busy = Object.assign(new Error("busy"), {
      code: SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE,
    });
    const busySnapshot = snapshot({
      generation: 5,
      profiles: [sshProfile],
      states: [
        {
          profileId: sshProfile.profileId,
          state: "needs-upgrade",
          upgradeTarget: "server",
          runningTasks: [
            { sessionId: "s-1", workspacePath: "/repo", workspaceIdentity: "remote:x:/repo" },
          ],
          updatedAt: 1,
        },
      ],
    });
    const connectProfile = vi.fn().mockRejectedValueOnce(busy).mockResolvedValue(busySnapshot);
    const { management, updateSource } = createManagement({
      connectProfile,
      getSnapshot: vi.fn(async () => busySnapshot),
    });
    const first = await prepareSourceConnection({
      management,
      target: sshTarget,
      snapshot: busySnapshot,
    });
    expect(first).toMatchObject({
      kind: "running-tasks",
      confirmation: {
        profileId: sshProfile.profileId,
        tasks: [{ sessionId: "s-1", workspacePath: "/repo" }],
        expectedTarget: { kind: "ssh", host: "host.example", port: 22, username: "dev" },
      },
    });

    const forced = await prepareSourceConnection({
      management,
      target: sshTarget,
      snapshot: busySnapshot,
      force: true,
      expectedTarget: { kind: "ssh", host: "host.example", port: 22, username: "dev" },
    });
    expect(updateSource).toHaveBeenCalledWith({
      profileId: sshProfile.profileId,
      force: true,
      expectedTarget: { kind: "ssh", host: "host.example", port: 22, username: "dev" },
    });
    expect(forced).toMatchObject({ kind: "ready" });
    expect(connectProfile).toHaveBeenCalledTimes(2);
  });

  it("controller 需要升级时不发起远端安装", async () => {
    const error = Object.assign(new Error("upgrade controller"), {
      code: SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE,
    });
    const controllerSnapshot = snapshot({
      generation: 6,
      profiles: [sshProfile],
      states: [
        {
          profileId: sshProfile.profileId,
          state: "needs-upgrade",
          upgradeTarget: "controller",
          availableVersion: "3.16.2",
          updatedAt: 1,
        },
      ],
    });
    const { management } = createManagement({
      connectProfile: vi.fn(async () => {
        throw error;
      }),
      getSnapshot: vi.fn(async () => controllerSnapshot),
    });
    const result = await prepareSourceConnection({
      management,
      target: sshTarget,
      snapshot: controllerSnapshot,
    });
    expect(result).toMatchObject({
      kind: "controller-upgrade-required",
      confirmation: { controllerUpgradeRequired: true },
    });
  });

  it("WSL 目标无法冻结时拒绝直接确认，避免用旧授权", async () => {
    const error = Object.assign(new Error("install"), {
      code: SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE,
    });
    const wslSnapshot = snapshot({
      profiles: [
        {
          profileId: "44444444-4444-4444-8444-444444444444",
          transport: "wsl",
          target: { kind: "wsl" },
          displayName: "WSL",
          createdAt: 1,
          lifecycleState: "active",
        } as ConnectionProfile,
      ],
      states: [
        {
          profileId: "44444444-4444-4444-8444-444444444444",
          state: "needs-install",
          installPreview: { version: "3.16.2", sizeBytes: 1 },
          updatedAt: 1,
        },
      ],
    });
    const { management } = createManagement({
      connectProfile: vi.fn(async () => {
        throw error;
      }),
      getSnapshot: vi.fn(async () => wslSnapshot),
    });
    const result = await prepareSourceConnection({
      management,
      target: { kind: "wsl" },
      snapshot: wslSnapshot,
      profileId: "44444444-4444-4444-8444-444444444444",
    });
    expect(result.kind).toBe("install-required");
    if (result.kind !== "install-required") return;
    // 目标无法规范化时不生成 expectedTarget，UI 必须等 WSL 解析后再确认。
    expect(result.confirmation.expectedTarget).toBeUndefined();
    expect(result.confirmation.controllerUpgradeRequired).toBe(false);
  });
});

describe("已保存 profile → 连接目标", () => {
  it("ssh 凭据只来自 credential port，profile 快照不含明文", async () => {
    const { createRemoteTargetFromProfile } = await import("@/lib/sourceServerWizardFlow.js");
    expect(
      createRemoteTargetFromProfile(
        {
          profileId: sshProfile.profileId,
          target: {
            kind: "ssh",
            host: "host.example",
            port: 2222,
            username: "dev",
            passwordCredentialKey: "pw-key",
          },
        },
        { password: "from-port" },
      ),
    ).toEqual({
      kind: "ssh",
      host: "host.example",
      port: 2222,
      username: "dev",
      password: "from-port",
    });
  });

  it("wsl/docker 直接映射，不附加 token/password", async () => {
    const { createRemoteTargetFromProfile } = await import("@/lib/sourceServerWizardFlow.js");
    expect(
      createRemoteTargetFromProfile(
        { profileId: "p", target: { kind: "wsl", distro: "Ubuntu", user: "dev" } },
        { password: "ignored" },
      ),
    ).toEqual({ kind: "wsl", distro: "Ubuntu", user: "dev" });
    expect(
      createRemoteTargetFromProfile(
        { profileId: "p", target: { kind: "docker", container: "box" } },
        {},
      ),
    ).toEqual({ kind: "docker", container: "box" });
  });
});
