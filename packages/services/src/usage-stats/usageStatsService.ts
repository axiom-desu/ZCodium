import type {
  ApiClient,
  AppUsageRequest,
  AppUsageSnapshot,
  CodingPlanQuotaRequest,
  CodingPlanQuotaSnapshot,
} from "@zcode/shared";
import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import { fetchCodingPlanQuota } from "./codingPlanQuota.js";
import type { IUsageStatsService } from "./usageStats.js";

interface UsageStatsServiceDependencies {
  /** 统计属于当前 Environment 的 Agent 数据库，不依赖账号或远端计费服务。 */
  zcodeAgentService: Pick<IZCodeAgentService, "getAppUsageStats">;
  /** 额度查询复用宿主 ApiClient，代理/超时/端点判定与其它请求同源。 */
  apiClient?: ApiClient;
}

export function createUsageStatsService(
  dependencies: UsageStatsServiceDependencies,
): IUsageStatsService {
  return {
    async getAppUsageSnapshot(request: AppUsageRequest): Promise<AppUsageSnapshot> {
      return dependencies.zcodeAgentService.getAppUsageStats({
        range: request.range,
        timeZone: request.timeZone,
      });
    },
    async getCodingPlanQuota(request: CodingPlanQuotaRequest): Promise<CodingPlanQuotaSnapshot> {
      const apiClient = dependencies.apiClient;
      if (!apiClient) {
        throw new Error("Coding Plan 额度查询未完成 ApiClient 装配");
      }
      const result = await fetchCodingPlanQuota({ apiClient, request });
      // 失败必须以错误暴露：空快照会让 UI 把"查不到"渲染成"已用完"。
      if (!result.success) {
        throw new Error(`${result.error.code}: ${result.error.message}`);
      }
      return result.snapshot;
    },
  };
}
