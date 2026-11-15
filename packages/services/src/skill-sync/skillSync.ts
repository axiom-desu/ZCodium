import type {
  SkillDataSyncPayload,
  SkillSyncArchiveExportResult,
  SkillSyncCandidateListResult,
  SkillSyncImportResult,
  SkillSyncRemoteStatusResult,
  RemoteSyncWriteAccessResult,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import type { IDataSyncCategoryService } from "../data-sync/contract.js";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * 技能通道：旧候选/归档同步方法（设置页同步弹窗仍在调用，保留为同一 owner 适配面）
 * + 数据同步五方法（IDataSyncCategoryService）。
 */
export interface ISkillSyncService extends IDataSyncCategoryService<SkillDataSyncPayload> {
  listLocalUserSkillCandidates(): Promise<SkillSyncCandidateListResult>;
  listRemoteUserSkillStatuses(params: {
    directoryNames: string[];
    skills?: Array<{
      directoryName: string;
      name: string;
    }>;
  }): Promise<SkillSyncRemoteStatusResult>;
  exportSkillsArchive(params: { skillIds: string[] }): Promise<SkillSyncArchiveExportResult>;
  checkRemoteUserSkillWriteAccess(): Promise<RemoteSyncWriteAccessResult>;
  importSkillsArchive(params: {
    archive: Uint8Array;
    overwrite?: false;
  }): Promise<SkillSyncImportResult>;
}

export const ISkillSyncService = createServiceDescriptor<ISkillSyncService>(
  ServiceChannels.SkillSync,
);
