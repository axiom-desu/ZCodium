import { describe, expect, it } from "vitest";
import type { VirtualProject } from "@zcode/services";
import type { SourceServerManagementSnapshot } from "@zcode/shared";
import {
  buildServerRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
} from "@zcode/shared";
import {
  configHostIdForSource,
  deriveConfigDirectoryTargets,
} from "@/lib/configDirectoryCatalog.js";

const sourceA = "11111111-1111-4111-8111-111111111111";
const sourceB = "22222222-2222-4222-8222-222222222222";
/** 生产 Host 路由形态：remote:server:<id>（不是 server:<id>）。 */
const hostA = configHostIdForSource(sourceA);
const hostB = configHostIdForSource(sourceB);
const identity = (sourceServerId: string, workspacePath: string) =>
  buildServerRemoteWorkspaceIdentity({ serverId: sourceServerId, workspacePath });

function project(
  hostId: string,
  legacySingleRoot = false,
  roots = ["/same", "/extra"],
): VirtualProject {
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
    legacySingleRoot,
  };
}
function snapshot(
  options: { online?: boolean; updatedAt?: Record<string, number>; ids?: string[] } = {},
): SourceServerManagementSnapshot {
  const online = options.online ?? true;
  const ids = options.ids ?? [sourceA, sourceB];
  return {
    generation: 1,
    profiles: [],
    workspaceHistory: [],
    migrationCounts: [],
    failedPathCount: 0,
    abandonedPathCount: 0,
    servers: ids.map((sourceServerId) => ({
      sourceServerId,
      displayName: sourceServerId,
      installState: "installed",
      declaredWorkspaces: [
        {
          workspacePath: "/declared",
          workspaceIdentity: identity(sourceServerId, "/declared"),
        },
      ],
    })),
    states: ids.map((sourceServerId) => ({
      profileId: sourceServerId,
      sourceServerId,
      state: online ? "online" : "offline",
      updatedAt: options.updatedAt?.[sourceServerId] ?? 1,
    })),
  };
}

describe("Settings 非 tab 配置目录", () => {
  it("canonical hostId 才能让在线 Source 的声明目录保持可写", () => {
    const projects = [project(hostA)];
    const canonical = deriveConfigDirectoryTargets({
      projects,
      snapshot: snapshot(),
      readyHosts: ["local", hostA],
      tabs: [],
    });
    expect(canonical.find((target) => target.workspacePath === "/declared")).toMatchObject({
      hostId: hostA,
      sourceServerId: sourceA,
      configOnline: true,
    });
    // 旧 UI 只把 server:<id> 放进 readyHosts；canonical target 不能因此伪装可写。
    const legacyReadyShape = deriveConfigDirectoryTargets({
      projects,
      snapshot: snapshot(),
      readyHosts: ["local", `server:${sourceA}`],
      tabs: [],
    });
    expect(legacyReadyShape.find((target) => target.workspacePath === "/declared")).toMatchObject({
      hostId: hostA,
      configOnline: false,
      disabledReason: "unavailable",
    });
  });

  it("全部 roots 与 tab 按 identity 合并，同 path 不同 Source 隔离", () => {
    const identityA = identity(sourceA, "/same");
    const targets = deriveConfigDirectoryTargets({
      projects: [project("local"), project(hostA), project(hostB)],
      snapshot: snapshot(),
      readyHosts: ["local", hostA, hostB],
      tabs: [
        {
          workspacePath: "/same",
          workspaceIdentity: identityA,
          label: "open A",
          remoteSessionId: "logical-a",
        },
      ],
    });
    expect(targets.filter((target) => target.workspacePath === "/same")).toHaveLength(3);
    expect(targets.find((target) => target.key === identityA)).toMatchObject({
      remoteSessionId: "logical-a",
      configOnline: true,
      sourceServerId: sourceA,
      hostId: hostA,
    });
    // 同 Source 的另一个目录没有自己的 logical attachment，不得借用 /same 的 session。
    expect(
      targets.find(
        (target) => target.sourceServerId === sourceA && target.workspacePath === "/extra",
      )?.remoteSessionId,
    ).toBeUndefined();
    expect(
      targets.find(
        (target) => target.sourceServerId === sourceB && target.workspacePath === "/extra",
      )?.remoteSessionId,
    ).toBeUndefined();
  });

  it("同 Source 同 path 的两个 legacy logical context 保持独立，不 canonical 化", () => {
    const legacyOne = "remote:ssh:host-a:22:user-a:/shared";
    const legacyTwo = "remote:ssh:host-a:22:user-b:/shared";
    const targets = deriveConfigDirectoryTargets({
      projects: [project(hostA, false, ["/shared"])],
      snapshot: snapshot({ ids: [sourceA] }),
      readyHosts: ["local", hostA],
      tabs: [
        {
          workspacePath: "/shared",
          workspaceIdentity: legacyOne,
          label: "legacy 1",
          remoteSessionId: "logical-1",
        },
        {
          workspacePath: "/shared",
          workspaceIdentity: legacyTwo,
          label: "legacy 2",
          remoteSessionId: "logical-2",
        },
      ],
    });
    expect(
      targets.filter((target) => target.workspacePath === "/shared" && !target.sourceServerId),
    ).toHaveLength(2);
    expect(targets.find((target) => target.key === legacyOne)).toMatchObject({
      remoteSessionId: "logical-1",
      workspaceIdentity: legacyOne,
      configOnline: true,
    });
    expect(targets.find((target) => target.key === legacyTwo)).toMatchObject({
      remoteSessionId: "logical-2",
      workspaceIdentity: legacyTwo,
      configOnline: true,
    });
    // 项目 root 的 canonical target 是第三条，不继承任何 legacy session。
    expect(targets.find((target) => target.key === identity(sourceA, "/shared"))).toMatchObject({
      remoteSessionId: undefined,
      sourceServerId: sourceA,
    });
  });

  it("offline 声明目录/保留 tab 与 legacy 显式只读", () => {
    const targets = deriveConfigDirectoryTargets({
      projects: [project("local", true)],
      snapshot: snapshot({ online: false }),
      readyHosts: ["local"],
      tabs: [
        {
          workspacePath: "/retained",
          workspaceIdentity: identity(sourceA, "/retained"),
          remoteSessionId: "stale",
          label: "retained",
        },
      ],
    });
    expect(targets.every((target) => !target.configOnline)).toBe(true);
    expect(targets.find((target) => target.workspacePath === "/retained")?.disabledReason).toBe(
      "offline",
    );
    expect(targets.find((target) => target.workspacePath === "/same")?.disabledReason).toBe(
      "legacy",
    );
  });

  it("既有 SSH logical target 保持可配置，不可寻址的旧项目显式只读", () => {
    const targets = deriveConfigDirectoryTargets({
      projects: [project("legacy-remote", true)],
      snapshot: null,
      readyHosts: ["local"],
      tabs: [
        {
          workspacePath: "/ssh",
          workspaceIdentity: "remote:ssh:host:22:user:/ssh",
          remoteSessionId: "live-ssh",
          label: "SSH",
        },
      ],
    });
    expect(targets.find((target) => target.workspacePath === "/ssh")?.configOnline).toBe(true);
    expect(targets.find((target) => target.workspacePath === "/same")?.disabledReason).toBe(
      "legacy",
    );
  });

  it("SSH 项目 roots 保留公开构造的 identity，不按 path 合并", () => {
    const sshHost = "remote:ssh:host-a:22:user-a";
    const targets = deriveConfigDirectoryTargets({
      projects: [project(sshHost, false, ["/same"])],
      snapshot: null,
      readyHosts: ["local"],
      tabs: [],
    });
    const sshProject = targets.find((target) => target.hostId === sshHost);
    expect(sshProject?.key).toBe(`${sshHost}:/same`);
    expect(sshProject?.workspaceIdentity).toBe(`${sshHost}:/same`);
    expect(sshProject?.sourceServerId).toBeUndefined();
  });

  it("源查询失败/尚未完成时不得沿用可写投影", () => {
    const targets = deriveConfigDirectoryTargets({
      projects: [project(hostA)],
      snapshot: snapshot(),
      tabs: [],
      readyHosts: [],
    });
    expect(targets.every((target) => !target.configOnline)).toBe(true);
  });

  it("Source 连接代际随 snapshot 更新，供 settings proxy 判序", () => {
    const targets = deriveConfigDirectoryTargets({
      projects: [],
      snapshot: snapshot({ updatedAt: { [sourceA]: 7 } }),
      readyHosts: ["local", hostA],
      tabs: [],
    });
    expect(targets.find((target) => target.sourceServerId === sourceA)?.sourceConnection).toBe(
      "online@7",
    );
    const offline = deriveConfigDirectoryTargets({
      projects: [],
      snapshot: snapshot({ online: false, updatedAt: { [sourceA]: 8 } }),
      readyHosts: ["local"],
      tabs: [],
    });
    expect(offline.find((target) => target.sourceServerId === sourceA)?.sourceConnection).toBe(
      "offline@8",
    );
  });

  it("hostId 只做路由键，Source 身份不靠字符串切片", () => {
    expect(hostA).toBe(remoteHostIdFromWorkspaceIdentity(identity(sourceA, "/")));
    expect(configHostIdForSource(sourceA)).toBe(`remote:server:${sourceA}`);
  });
});
