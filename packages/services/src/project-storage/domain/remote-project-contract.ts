/** 用户显式添加的远端项目入口（持久 intent，不是连接事实）。 */
export interface RemoteProjectEntry {
  entryId: string;
  hostId: string;
  remoteProjectId: string | null;
  name: string;
  roots: string[];
  /** 远端目录已删除的离线缓存；removeEntry 不设置它，也不触发远端删除。 */
  cachedDeleted: boolean;
  lastSyncedAt: number | null;
}

export interface RemoteProjectEntryInput {
  hostId: string;
  /** Host 在本地 tasks-index 持有的成员标识；与库内不一致即 stale。 */
  membershipId: string;
  remoteProjectId: string;
  name: string;
  roots: string[];
}

export interface RemoteProjectRefreshEntry {
  remoteProjectId: string;
  name: string;
  roots: string[];
  deleted: boolean;
}

/**
 * remote_project_entries 的唯一写仓储。membership CAS 在同一事务内校验；
 * 刷新只更新已存在且未被移除的入口，迟到响应不得重建入口。
 */
export interface RemoteProjectRepositoryContract {
  list(hostId?: string): RemoteProjectEntry[];
  /** 显式添加/恢复：同 (host, remoteProjectId) 已存在时复活并清除缓存删除标记。 */
  add(input: RemoteProjectEntryInput): RemoteProjectEntry;
  refresh(input: {
    hostId: string;
    membershipId: string;
    entries: readonly RemoteProjectRefreshEntry[];
    now?: number;
  }): RemoteProjectEntry[];
  /** 只删本机 entry，不调用远端删除。 */
  remove(entryId: string, hostId?: string): void;
  /** 显式恢复缓存删除入口（离线投影）。 */
  restore(entryId: string, hostId?: string): RemoteProjectEntry;
}
