/**
 * C1/C2 的真实 Host 路由合同回归：只使用 @zcode/shared 公开 identity 构造/解析，
 * 与生产 Host resolveProjectHostService 的 hostId 解析、以及配置面板的 logical scope
 * 判定保持一致；不引入第二种 hostId 格式或假 Host 别名。
 */
import { describe, expect, it } from "vitest";
import type { VirtualProject } from "@zcode/services";
import type { SourceServerManagementSnapshot } from "@zcode/shared";
import {
  buildRemoteHostWorkspaceIdentity,
  buildServerRemoteWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
} from "@zcode/shared";
import {
  configHostIdForSource,
  deriveConfigDirectoryTargets,
  isExactConfigLogicalSession,
} from "@/lib/configDirectoryCatalog.js";

const sourceA = "11111111-1111-4111-8111-111111111111";
const sourceB = "22222222-2222-4222-8222-222222222222";
const canonicalHostA = configHostIdForSource(sourceA);
const canonicalHostB = configHostIdForSource(sourceB);
const identity = (sourceServerId: string, workspacePath: string) =>
  buildServerRemoteWorkspaceIdentity({ serverId: sourceServerId, workspacePath });

/** 生产 Host resolveProjectHostService 的 hostId 解析（packages/desktop/src/host/index.ts）。 */
function resolveProjectRoute(hostId: string): string {
  const serverId = parseRemoteWorkspaceIdentity(
    buildRemoteHostWorkspaceIdentity(hostId, "/"),
  )?.sourceServerId;
  if (!serverId) throw new Error("project.host-offline");
  return serverId;
}

function project(hostId: string, roots: string[]): VirtualProject {
  return {
    id: hostId,
    hostId,
    name: hostId,
    nameOverridden: false,
    roots: roots.map((rootPath, position) => ({
      rootPath,
      position,
      isPrimary: position === 0,
    })),
    position: 0,
    pinned: false,
    deleted: false,
    createdAt: 1,
    updatedAt: 1,
    legacySingleRoot: false,
  };
}

function snapshot(ids: string[]): SourceServerManagementSnapshot {
  return {
    generation: 2,
    profiles: [],
    workspaceHistory: [],
    migrationCounts: [],
    failedPathCount: 0,
    abandonedPathCount: 0,
    servers: ids.map((sourceServerId) => ({
      sourceServerId,
      displayName: sourceServerId,
      installState: "installed",
      declaredWorkspaces: [],
    })),
    states: ids.map((sourceServerId) => ({
      profileId: sourceServerId,
      sourceServerId,
      state: "online",
      updatedAt: 5,
    })),
  };
}

describe("C1：配置目录必须走生产 Host 路由合同", () => {
  it("canonical remote:server:<id> 可解析，server:<id> 被 Host 合同拒绝", () => {
    expect(canonicalHostA).toBe(`remote:server:${sourceA}`);
    expect(resolveProjectRoute(canonicalHostA)).toBe(sourceA);
    expect(() => resolveProjectRoute(`server:${sourceA}`)).toThrow(/Invalid remote host identity/);
    expect(() => buildRemoteHostWorkspaceIdentity(`server:${sourceA}`, "/same")).toThrow(
      /Invalid remote host identity/,
    );
  });

  it("catalog 发布的 hostId 必须能被真实 Host 路由消费且目录可写", () => {
    const targets = deriveConfigDirectoryTargets({
      projects: [project(canonicalHostA, ["/read-root"])],
      snapshot: snapshot([sourceA]),
      readyHosts: ["local", canonicalHostA],
      tabs: [],
    });
    for (const target of targets.filter((item) => item.hostId !== "local")) {
      expect(() => resolveProjectRoute(target.hostId)).not.toThrow();
    }
    const root = targets.find((target) => target.workspacePath === "/read-root");
    expect(root).toMatchObject({ hostId: canonicalHostA, configOnline: true });
    expect(root?.workspaceIdentity).toBe(identity(sourceA, "/read-root"));
    // 旧 UI 用 server:<id> 当 hostId 时，真实 Host 拒绝后该 Source 目录全部不可写。
    expect(() => resolveProjectRoute(`server:${sourceA}`)).toThrow();
  });
});

describe("C2：remoteSessionId 不得跨目录借用", () => {
  it("A/B 不同目录各自保留自己的 logical session", () => {
    const targets = deriveConfigDirectoryTargets({
      projects: [project(canonicalHostA, ["/dir-a"]), project(canonicalHostB, ["/dir-b"])],
      snapshot: snapshot([sourceA, sourceB]),
      readyHosts: ["local", canonicalHostA, canonicalHostB],
      tabs: [
        {
          workspacePath: "/dir-a",
          workspaceIdentity: identity(sourceA, "/dir-a"),
          label: "open A",
          remoteSessionId: "session-a",
        },
        {
          workspacePath: "/dir-b",
          workspaceIdentity: identity(sourceB, "/dir-b"),
          label: "open B",
          remoteSessionId: "session-b",
        },
      ],
    });
    expect(targets.find((target) => target.workspacePath === "/dir-a")?.remoteSessionId).toBe(
      "session-a",
    );
    expect(targets.find((target) => target.workspacePath === "/dir-b")?.remoteSessionId).toBe(
      "session-b",
    );
    expect(
      isExactConfigLogicalSession(
        targets.find((target) => target.workspacePath === "/dir-a"),
        "session-b",
      ),
    ).toBe(false);
    expect(
      isExactConfigLogicalSession(
        targets.find((target) => target.workspacePath === "/dir-a"),
        "session-a",
      ),
    ).toBe(true);
  });

  it("同 Source 同 path 的两个 legacy logical context 不合并、不互相借用", () => {
    const legacyOne = "remote:ssh:host-a:22:user-a:/shared";
    const legacyTwo = "remote:ssh:host-a:22:user-b:/shared";
    const targets = deriveConfigDirectoryTargets({
      projects: [],
      snapshot: snapshot([sourceA]),
      readyHosts: ["local", canonicalHostA],
      tabs: [
        {
          workspacePath: "/shared",
          workspaceIdentity: legacyOne,
          label: "legacy 1",
          remoteSessionId: "session-1",
        },
        {
          workspacePath: "/shared",
          workspaceIdentity: legacyTwo,
          label: "legacy 2",
          remoteSessionId: "session-2",
        },
      ],
    });
    const one = targets.find((target) => target.key === legacyOne);
    const two = targets.find((target) => target.key === legacyTwo);
    expect(one?.workspaceIdentity).toBe(legacyOne);
    expect(two?.workspaceIdentity).toBe(legacyTwo);
    expect(one?.remoteSessionId).toBe("session-1");
    expect(two?.remoteSessionId).toBe("session-2");
    expect(isExactConfigLogicalSession(one, "session-2")).toBe(false);
    expect(isExactConfigLogicalSession(two, "session-1")).toBe(false);
    // legacy SSH identity 不会被 canonical 成 Source identity。
    expect(one?.sourceServerId).toBeUndefined();
    expect(one?.workspaceIdentity).not.toBe(identity(sourceA, "/shared"));
    expect(remoteHostIdFromWorkspaceIdentity(legacyOne)).toBe("remote:ssh:host-a:22:user-a");
  });

  it("pending A 晚到不覆盖 B 的目录映射", () => {
    const base = {
      projects: [project(canonicalHostA, ["/late"]), project(canonicalHostB, ["/late"])],
      snapshot: snapshot([sourceA, sourceB]),
      readyHosts: ["local", canonicalHostA, canonicalHostB],
    };
    const before = deriveConfigDirectoryTargets({ ...base, tabs: [] });
    expect(before.every((target) => target.remoteSessionId === undefined)).toBe(true);
    const after = deriveConfigDirectoryTargets({
      ...base,
      tabs: [
        {
          workspacePath: "/late",
          workspaceIdentity: identity(sourceA, "/late"),
          label: "late A",
          remoteSessionId: "session-a",
        },
      ],
    });
    expect(after.find((target) => target.sourceServerId === sourceA)?.remoteSessionId).toBe(
      "session-a",
    );
    expect(after.find((target) => target.sourceServerId === sourceB)?.remoteSessionId).toBe(
      undefined,
    );
  });
});
