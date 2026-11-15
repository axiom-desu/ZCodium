import type { VirtualProject } from "#src/project/contract.js";
import type {
  RemoteProjectEntry,
  RemoteProjectEntryInput,
  RemoteProjectRefreshEntry,
} from "#src/project-storage/contract.js";
import { createServiceDescriptor } from "#src/descriptors.js";
import { ServiceChannels } from "@zcode/shared";

/** 只读组合：本机权威项目与远端入口 intent 分开返回，身份不混淆。 */
export interface ProjectCatalog {
  localProjects: VirtualProject[];
  /** 离线投影隐藏 cachedDeleted 入口；原文可经 listEntries 读取。 */
  remoteProjects: RemoteProjectEntry[];
}

/**
 * 本机远端项目入口的唯一 owner（spec: .agents/specs/upstream-3.18-worktrees-remote-projects.md）。
 *
 * 只持久化用户选择的 intent（remote_project_entries）；连接/身份/在线事实仍归
 * windowRemoteConnectionRegistry。removeEntry 只删本机 membership/cache，绝不发远端删除。
 * 仅本地桌面 Host 注册；Web/mobile 默认拒绝。
 */
export interface IRemoteProjectService {
  listEntries(params?: { hostId?: string }): Promise<RemoteProjectEntry[]>;
  /** membership 由连接 registry 提供；与本机记录不一致时拒绝（stale window/connection）。 */
  addEntry(input: RemoteProjectEntryInput): Promise<RemoteProjectEntry>;
  /** 远端目录刷新只更新匹配的存活入口；迟到响应不重建已移除入口。 */
  refreshDirectory(input: {
    hostId: string;
    membershipId: string;
    entries: readonly RemoteProjectRefreshEntry[];
  }): Promise<RemoteProjectEntry[]>;
  removeEntry(params: { entryId: string; hostId?: string }): Promise<void>;
  /** 显式恢复缓存删除入口；仅清本机标记，不请求远端。 */
  restoreEntry(params: { entryId: string; hostId?: string }): Promise<RemoteProjectEntry>;
  readCatalog(params?: { hostId?: string }): Promise<ProjectCatalog>;
}

export const IRemoteProjectService = createServiceDescriptor<IRemoteProjectService>(
  ServiceChannels.RemoteProjects,
);
