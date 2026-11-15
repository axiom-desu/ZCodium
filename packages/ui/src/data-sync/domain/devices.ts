import {
  parseRemoteWorkspaceIdentity,
  type RemoteTarget,
  type SourceServerManagementSnapshot,
  type SourceServerWorkspaceHistoryEntry,
} from "@zcode/shared";
import { deriveSourceConnectionKeys } from "@/lib/configDirectoryCatalog.js";
import { buildSourceProfileRows } from "@/lib/sourceServerManagement.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";

/** 设备行的连接维度：离线、连接中与各种待处理（安装/升级/身份）都归入非在线。 */
export type DataSyncDeviceConnection = "online" | "connecting" | "disconnected";

/** 数据同步页与入口共用的设备展示信息（来自 Source 管理快照）。 */
export interface DataSyncDeviceRow {
  sourceServerId: string;
  name: string;
  /** 「传输方式 · 目标地址」，例如 `SSH · dev@host:22`。 */
  description: string;
  remoteKind: RemoteTarget["kind"];
  connection: DataSyncDeviceConnection;
  /** 「连接」交给连接向导的 Profile，与传输方式、地址取自同一条 Profile。 */
  profileId: string;
}

const CONNECTING_STATES = new Set(["bootstrapping", "updating", "retrying"]);

/**
 * 设备来自本机 Source 管理快照：已安装、且至少有一条未退役 Connection Profile 的设备。
 * 传输方式、地址与 Profile 沿用 `buildSourceProfileRows` 的同一条选择规则；连接状态只取自管理快照，
 * 页面不另存。dev-only 的 Server 直连不是 Connection Profile，天然不在快照中。
 */
export function buildDataSyncDevices(
  snapshot: SourceServerManagementSnapshot | null,
): DataSyncDeviceRow[] {
  if (!snapshot) return [];
  const installed = new Set(
    snapshot.servers
      .filter((server) => server.installState === "installed")
      .map((server) => server.sourceServerId),
  );
  const byDevice = new Map<string, DataSyncDeviceRow>();
  for (const profile of buildSourceProfileRows(snapshot)) {
    const sourceServerId = profile.sourceServerId;
    // 同一设备可能有多条线路：只保留快照顺序中的第一条，避免设备行重复。
    if (!sourceServerId || !installed.has(sourceServerId) || byDevice.has(sourceServerId)) continue;
    byDevice.set(sourceServerId, {
      sourceServerId,
      name: profile.displayName,
      description: `${profile.transport.toUpperCase()} · ${profile.targetLabel}`,
      remoteKind: profile.transport,
      connection:
        profile.state === "online"
          ? "online"
          : CONNECTING_STATES.has(profile.state)
            ? "connecting"
            : "disconnected",
      profileId: profile.profileId,
    });
  }
  return [...byDevice.values()].sort(
    (left, right) =>
      (left.connection === "online" ? 0 : 1) - (right.connection === "online" ? 0 : 1) ||
      left.name.localeCompare(right.name) ||
      left.sourceServerId.localeCompare(right.sourceServerId),
  );
}

/** 设备是否在线：与设备行的「已连接」判断一致，只取自管理快照。 */
export function isDataSyncDeviceOnline(
  snapshot: SourceServerManagementSnapshot | null,
  sourceServerId: string | undefined,
): boolean {
  if (!sourceServerId) return false;
  return Boolean(
    snapshot?.states.some(
      (state) => state.sourceServerId === sourceServerId && state.state === "online",
    ),
  );
}

/**
 * 设备连接代际：断线 / 重连换代后旧的 source-settings proxy 不得继续冒充当前连接。
 * 复用设置目录同一条派生规则，不手写第二格式。
 */
export function dataSyncConnectionKey(
  snapshot: SourceServerManagementSnapshot | null,
  sourceServerId: string,
): string {
  return deriveSourceConnectionKeys(snapshot).get(sourceServerId) ?? "";
}

/**
 * 旧格式（非 server identity）的远程 tab 用 workspace history 反查设备；
 * server identity 直接解析，不按路径猜测。
 */
export function resolveTabSourceServerId(
  tab: Pick<WorkspaceTabState, "workspacePath" | "workspaceIdentity">,
  workspaceHistory: readonly SourceServerWorkspaceHistoryEntry[] | undefined,
): string | undefined {
  const identity = tab.workspaceIdentity?.trim();
  const parsed = identity ? parseRemoteWorkspaceIdentity(identity) : null;
  if (parsed?.kind === "server" && parsed.sourceServerId) return parsed.sourceServerId;
  return workspaceHistory?.find(
    (entry) =>
      entry.workspacePath === tab.workspacePath &&
      (entry.workspaceIdentity ?? "") === (identity ?? ""),
  )?.sourceServerId;
}

/** 当前窗口中打开在该设备上的 workspace tab。 */
export function selectTabsOnDevice(
  workspaceTabs: readonly WorkspaceTabState[] | undefined,
  workspaceHistory: readonly SourceServerWorkspaceHistoryEntry[] | undefined,
  sourceServerId: string,
): WorkspaceTabState[] {
  return (workspaceTabs ?? []).filter(
    (tab) => resolveTabSourceServerId(tab, workspaceHistory) === sourceServerId,
  );
}
