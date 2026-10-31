import { describe, expect, it } from "vitest";
import { buildRemoteEnvironmentKey } from "./remoteEnvironmentKey.js";
import {
  buildRemoteHostWorkspaceIdentity,
  buildRemoteWorkspaceIdentity,
  buildServerRemoteWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
} from "./remote-workspace-identity.js";
import { stripRemoteTargetSecrets, type ServerConnectOptions } from "./remoteTarget.js";

const serverTarget: ServerConnectOptions = {
  kind: "server",
  url: "http://127.0.0.1:4319",
  name: "Lab",
  token: "secret-ingress-token",
  serverId: "source-1",
};

describe("Source Server workspace identity", () => {
  it("builds and parses the canonical remote:server identity", () => {
    const identity = buildServerRemoteWorkspaceIdentity({
      serverId: "Source-1",
      workspacePath: "/home/dev/repo",
    });
    expect(identity).toBe("remote:server:source-1:/home/dev/repo");
    expect(parseRemoteWorkspaceIdentity(identity)).toEqual({
      kind: "server",
      sourceServerId: "source-1",
      workspacePath: "/home/dev/repo",
    });
    expect(remoteHostIdFromWorkspaceIdentity(identity)).toBe("remote:server:source-1");
  });

  it("normalizes path separators and rejects identity-empty server ids", () => {
    expect(buildServerRemoteWorkspaceIdentity({ serverId: "s1", workspacePath: "a\\b//c/" })).toBe(
      "remote:server:s1:/a/b/c",
    );
    expect(() =>
      buildServerRemoteWorkspaceIdentity({ serverId: "  ", workspacePath: "/" }),
    ).toThrow(/identity-safe/);
  });

  it("never leaks the token into identity or environment keys", () => {
    const identity = buildRemoteWorkspaceIdentity("/work", serverTarget);
    expect(identity).toBe("remote:server:source-1:/work");
    expect(identity).not.toContain(serverTarget.token!);

    const environmentKey = buildRemoteEnvironmentKey(serverTarget);
    expect(environmentKey).toBe("server:source-1");
    expect(environmentKey).not.toContain(serverTarget.token!);
  });

  it("derives a stable environment key from the endpoint before the handshake", () => {
    const withoutServerId: ServerConnectOptions = {
      kind: "server",
      url: "ws://example.test:8080/base/?token=leak#frag",
    };
    expect(buildRemoteEnvironmentKey(withoutServerId)).toBe(
      buildRemoteEnvironmentKey({
        kind: "server",
        url: "http://example.test:8080/base",
      }),
    );
    expect(buildRemoteEnvironmentKey(withoutServerId)).not.toContain("token");
  });

  it("refuses name/URL fallback when the authenticated handshake id is missing", () => {
    expect(() =>
      buildRemoteWorkspaceIdentity("/work", {
        kind: "server",
        url: "http://127.0.0.1:4319",
        name: "Lab",
      }),
    ).toThrow(/authenticated handshake sourceServerId/u);
    // 旧 route identity 只能从已存在历史/绑定原样保留，不能靠 name/URL 新造。
    expect(buildRemoteHostWorkspaceIdentity("remote:server:source-1", "/")).toBe(
      "remote:server:source-1:/",
    );
  });

  it("strips the Source token from any publishable target", () => {
    const stripped = stripRemoteTargetSecrets(serverTarget);
    expect(stripped).not.toHaveProperty("token");
    expect(stripped).toMatchObject({ kind: "server", serverId: "source-1", name: "Lab" });
  });
});
