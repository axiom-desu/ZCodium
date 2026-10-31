import { describe, expect, it } from "vitest";
import type { RemoteWorkspaceSessionEntry } from "@zcode/shared";
import {
  buildRemoteWorkspaceSessionMutation,
  createRemoteTargetFromSnapshot,
  loadRemoteTargetCredentials,
} from "@/lib/remoteWorkspaceHistory.js";

const serverId = "11111111-1111-4111-8111-111111111111";
const serverIdentity = `remote:server:${serverId}:/srv/app`;
const serverEntry: RemoteWorkspaceSessionEntry = {
  kind: "remote",
  workspacePath: "/srv/app",
  workspaceIdentity: serverIdentity,
  target: {
    kind: "server",
    url: "https://studio.example",
    name: "Studio",
    serverId,
    tokenCredentialKey: "remote-workspace:server-token",
  },
  lastOpenedAt: 1,
  lastConnectionStatus: "connected",
};

describe("server 直连凭据只进 credential port", () => {
  it("连接成功后 token 落成 credential key，历史快照不含 token", () => {
    const mutation = buildRemoteWorkspaceSessionMutation({
      remoteSessions: [],
      workspacePath: "/srv/app",
      workspaceIdentity: serverIdentity,
      target: {
        kind: "server",
        url: "https://studio.example",
        name: "Studio",
        serverId,
        token: "secret-token",
      },
      lastConnectionStatus: "connected",
      touchOpenedAt: true,
    });

    expect(mutation.entry.target).toEqual({
      kind: "server",
      url: "https://studio.example",
      name: "Studio",
      serverId,
      tokenCredentialKey: expect.stringContaining("server-token"),
    });
    expect(JSON.stringify(mutation.entry)).not.toContain("secret-token");
    expect(JSON.stringify(mutation.entry.target)).not.toContain('token":');
    expect(mutation.credentialsToSave).toEqual([
      { key: mutation.entry.target.tokenCredentialKey, value: "secret-token" },
    ]);
  });

  it("失败落盘不把 token 写回快照，凭据缺失时保留已保存 key", () => {
    const mutation = buildRemoteWorkspaceSessionMutation({
      remoteSessions: [serverEntry],
      workspacePath: "/srv/app",
      workspaceIdentity: serverIdentity,
      target: { kind: "server", url: "https://studio.example", name: "Studio", serverId },
      lastConnectionStatus: "failed",
      lastConnectionError: "unreachable",
      touchOpenedAt: false,
    });
    expect(mutation.entry.target.kind).toBe("server");
    if (mutation.entry.target.kind !== "server") return;
    // 没有新 token 时沿用已保存凭据 key，重连仍能经 credential port 读回。
    expect(mutation.entry.target.tokenCredentialKey).toBe(serverEntry.target.tokenCredentialKey);
    expect(mutation.credentialsToSave).toEqual([]);
  });

  it("从 credential port 读回 token 后才构造带凭据的直连目标", async () => {
    const loadedKeys: string[] = [];
    const credentials = await loadRemoteTargetCredentials(serverEntry.target, async (key) => {
      loadedKeys.push(key);
      return "restored-token";
    });
    expect(loadedKeys).toEqual([serverEntry.target.tokenCredentialKey]);
    expect(credentials).toEqual({
      password: null,
      privateKeyPassphrase: null,
      token: "restored-token",
    });
    expect(createRemoteTargetFromSnapshot(serverEntry.target, credentials)).toEqual({
      kind: "server",
      url: "https://studio.example",
      name: "Studio",
      serverId,
      token: "restored-token",
    });
  });

  it("凭据缺失或被移除时不伪造匿名 token", async () => {
    const credentials = await loadRemoteTargetCredentials(serverEntry.target, async () => null);
    expect(credentials).toEqual({
      password: null,
      privateKeyPassphrase: null,
      token: null,
    });
    expect(createRemoteTargetFromSnapshot(serverEntry.target, credentials)).toEqual({
      kind: "server",
      url: "https://studio.example",
      name: "Studio",
      serverId,
    });
  });

  it("ssh 凭据读取保持原有关键字顺序与非 server 目标不读 token", async () => {
    const loadedKeys: string[] = [];
    const credentials = await loadRemoteTargetCredentials(
      {
        kind: "ssh",
        host: "host.example",
        port: 22,
        username: "dev",
        passwordCredentialKey: "pw-key",
        privateKeyPassphraseCredentialKey: "pass-key",
      },
      async (key) => {
        loadedKeys.push(key);
        return key === "pw-key" ? "pw" : "pass";
      },
    );
    expect(loadedKeys).toEqual(["pw-key", "pass-key"]);
    expect(credentials).toEqual({
      password: "pw",
      privateKeyPassphrase: "pass",
      token: null,
    });
  });
});
