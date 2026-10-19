import { AppUsagePanel } from "@/settings/usage-stats/AppUsagePanel.js";
import { CodingPlanQuotaPanel } from "@/settings/usage-stats/CodingPlanQuotaPanel.js";

export function UsageStatsSection() {
  // 使用统计由 Agent 本地记录提供；剩余额度用用户自己填的 Coding Plan API Key 查询，
  // 两者都不依赖账号登录，也不互相覆盖各自的加载与失败状态。
  return (
    <div className="space-y-6">
      <CodingPlanQuotaPanel />
      <AppUsagePanel />
    </div>
  );
}
