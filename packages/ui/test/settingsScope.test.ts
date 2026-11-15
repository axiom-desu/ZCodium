import { describe, expect, it } from "vitest";
import type {
  ConfigWorkspaceTarget,
  SettingsScopeContext,
} from "../src/settings-scope/contract.js";
import {
  buildSettingsScopeGroups,
  remoteUserScopeKey,
  resolveDefaultSettingsScopeKey,
  resolveSettingsScope,
  resolveSettingsScopeFormDeviceKey,
} from "../src/settings-scope/domain/scope.js";
import {
  resolveSettingsScopeBlock,
  resolveSettingsScopeTargetBlock,
} from "../src/settings-scope/ui/SettingsScopeBlockedNotice.js";

const remoteTarget: ConfigWorkspaceTarget = {
  workspacePath: "/srv/project",
  workspaceIdentity: "ssh:source-a:/srv/project",
  sourceServerId: "source-a",
  remoteSessionId: "session-a",
  remoteTarget: { kind: "ssh", host: "example.invalid", username: "user" },
  label: "Project",
};

function context(remoteUserAvailable: boolean, online: boolean): SettingsScopeContext {
  return {
    targets: [remoteTarget],
    remoteUserAvailable,
    devices: [{ sourceServerId: "source-a", name: "Source A", online }],
  };
}

describe("settings scope host/source boundaries", () => {
  it("routes remote user scope only through an online source-settings capable device", () => {
    const current = context(true, true);
    expect(buildSettingsScopeGroups(current)[1]?.options.map((option) => option.key)).toEqual([
      remoteUserScopeKey("source-a"),
      remoteTarget.workspaceIdentity,
    ]);
    expect(resolveSettingsScope(remoteUserScopeKey("source-a"), current)).toMatchObject({
      status: "ready",
      kind: "user",
      device: { kind: "remote", sourceServerId: "source-a" },
    });
    expect(
      resolveSettingsScope(remoteUserScopeKey("source-a"), context(false, true)),
    ).toMatchObject({
      status: "missing",
      fallbackKey: "user",
    });
  });

  it("fails closed offline and keeps remote workspaces as workspace-host targets", () => {
    const offline = context(true, false);
    expect(buildSettingsScopeGroups(offline)).toHaveLength(1);
    expect(resolveSettingsScope(remoteUserScopeKey("source-a"), offline)).toMatchObject({
      status: "offline",
    });
    expect(
      resolveSettingsScope(remoteTarget.workspaceIdentity!, context(true, true)),
    ).toMatchObject({
      status: "ready",
      kind: "workspace",
      target: remoteTarget,
    });
    expect(
      resolveDefaultSettingsScopeKey({
        workspacePath: remoteTarget.workspacePath,
        workspaceIdentity: remoteTarget.workspaceIdentity,
        sourceServerId: remoteTarget.sourceServerId,
        remoteUserAvailable: false,
      }),
    ).toBe(remoteTarget.workspaceIdentity);
  });
});

const localUserState = {
  resolution: { status: "ready", key: "user", kind: "user", device: { kind: "local" } },
} as const;
const remoteUserReady = {
  resolution: {
    status: "ready",
    key: remoteUserScopeKey("source-a"),
    kind: "user",
    device: { kind: "remote", id: "source-a", sourceServerId: "source-a", name: "Source A" },
  },
  user: { status: "ready", target: { workspacePath: "/home/user", label: "/home/user" } },
} as const;

describe("settings scope fail-closed consumption", () => {
  it("blocks the section instead of borrowing services when the device is disconnected", () => {
    const offline = context(true, false);
    expect(
      resolveSettingsScopeBlock(
        {
          resolution: resolveSettingsScope(remoteUserScopeKey("source-a"), offline),
          user: { status: "offline" },
        },
        true,
      ),
    ).toBe("offline");
    // 项目目标在 catalog 里已断开：同样按离线阻断，不退回当前 Host。
    expect(resolveSettingsScopeTargetBlock({ configOnline: false })).toBe("offline");
    expect(resolveSettingsScopeTargetBlock({ configOnline: true })).toBeNull();
  });

  it("waits for the device attachment and never substitutes the local user", () => {
    expect(
      resolveSettingsScopeBlock({ ...remoteUserReady, user: { status: "connecting" } }, true),
    ).toBe("connecting");
    expect(resolveSettingsScopeBlock(remoteUserReady, true)).toBeNull();
    // 未解析完成（missing）时不能把本机用户配置当目标。
    expect(
      resolveSettingsScopeBlock(
        {
          resolution: { status: "missing", key: "x", fallbackKey: "user" },
          user: { status: "ready" },
        },
        false,
      ),
    ).toBe("connecting");
    expect(resolveSettingsScopeBlock(localUserState as never, false)).toBeNull();
  });

  it("keeps form ownership on the fallback device across a closed project", () => {
    expect(
      resolveSettingsScopeFormDeviceKey(
        {
          status: "missing",
          key: "remote:server:source-a:/srv/project",
          fallbackKey: remoteUserScopeKey("source-a"),
        },
        { kind: "local" },
      ),
    ).toBe("source-a");
    expect(
      resolveSettingsScopeFormDeviceKey(
        { status: "missing", key: "/gone", fallbackKey: "user" },
        { kind: "local" },
      ),
    ).toBe("local");
    expect(
      resolveSettingsScopeFormDeviceKey(
        {
          status: "ready",
          key: remoteUserScopeKey("source-a"),
          kind: "user",
          device: remoteUserReady.resolution.device,
        },
        remoteUserReady.resolution.device,
      ),
    ).toBe("source-a");
  });
});
