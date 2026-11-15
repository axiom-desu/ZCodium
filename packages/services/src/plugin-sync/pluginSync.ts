import type {
  PluginDataSyncPayload,
  PluginSyncArchiveExportResult,
  PluginSyncCandidateListResult,
  PluginSyncImportResult,
  PluginSyncRemoteStatusResult,
  RemoteSyncWriteAccessResult,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import type { IDataSyncCategoryService } from "../data-sync/contract.js";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * 插件通道：旧候选/归档同步方法与 marketplace 来源镜像（设置页同步弹窗仍在调用，保留为
 * 同一 owner 适配面）+ 数据同步五方法（IDataSyncCategoryService，inline 插件）。
 */
export interface IPluginSyncService extends IDataSyncCategoryService<PluginDataSyncPayload> {
  listLocalUserPluginCandidates(): Promise<PluginSyncCandidateListResult>;
  listRemoteUserPluginStatuses(params: {
    plugins: Array<{
      pluginId: string;
      directoryName: string;
    }>;
  }): Promise<PluginSyncRemoteStatusResult>;
  exportPluginsArchive(params: { pluginIds: string[] }): Promise<PluginSyncArchiveExportResult>;
  exportMarketplaceSourceArchive(params: {
    marketplaceId: string;
    pluginNames: string[];
    source: Record<string, unknown>;
  }): Promise<{
    archive: Uint8Array;
    archiveBytes: number;
    marketplaceId: string;
    pluginNames: string[];
  }>;
  importPluginsArchive(params: {
    archive: Uint8Array;
    overwrite?: false;
  }): Promise<PluginSyncImportResult>;
  checkRemoteUserPluginWriteAccess(): Promise<RemoteSyncWriteAccessResult>;
  importMarketplaceSourceArchive(params: { archive: Uint8Array; overwrite?: false }): Promise<{
    marketplaceId: string;
    path: string;
    status: "skipped" | "synced";
  }>;
}

export const IPluginSyncService = createServiceDescriptor<IPluginSyncService>(
  ServiceChannels.PluginSync,
);
