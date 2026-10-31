import type { VirtualProject } from "@zcode/services";
import {
  buildRemoteHostWorkspaceIdentity,
  buildServerRemoteWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
  type RemoteTarget,
  type SourceServerManagementSnapshot,
} from "@zcode/shared";

/** 配置范围的目录描述，不要求 tab/id/session，更不拥有 workspace 生命周期。 */
export interface PluginWorkspaceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  label: string;
  remoteSessionId?: string;
  remoteTarget?: RemoteTarget;
  localWorkspacePath?: string;
  availability?: "available" | "unavailable-local-directory";
  configOnline?: boolean;
  sourceServerId?: string;
}
export interface ConfigDirectoryTarget extends PluginWorkspaceTarget {
  key: string;
  /** readProjects 的 exact 路由值（local / remote:server:<id> / remote:<kind>:...）。 */
  hostId: string;
  sourceServerId?: string;
  /** Source 连接代际；旧代 Source settings proxy 不得跨代复用。 */
  sourceConnection: string;
  configOnline: boolean;
  sourceGeneration: number;
  disabledReason?: "offline" | "legacy" | "unavailable";
}

export function configSourceOnline(
  snapshot: SourceServerManagementSnapshot | null,
  id: string,
): boolean {
  return Boolean(
    snapshot?.servers.some((server) => server.sourceServerId === id) &&
    snapshot.states.some((state) => state.sourceServerId === id && state.state === "online"),
  );
}

/**
 * Source 的 canonical Host 路由 id。生产 Host 的 resolveProjectHostService 只接受
 * `remote:server:<id>`；这里复用 SHARED 的构造/解析入口，不手写第二格式。
 */
export function configHostIdForSource(sourceServerId: string): string {
  const hostId = remoteHostIdFromWorkspaceIdentity(
    buildServerRemoteWorkspaceIdentity({ serverId: sourceServerId, workspacePath: "/" }),
  );
  if (!hostId) throw new Error("Invalid Source Server workspace identity");
  return hostId;
}

/** 从 exact hostId 还原 Source id；非 server/非 remote/非法 hostId 一律 undefined。 */
// 只在 catalog 内部把 hostId 反解成 Source id；不是跨模块入口，因此不做公开导出。
function configSourceServerIdFromHostId(hostId: string): string | undefined {
  if (hostId === "local") return undefined;
  try {
    return parseRemoteWorkspaceIdentity(buildRemoteHostWorkspaceIdentity(hostId, "/"))
      ?.sourceServerId;
  } catch {
    return undefined;
  }
}

/** 每个 Source 的连接代际（在线状态 + 状态时间戳），只来自 Source 管理快照。 */
export function deriveSourceConnectionKeys(
  snapshot: SourceServerManagementSnapshot | null,
): Map<string, string> {
  const keys = new Map<string, string>();
  for (const state of snapshot?.states ?? []) {
    if (state.sourceServerId) keys.set(state.sourceServerId, `${state.state}@${state.updatedAt}`);
  }
  return keys;
}

/**
 * 配置面板是否可直接复用既有 logical session。remoteSessionId 属于 workspace scope：
 * 只有 target 自己的 session 精确命中才成立，否则走 Source settings attachment。
 */
export function isExactConfigLogicalSession(
  target: Pick<ConfigDirectoryTarget, "remoteSessionId"> | null | undefined,
  resolvedRemoteSessionId: string | null | undefined,
): boolean {
  return Boolean(target?.remoteSessionId) && target?.remoteSessionId === resolvedRemoteSessionId;
}

export function deriveConfigDirectoryTargets(params: {
  projects: readonly VirtualProject[];
  tabs: readonly PluginWorkspaceTarget[];
  snapshot: SourceServerManagementSnapshot | null;
  readyHosts: readonly string[];
}): ConfigDirectoryTarget[] {
  const targets = new Map<string, ConfigDirectoryTarget>();
  const ready = new Set(params.readyHosts);
  const connections = deriveSourceConnectionKeys(params.snapshot);
  const add = (input: PluginWorkspaceTarget, hostId: string, legacy = false) => {
    // hostId 只做路由，Source 身份显式携带或由 canonical hostId 解析，绝不切片猜测。
    const sourceServerId = input.sourceServerId?.trim() || configSourceServerIdFromHostId(hostId);
    const workspaceIdentity = sourceServerId
      ? buildServerRemoteWorkspaceIdentity({
          serverId: sourceServerId,
          workspacePath: input.workspacePath,
        })
      : input.workspaceIdentity;
    const key = workspaceIdentity?.trim() || input.workspacePath;
    const offline = sourceServerId
      ? !configSourceOnline(params.snapshot, sourceServerId)
      : hostId !== "local" && !input.remoteSessionId;
    // 已开 tab 自带 logical session 时可以不等目录枚举完成；Source 仍受在线事实约束。
    const unready = !ready.has(hostId) && !(input.remoteSessionId && hostId.startsWith("remote:"));
    const disabledReason = legacy
      ? "legacy"
      : offline
        ? "offline"
        : input.availability === "unavailable-local-directory" || unready
          ? "unavailable"
          : undefined;
    const previous = targets.get(key);
    targets.set(key, {
      ...previous,
      ...input,
      workspaceIdentity,
      key,
      hostId,
      sourceServerId,
      sourceConnection: sourceServerId ? (connections.get(sourceServerId) ?? "") : "",
      sourceGeneration: params.snapshot?.generation ?? 0,
      // 项目 legacy 事实优先，不能被同目录已开 tab 覆盖成可写。
      configOnline: !disabledReason && previous?.disabledReason !== "legacy",
      disabledReason: previous?.disabledReason === "legacy" ? "legacy" : disabledReason,
      remoteSessionId: input.remoteSessionId ?? previous?.remoteSessionId,
    });
  };
  for (const project of params.projects) {
    if (project.deleted) continue;
    for (const root of project.roots) {
      const remoteIdentity =
        project.hostId === "local"
          ? undefined
          : (() => {
              try {
                return buildRemoteHostWorkspaceIdentity(project.hostId, root.rootPath);
              } catch {
                return undefined;
              }
            })();
      const unaddressable = project.hostId !== "local" && !remoteIdentity;
      if (unaddressable) {
        const key = `${project.hostId}\0${root.rootPath}`;
        targets.set(key, {
          key,
          hostId: project.hostId,
          sourceServerId: undefined,
          sourceConnection: "",
          sourceGeneration: params.snapshot?.generation ?? 0,
          workspacePath: root.rootPath,
          label: `${project.name} · ${root.rootPath}`,
          configOnline: false,
          disabledReason: "legacy",
        });
      } else
        add(
          {
            workspacePath: root.rootPath,
            // SSH/WSL/Docker 项目的 identity 来自同一公开构造入口；不进 add 会被 path key 合并。
            workspaceIdentity: remoteIdentity,
            label: `${project.name} · ${root.rootPath}`,
          },
          project.hostId,
          project.legacySingleRoot,
        );
    }
  }
  for (const server of params.snapshot?.servers ?? []) {
    for (const directory of server.declaredWorkspaces) {
      const identity = buildServerRemoteWorkspaceIdentity({
        serverId: server.sourceServerId,
        workspacePath: directory.workspacePath,
      });
      if (!targets.has(identity))
        add(
          {
            ...directory,
            label: directory.label ?? directory.workspacePath,
          },
          configHostIdForSource(server.sourceServerId),
        );
    }
  }
  for (const tab of params.tabs) {
    // 远端 tab 的 hostId 也来自 canonical identity；server/ssh/wsl/docker 同一条规则。
    const hostId = tab.workspaceIdentity?.trim()
      ? remoteHostIdFromWorkspaceIdentity(tab.workspaceIdentity)
      : null;
    // 有远端元数据却没有 canonical identity 的旧 tab 只能显式只读，不能冒充 local。
    if (!hostId && (tab.workspaceIdentity || tab.remoteTarget || tab.remoteSessionId)) {
      const key =
        tab.workspaceIdentity?.trim() || `${tab.remoteSessionId ?? "remote"}\0${tab.workspacePath}`;
      targets.set(key, {
        ...tab,
        key,
        hostId: "legacy",
        sourceServerId: undefined,
        sourceConnection: "",
        sourceGeneration: params.snapshot?.generation ?? 0,
        configOnline: false,
        disabledReason: "legacy",
      });
    } else add(tab, hostId ?? "local");
  }
  // remoteSessionId 只按 identity 合并（add 内 previous/input 合并），不做 Source 级借用。
  return [...targets.values()].map((target) => ({
    ...target,
    label: target.sourceServerId
      ? `${params.snapshot?.servers.find((server) => server.sourceServerId === target.sourceServerId)?.displayName ?? target.sourceServerId} · ${target.label}`
      : target.label,
  }));
}
