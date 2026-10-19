import { RefreshCcw } from "lucide-react";
import type { CodingPlanQuotaSnapshot, UsageQuotaLimit } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Progress } from "@/components/ui/progress.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useCodingPlanQuota } from "@/hooks/useCodingPlanQuota.js";
import { formatCompactNumber } from "@/settings/usage-stats/usageStatsUiParts.js";

/**
 * Coding Plan 剩余额度面板。
 *
 * 三种空态必须彼此可分，否则用户会把“没填 Key”、“查询失败”、“真没额度”混为一谈：
 * pending（待填 Key）/ error（查询失败）/ empty（接口没返回限额）。
 */
export function CodingPlanQuotaPanel() {
  const { intl } = useZCodeIntl();
  const quota = useCodingPlanQuota();

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="text-ui-base font-medium text-foreground">
        {intl.formatMessage({ id: "settings.usage.codingPlanQuota.title" })}
      </div>
      {quota.activeCandidate ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 rounded-md bg-background"
          disabled={quota.loading}
          onClick={() => void quota.refresh()}
        >
          <RefreshCcw className="size-3.5" />
          {intl.formatMessage({ id: "settings.usage.refresh" })}
        </Button>
      ) : null}
    </div>
  );

  if (!quota.activeCandidate) {
    return (
      <section className="space-y-3">
        {header}
        <p className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({
            id: quota.pendingConnection
              ? "settings.usage.codingPlanQuota.apiKeyRequired"
              : "settings.usage.codingPlanQuota.noProvider",
          })}
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      {header}
      <p className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.usage.codingPlanQuota.description" })}
      </p>
      {quota.error ? (
        <p role="alert" className="text-ui-base text-warning">
          {intl.formatMessage({ id: "settings.usage.codingPlanQuota.error" })}
        </p>
      ) : null}
      {quota.loading && !quota.snapshot ? (
        <p role="status" className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "common.loading" })}
        </p>
      ) : null}
      {quota.snapshot ? <QuotaLimits snapshot={quota.snapshot} /> : null}
      {!quota.loading && !quota.error && !quota.snapshot ? (
        <p className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.usage.codingPlanQuota.empty" })}
        </p>
      ) : null}
    </section>
  );
}

function QuotaLimits({ snapshot }: { snapshot: CodingPlanQuotaSnapshot }) {
  const { intl, locale } = useZCodeIntl();
  const limits = snapshot.limits.filter(hasDisplayableValue);

  if (limits.length === 0) {
    return (
      <p className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.usage.codingPlanQuota.empty" })}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {limits.map((limit) => (
        <QuotaLimitRow key={`${limit.type}-${limit.nextResetTime ?? 0}`} limit={limit} />
      ))}
      <p className="text-ui-xs text-foreground-subtlest">
        {intl.formatMessage(
          {
            id: "settings.usage.codingPlanQuota.fetchedAt",
          },
          { time: formatFetchedAt(locale, snapshot.fetchedAt) },
        )}
      </p>
    </div>
  );
}

/** 只渲染能表达剩余量的桶，避免把 0 值占位当成“已用完”。 */
function hasDisplayableValue(limit: UsageQuotaLimit): boolean {
  return (
    typeof limit.remaining === "number" ||
    typeof limit.currentValue === "number" ||
    typeof limit.percentage === "number" ||
    typeof limit.number === "number"
  );
}

function resolveQuotaLabelId(limit: UsageQuotaLimit): string {
  if (limit.type === "TIME_LIMIT") return "settings.usage.codingPlanQuota.windowLimit";
  if (limit.type === "TOKENS_LIMIT") return "settings.usage.codingPlanQuota.tokenLimit";
  return "settings.usage.codingPlanQuota.genericLimit";
}

function QuotaLimitRow({ limit }: { limit: UsageQuotaLimit }) {
  const { intl, locale } = useZCodeIntl();
  // 服务端的 percentage 是"已使用占比"，展示剩余必须反转；没有该字段时退回 remaining/number。
  const usedPercent =
    typeof limit.percentage === "number"
      ? Math.min(Math.max(limit.percentage, 0), 1)
      : typeof limit.remaining === "number" && typeof limit.number === "number" && limit.number > 0
        ? Math.min(Math.max(1 - limit.remaining / limit.number, 0), 1)
        : null;
  const remainingPercent = usedPercent === null ? null : 1 - usedPercent;
  const remainingValue =
    typeof limit.remaining === "number"
      ? formatCompactNumber(locale, limit.remaining)
      : typeof limit.number === "number" && usedPercent !== null
        ? formatCompactNumber(locale, Math.round(limit.number * remainingPercent!))
        : "--";

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2 text-ui-base">
        <span className="text-foreground-subtle">
          {intl.formatMessage({ id: resolveQuotaLabelId(limit) })}
        </span>
        <span className="font-medium text-foreground">
          {intl.formatMessage(
            { id: "settings.usage.codingPlanQuota.remainingValue" },
            { value: remainingValue },
          )}
        </span>
      </div>
      {remainingPercent !== null ? (
        <Progress
          value={remainingPercent * 100}
          aria-label={intl.formatMessage({ id: resolveQuotaLabelId(limit) })}
        />
      ) : null}
      {typeof limit.nextResetTime === "number" ? (
        <p className="text-ui-xs text-foreground-subtlest">
          {intl.formatMessage(
            { id: "settings.usage.codingPlanQuota.nextReset" },
            { time: formatResetTime(locale, limit.nextResetTime) },
          )}
        </p>
      ) : null}
    </div>
  );
}

function formatFetchedAt(locale: string, fetchedAt: number): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(fetchedAt));
}

function formatResetTime(locale: string, timestamp: number): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}
