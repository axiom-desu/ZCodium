import type {
  AppUsageRequest,
  AppUsageSnapshot,
  CodingPlanQuotaRequest,
  CodingPlanQuotaSnapshot,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface IUsageStatsService {
  getAppUsageSnapshot(request: AppUsageRequest): Promise<AppUsageSnapshot>;
  /**
   * 用用户自己的 Coding Plan API Key 查询剩余额度。
   *
   * 额度是远端事实且不落盘；失败以错误抛出，不用空快照冒充"额度用完"。
   */
  getCodingPlanQuota(request: CodingPlanQuotaRequest): Promise<CodingPlanQuotaSnapshot>;
}

export const IUsageStatsService = createServiceDescriptor<IUsageStatsService>(
  ServiceChannels.UsageStats,
);
