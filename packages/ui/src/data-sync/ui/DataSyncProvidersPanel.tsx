import { ChevronRight, CircleAlert, Info, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { DataSyncProvidersState } from "../app/useDataSyncProviders.js";
import {
  resolveDataSyncProvisioningDisplay,
  type DataSyncProvisioningDisplay,
} from "../domain/providers.js";

type Intl = ReturnType<typeof useZCodeIntl>;

const ERROR_MESSAGE_ID: Record<string, string> = {
  "source-read-failed": "dataSync.providers.error.sourceReadFailed",
  "target-call-failed": "dataSync.providers.error.targetCallFailed",
  "target-write-failed": "dataSync.providers.error.targetWriteFailed",
  "target-refresh-failed": "dataSync.providers.error.targetRefreshFailed",
  "target-commit-failed": "dataSync.providers.error.targetCommitFailed",
  "target-apply-failed": "dataSync.providers.error.targetApplyFailed",
  "capability-unavailable": "dataSync.providers.error.capabilityUnavailable",
  "session-unavailable": "dataSync.providers.error.sessionUnavailable",
  "host-execution-failed": "dataSync.providers.error.hostExecutionFailed",
};

function formatTime(locale: string, at: number): string {
  return new Date(at).toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatStatus({ intl, locale }: Intl, display: DataSyncProvisioningDisplay): string {
  switch (display.kind) {
    case "loading":
      return intl.formatMessage({ id: "dataSync.overview.loading" });
    case "error":
      return intl.formatMessage({ id: "dataSync.providers.status.loadFailed" });
    case "none":
      return intl.formatMessage({ id: "dataSync.providers.status.noLane" });
    case "running":
      return intl.formatMessage({ id: "dataSync.providers.status.running" });
    case "never":
      return intl.formatMessage({ id: "dataSync.providers.status.never" });
    case "success":
      return intl.formatMessage(
        { id: "dataSync.providers.status.success" },
        { time: formatTime(locale, display.at) },
      );
    case "failed":
      return intl.formatMessage(
        { id: "dataSync.providers.status.failed" },
        {
          time: formatTime(locale, display.at),
          reason: intl.formatMessage({
            id:
              (display.errorCode && ERROR_MESSAGE_ID[display.errorCode]) ||
              "dataSync.providers.error.unknown",
          }),
        },
      );
  }
}

/** 模型提供商分类页（只读）：说明、最近一次自动同步的结果、失败时的「重试」，以及本机提供商列表。 */
export function DataSyncProvidersPanel(props: {
  state: DataSyncProvidersState;
  /** 设备离线时禁用重试。 */
  disabled: boolean;
}) {
  const intl = useZCodeIntl();
  const { formatMessage } = intl.intl;
  const { state } = props;
  const display = resolveDataSyncProvisioningDisplay(state.provisioning, state.retrying);
  const failed = display.kind === "failed";
  return (
    <div
      data-testid="data-sync-resource-panel"
      className="flex h-full min-h-0 flex-col gap-3 overflow-hidden"
    >
      <div
        data-testid="data-sync-providers-notice"
        className="flex shrink-0 items-start gap-2 rounded-xl border border-border px-3 py-2 text-ui-sm text-foreground-subtle"
      >
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {formatMessage({ id: "dataSync.category.providers.warning" })}
      </div>
      <div
        data-testid="data-sync-providers-status"
        data-provisioning-state={display.kind}
        className={cn(
          "flex shrink-0 items-center gap-3 rounded-xl px-3 py-2 text-ui-sm",
          failed
            ? "bg-destructive-surface text-destructive-surface-foreground"
            : "border border-border text-foreground-subtle",
        )}
      >
        {display.kind === "running" ? (
          <RefreshCw className="size-4 shrink-0 animate-spin" aria-hidden="true" />
        ) : failed ? (
          <CircleAlert className="size-4 shrink-0" aria-hidden="true" />
        ) : (
          <RefreshCw className="size-4 shrink-0" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1">{formatStatus(intl, display)}</span>
        {/* 重试只在有 lane 且最近一次失败时出现：没有 lane 时没有可下发的会话。 */}
        {failed ? (
          <Button
            type="button"
            data-testid="data-sync-providers-retry"
            variant="outline"
            size="sm"
            className="shrink-0"
            disabled={props.disabled}
            onClick={state.retry}
          >
            <RefreshCw aria-hidden="true" />
            {formatMessage({ id: "dataSync.action.retry" })}
          </Button>
        ) : null}
      </div>
      <div
        data-testid="data-sync-resource-list"
        className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto rounded-xl border border-border bg-background/50 p-2"
      >
        {state.list.phase === "loading" ? (
          <p className="px-3 py-6 text-center text-ui-sm text-foreground-subtle">
            {formatMessage({ id: "dataSync.overview.loading" })}
          </p>
        ) : state.list.phase === "error" ? (
          <p className="px-3 py-6 text-center text-ui-sm text-destructive">
            {formatMessage({ id: "dataSync.overview.loadFailed" })}
          </p>
        ) : state.list.rows.length === 0 ? (
          <p className="px-3 py-6 text-center text-ui-sm text-foreground-subtle">
            {formatMessage({ id: "dataSync.providers.empty" })}
          </p>
        ) : (
          state.list.rows.map((row) => (
            <div
              key={row.providerId}
              data-testid={`data-sync-provider-${row.providerId}`}
              className="flex gap-3 rounded-lg bg-background p-3"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-ui-base font-medium text-foreground">
                  {row.name}
                </span>
                <span className="mt-0.5 block truncate text-ui-sm text-foreground-subtle">
                  {[
                    row.endpoint,
                    row.models.join(formatMessage({ id: "dataSync.dependency.nameSeparator" })),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
              {row.maskedApiKey ? (
                <span
                  data-testid={`data-sync-provider-key-${row.providerId}`}
                  className="mt-0.5 shrink-0 self-start font-mono text-ui-xs text-foreground-subtle"
                >
                  {formatMessage({ id: "dataSync.providers.apiKey" }, { key: row.maskedApiKey })}
                </span>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/** 概览中模型提供商一行：勾选框不可用；最近一次失败显示「同步失败」，其他情况显示「自动同步」。 */
export function DataSyncProvidersOverviewRow(props: {
  state: DataSyncProvidersState;
  label: string;
  onNavigate(): void;
}) {
  const { intl } = useZCodeIntl();
  const display = resolveDataSyncProvisioningDisplay(
    props.state.provisioning,
    props.state.retrying,
  );
  const failed = display.kind === "failed";
  return (
    <div className="grid grid-cols-[32px_minmax(0,1fr)] items-center gap-4 rounded-lg bg-background px-4 transition-colors hover:bg-surface-hover/50">
      <Checkbox
        data-testid="data-sync-overview-checkbox-providers"
        aria-label={props.label}
        checked={false}
        disabled
      />
      <button
        type="button"
        data-testid="data-sync-overview-providers"
        onClick={props.onNavigate}
        className="grid w-full grid-cols-[minmax(0,1fr)_64px_64px_minmax(120px,220px)] items-center gap-4 py-3 text-left text-ui-base"
      >
        <span className="truncate font-medium text-foreground">{props.label}</span>
        <span
          data-testid="data-sync-overview-local-providers"
          className="text-center tabular-nums text-foreground-subtle"
        >
          {props.state.list.phase === "ready" ? props.state.list.rows.length : "–"}
        </span>
        <span
          data-testid="data-sync-overview-remote-providers"
          className="text-center tabular-nums text-foreground-subtle"
        >
          –
        </span>
        <span className="flex min-w-0 items-center justify-end gap-2 text-foreground-subtle">
          <span className={cn("truncate text-right", failed && "text-destructive")}>
            {intl.formatMessage({
              id: failed ? "dataSync.overview.syncFailed" : "dataSync.overview.autoSync",
            })}
          </span>
          <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />
        </span>
      </button>
    </div>
  );
}
