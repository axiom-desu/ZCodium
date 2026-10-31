import { describe, expect, it } from "vitest";
import {
  SOURCE_SERVER_IDENTITY_CHANGE_PENDING_ERROR_CODE,
  SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE,
  SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE,
  SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE,
  type ConnectionProfile,
  type SourceServerConnectionStateSnapshot,
  type SourceServerManagementSnapshot,
} from "@zcode/shared";
import {
  beginRemoteEntryEpoch,
  buildSourceProfileRows,
  classifySourceServerFailure,
  findProfileForRemoteTarget,
  isRemoteEntryEpochCurrent,
  resolveRunningTasksConfirmation,
  resolveSourceInstallConfirmation,
  shouldAutoAdvanceRemoteCompletion,
  shouldApplySourceManagementSnapshot,
} from "@/lib/sourceServerManagement.js";
import { resolveSourceServerErrorPresentation } from "@/lib/sourceServerErrorPresentation.js";

function profile(profileId: string, overrides: Partial<ConnectionProfile> = {}): ConnectionProfile {
  const base = {
    profileId,
    createdAt: 1,
    lifecycleState: "active" as const,
    displayName: profileId,
  };
  return {
    ...base,
    transport: "ssh",
    target: { kind: "ssh", host: "host.example", username: "dev", port: 22 },
    ...overrides,
  } as ConnectionProfile;
}

function state(
  profileId: string,
  overrides: Partial<SourceServerConnectionStateSnapshot> = {},
): SourceServerConnectionStateSnapshot {
  return {
    profileId,
    state: "offline",
    updatedAt: 1,
    ...overrides,
  };
}

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

describe("Source 管理 UI 快照与 epoch", () => {
  it("entry epoch 推进后旧 await 结果不再属于当前入口", () => {
    const epochRef = { current: 0 };
    const first = beginRemoteEntryEpoch(epochRef);
    expect(isRemoteEntryEpochCurrent(epochRef, first)).toBe(true);
    const second = beginRemoteEntryEpoch(epochRef);
    expect(isRemoteEntryEpochCurrent(epochRef, first)).toBe(false);
    expect(isRemoteEntryEpochCurrent(epochRef, second)).toBe(true);
  });

  it("generation 更旧的快照不能覆盖新快照", () => {
    expect(shouldApplySourceManagementSnapshot(-1, 1)).toBe(true);
    expect(shouldApplySourceManagementSnapshot(2, 2)).toBe(true);
    expect(shouldApplySourceManagementSnapshot(3, 2)).toBe(false);
  });

  it("收起后的后台成功必须等显式继续，前台成功直接推进", () => {
    expect(shouldAutoAdvanceRemoteCompletion({ minimized: false, stillSameEntry: true })).toBe(
      true,
    );
    expect(shouldAutoAdvanceRemoteCompletion({ minimized: true, stillSameEntry: true })).toBe(
      false,
    );
    // 迟到/跨 profile 结果即使前台也不推进。
    expect(shouldAutoAdvanceRemoteCompletion({ minimized: false, stillSameEntry: false })).toBe(
      false,
    );
  });
});

describe("Source 失败分类", () => {
  it("typed 安装/升级/忙碌/身份变化/目标变更各自分类", () => {
    expect(
      classifySourceServerFailure(
        Object.assign(new Error("install"), { code: SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE }),
      ),
    ).toEqual({
      kind: "install-required",
      code: SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE,
      retryable: true,
    });
    expect(
      classifySourceServerFailure(
        Object.assign(new Error("upgrade"), { code: SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE }),
      ),
    ).toEqual({
      kind: "upgrade-required",
      code: SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE,
      retryable: true,
    });
    expect(
      classifySourceServerFailure(
        Object.assign(new Error("busy"), { code: SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE }),
      ),
    ).toEqual({
      kind: "running-tasks",
      code: SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE,
      retryable: true,
    });
    expect(
      classifySourceServerFailure(
        Object.assign(new Error("identity"), {
          code: SOURCE_SERVER_IDENTITY_CHANGE_PENDING_ERROR_CODE,
        }),
      ),
    ).toEqual({
      kind: "identity-change-pending",
      code: SOURCE_SERVER_IDENTITY_CHANGE_PENDING_ERROR_CODE,
      retryable: true,
    });
    expect(
      classifySourceServerFailure(
        Object.assign(new Error("target changed"), { code: "remote-target-changed" }),
      ),
    ).toEqual({ kind: "target-changed", code: "remote-target-changed", retryable: true });
    expect(
      classifySourceServerFailure(
        Object.assign(new Error("credentials"), { code: "credentials-required" }),
      ),
    ).toEqual({ kind: "credentials-required", code: "credentials-required", retryable: true });
  });

  it("未知错误保留 retryable 明文并归类为 other", () => {
    expect(classifySourceServerFailure(new Error("boom"))).toEqual({
      kind: "other",
      code: undefined,
      retryable: false,
    });
    expect(
      classifySourceServerFailure(
        Object.assign(new Error("boom"), { code: "remote-host-unreachable", retryable: true }),
      ),
    ).toEqual({ kind: "other", code: "remote-host-unreachable", retryable: true });
  });

  it("安装/升级/忙碌错误映射到既有错误分类文案，不引入超时兜底", () => {
    expect(resolveSourceServerErrorPresentation(SOURCE_SERVER_INSTALL_REQUIRED_ERROR_CODE)).toEqual(
      {
        titleId: "source.error.installRequired.title",
        reasonId: "source.error.installRequired.reason",
        retryable: true,
      },
    );
    expect(resolveSourceServerErrorPresentation(SOURCE_SERVER_UPGRADE_REQUIRED_ERROR_CODE)).toEqual(
      {
        titleId: "source.error.upgradeRequired.title",
        reasonId: "source.error.upgradeRequired.reason",
        retryable: true,
      },
    );
    expect(resolveSourceServerErrorPresentation("remote-target-changed")).toEqual({
      titleId: "source.error.targetChanged.title",
      reasonId: "source.error.targetChanged.reason",
      retryable: true,
    });
    expect(resolveSourceServerErrorPresentation(undefined)).toEqual({
      titleId: "source.error.generic.title",
      reasonId: "source.error.generic.reason",
      retryable: false,
    });
  });
});

describe("Source profile 列表投影", () => {
  it("只列 active profile，合并服务器显示名与连接状态，online 排前", () => {
    const rows = buildSourceProfileRows(
      snapshot({
        profiles: [
          profile("p-offline", { displayName: "Zeta" }),
          profile("p-online", {
            displayName: "Alpha",
            sourceServerId: "11111111-1111-4111-8111-111111111111",
          }),
          profile("p-retired", { displayName: "Old", lifecycleState: "retired" }),
        ],
        servers: [
          {
            sourceServerId: "11111111-1111-4111-8111-111111111111",
            displayName: "Studio",
            installState: "installed",
            declaredWorkspaces: [],
          },
        ],
        states: [
          state("p-online", {
            state: "online",
            sourceServerId: "11111111-1111-4111-8111-111111111111",
            currentVersion: "3.16.2",
          }),
          state("p-offline", { state: "failed", error: "unreachable" }),
        ],
      }),
    );

    expect(rows.map((row) => row.profileId)).toEqual(["p-online", "p-offline"]);
    expect(rows[0]).toMatchObject({
      displayName: "Alpha",
      sourceDisplayName: "Studio",
      state: "online",
      currentVersion: "3.16.2",
      targetLabel: "dev@host.example:22",
    });
    expect(rows[1]).toMatchObject({ displayName: "Zeta", state: "failed", error: "unreachable" });
  });

  it("needs-install/needs-upgrade 暴露 preview 与 upgradeTarget，供确认面板展示", () => {
    const [installRow, upgradeRow] = buildSourceProfileRows(
      snapshot({
        profiles: [profile("p-install"), profile("p-upgrade")],
        states: [
          state("p-install", {
            state: "needs-install",
            availableVersion: "3.16.2",
            installPreview: { version: "3.16.2", installPath: "/home/dev/.zcode", sizeBytes: 2048 },
          }),
          state("p-upgrade", {
            state: "needs-upgrade",
            currentVersion: "3.15.1",
            availableVersion: "3.16.2",
            upgradeTarget: "controller",
          }),
        ],
      }),
    );

    expect(installRow?.installPreview).toEqual({
      version: "3.16.2",
      installPath: "/home/dev/.zcode",
      sizeBytes: 2048,
    });
    expect(upgradeRow?.upgradeTarget).toBe("controller");
    expect(resolveSourceInstallConfirmation(snapshot(), "p-install")).toBeNull();
  });
});

describe("Source 安装/忙碌确认", () => {
  const base = snapshot({
    profiles: [profile("p-install"), profile("p-busy")],
    states: [
      state("p-install", {
        state: "needs-install",
        availableVersion: "3.16.2",
        installPreview: { version: "3.16.2", sizeBytes: 1024 },
      }),
      state("p-busy", {
        state: "needs-upgrade",
        currentVersion: "3.15.1",
        availableVersion: "3.16.2",
        upgradeTarget: "server",
        runningTasks: [
          { sessionId: "s-1", workspacePath: "/repo", workspaceIdentity: "remote:x:/repo" },
        ],
      }),
    ],
  });

  it("install preview 绑定 profile 与固定 target", () => {
    expect(
      resolveSourceInstallConfirmation(base, "p-install", {
        kind: "ssh",
        host: "host.example",
        port: 22,
        username: "dev",
      }),
    ).toEqual({
      profileId: "p-install",
      kind: "install",
      expectedTarget: { kind: "ssh", host: "host.example", port: 22, username: "dev" },
      preview: { version: "3.16.2", sizeBytes: 1024 },
      availableVersion: "3.16.2",
      controllerUpgradeRequired: false,
    });
  });

  it("controller 需要升级时不允许在远端执行 server 安装", () => {
    const controllerSnapshot = snapshot({
      profiles: [profile("p-controller")],
      states: [
        state("p-controller", {
          state: "needs-upgrade",
          upgradeTarget: "controller",
          availableVersion: "3.16.2",
        }),
      ],
    });
    const confirmation = resolveSourceInstallConfirmation(controllerSnapshot, "p-controller");
    expect(confirmation?.controllerUpgradeRequired).toBe(true);
  });

  it("running tasks 只用于 force 确认，不改变 target 快照", () => {
    expect(resolveRunningTasksConfirmation(base, "p-busy")).toEqual({
      profileId: "p-busy",
      tasks: [{ sessionId: "s-1", workspacePath: "/repo", workspaceIdentity: "remote:x:/repo" }],
    });
    expect(resolveRunningTasksConfirmation(base, "p-install")).toBeNull();
    expect(resolveRunningTasksConfirmation(base, "missing")).toBeNull();
  });
});

describe("Source profile 与原始 target 匹配", () => {
  it("同 host/port/username 的 ssh profile 可复用，端口缺省按 22", () => {
    const profiles = [profile("p-ssh")];
    expect(
      findProfileForRemoteTarget(snapshot({ profiles }), {
        kind: "ssh",
        host: "host.example",
        username: "dev",
      })?.profileId,
    ).toBe("p-ssh");
    expect(
      findProfileForRemoteTarget(snapshot({ profiles }), {
        kind: "ssh",
        host: "other.example",
        username: "dev",
      }),
    ).toBeUndefined();
  });

  it("wsl 缺少 distro/user 时不被误判成已保存 profile", () => {
    const profiles = [
      profile("p-wsl", {
        transport: "wsl",
        target: { kind: "wsl", distro: "Ubuntu", user: "dev" } as ConnectionProfile["target"],
      }),
    ];
    expect(
      findProfileForRemoteTarget(snapshot({ profiles }), { kind: "wsl", distro: "Ubuntu" }),
    ).toBeUndefined();
    expect(
      findProfileForRemoteTarget(snapshot({ profiles }), {
        kind: "wsl",
        distro: "Ubuntu",
        user: "dev",
      })?.profileId,
    ).toBe("p-wsl");
  });

  it("server 直连不使用 Connection Profile", () => {
    expect(
      findProfileForRemoteTarget(snapshot({ profiles: [profile("p-ssh")] }), {
        kind: "server",
        url: "https://studio.example",
      }),
    ).toBeUndefined();
  });
});
