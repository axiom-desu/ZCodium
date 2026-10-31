import { describe, expect, it } from "vitest";
import {
  buildRemoteWorkspaceIdentity,
  buildRemoteWorkspaceSessionMutation,
  withAuthenticatedServerTarget,
  resolveConnectedRemoteWorkspaceIdentity,
} from "@/lib/remoteWorkspaceHistory.js";
import type { RemoteWorkspaceSessionEntry } from "@zcode/shared";

const baseServerTarget = {
  kind: "server" as const,
  url: "https://studio.example",
  name: "Studio",
  token: "secret-token",
};

function tokenKeyFor(identity: string): string {
  return `remote-workspace:${identity}:server-token`;
}

describe("Source 直连身份只用已鉴权握手 id", () => {
  it("reconnect/history use the exact Host logical key even on Source-backed legacy transports", () => {
    const target = { kind: "ssh" as const, host: "fixture.invalid", username: "alice" };
    const legacy = buildRemoteWorkspaceIdentity("/work", target);
    const connected = {
      sessionId: "session-1",
      target,
      sourceServerId: "source-real",
      workspaceIdentity: legacy,
    };
    expect(
      resolveConnectedRemoteWorkspaceIdentity({
        connected,
        connectedWorkspacePath: "/work",
        workspacePath: "/work",
      }),
    ).toBe(legacy);
    expect(
      resolveConnectedRemoteWorkspaceIdentity({
        connected,
        connectedWorkspacePath: "/work",
        workspacePath: "/real-work",
      }),
    ).toBe(buildRemoteWorkspaceIdentity("/real-work", target));
    expect(
      resolveConnectedRemoteWorkspaceIdentity({
        connected: { ...connected, workspaceIdentity: "remote:server:source-real:/work" },
        connectedWorkspacePath: "/work",
        workspacePath: "/real-work",
      }),
    ).toBe("remote:server:source-real:/real-work");
    expect(
      resolveConnectedRemoteWorkspaceIdentity({
        connected: { ...connected, workspaceIdentity: undefined },
        workspacePath: "/new",
      }),
    ).toBe("remote:server:source-real:/new");
  });
  it("两个同名不同 serverId 的 Source 在同一路径下得到不同身份与 token slot", () => {
    const identityA = buildRemoteWorkspaceIdentity("/srv/app", {
      ...baseServerTarget,
      serverId: "source-a",
    });
    const identityB = buildRemoteWorkspaceIdentity("/srv/app", {
      ...baseServerTarget,
      serverId: "source-b",
    });

    expect(identityA).toBe("remote:server:source-a:/srv/app");
    expect(identityB).toBe("remote:server:source-b:/srv/app");
    expect(identityA).not.toBe(identityB);

    const mutationA = buildRemoteWorkspaceSessionMutation({
      remoteSessions: [],
      workspacePath: "/srv/app",
      workspaceIdentity: identityA,
      target: { ...baseServerTarget, serverId: "source-a" },
      lastConnectionStatus: "connected",
      touchOpenedAt: true,
    });
    const mutationB = buildRemoteWorkspaceSessionMutation({
      remoteSessions: mutationA.nextRemoteSessions,
      workspacePath: "/srv/app",
      workspaceIdentity: identityB,
      target: { ...baseServerTarget, serverId: "source-b" },
      lastConnectionStatus: "connected",
      touchOpenedAt: true,
    });

    expect(mutationA.entry.workspaceIdentity).toBe(identityA);
    expect(mutationB.entry.workspaceIdentity).toBe(identityB);
    expect(mutationB.nextRemoteSessions).toHaveLength(2);
    expect(mutationA.entry.target).toMatchObject({
      tokenCredentialKey: tokenKeyFor(identityA),
    });
    const savedKeyB =
      mutationB.entry.target.kind === "server"
        ? mutationB.entry.target.tokenCredentialKey
        : undefined;
    expect(savedKeyB).toBe(tokenKeyFor(identityB));
    expect(savedKeyB).not.toBe(
      mutationA.entry.target.kind === "server"
        ? mutationA.entry.target.tokenCredentialKey
        : undefined,
    );
  });

  it("重命名只改展示名，不改变身份与凭据 key", () => {
    const before = buildRemoteWorkspaceIdentity("/srv/app", {
      ...baseServerTarget,
      serverId: "source-a",
    });
    const after = buildRemoteWorkspaceIdentity("/srv/app", {
      ...baseServerTarget,
      name: "Renamed Studio",
      serverId: "source-a",
    });
    expect(after).toBe(before);
    expect(tokenKeyFor(after)).toBe(tokenKeyFor(before));
  });

  it("没有握手 serverId 时拒绝用 name/URL 构造身份", () => {
    expect(() => buildRemoteWorkspaceIdentity("/srv/app", baseServerTarget)).toThrow(
      /authenticated handshake sourceServerId/u,
    );
  });

  it("Host descriptor 的 serverId 覆盖表单里错误声明的 id", () => {
    const target = withAuthenticatedServerTarget(
      { ...baseServerTarget, serverId: "advertised-wrong" },
      "source-real",
    );
    expect(target).toMatchObject({ kind: "server", serverId: "source-real" });
    expect(buildRemoteWorkspaceIdentity("/srv/app", target)).toBe(
      "remote:server:source-real:/srv/app",
    );
  });

  it("旧 provisional name key 原样保留，不借重连自动迁移到新 authority", () => {
    const legacyIdentity = "remote:server:studio-example:/srv/app";
    const legacyEntry: RemoteWorkspaceSessionEntry = {
      kind: "remote",
      workspacePath: "/srv/app",
      workspaceIdentity: legacyIdentity,
      target: {
        kind: "server",
        url: "https://studio.example",
        name: "Studio",
        tokenCredentialKey: tokenKeyFor(legacyIdentity),
      },
      lastOpenedAt: 1,
      lastConnectionStatus: "disconnected",
    };

    // 没有 serverId 时仍可按既有 history identity 读写同一 token slot。
    const mutation = buildRemoteWorkspaceSessionMutation({
      remoteSessions: [legacyEntry],
      workspacePath: "/srv/app",
      workspaceIdentity: legacyIdentity,
      target: { ...baseServerTarget, serverId: "source-real" },
      lastConnectionStatus: "connected",
      touchOpenedAt: true,
    });

    expect(mutation.entry.workspaceIdentity).toBe(legacyIdentity);
    expect(mutation.entry.target).toMatchObject({
      tokenCredentialKey: tokenKeyFor(legacyIdentity),
    });
    expect(mutation.nextRemoteSessions).toHaveLength(1);
  });
});
