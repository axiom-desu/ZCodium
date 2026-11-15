import { ChevronRight } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { DATA_SYNC_CATEGORIES } from "../app/categories.js";
import type { DataSyncCategoryView } from "../app/types.js";
import type { DataSyncCategoryId } from "../contract.js";
import type { useDataSyncProviders } from "../app/useDataSyncProviders.js";
import { DataSyncProvidersOverviewRow } from "./DataSyncProvidersPanel.js";

type FormatMessage = ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"];

export function DataSyncOverviewPanel(props: {
  providers: ReturnType<typeof useDataSyncProviders>;
  views: Readonly<Record<string, DataSyncCategoryView>>;
  disabled: boolean;
  formatMessage: FormatMessage;
  onNavigate(id: "providers" | DataSyncCategoryId): void;
  onSelectionChange(id: DataSyncCategoryId, keys: Iterable<string>): void;
}) {
  const { formatMessage } = props;
  return (
    <div
      data-testid="data-sync-overview-table"
      className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-background/50"
    >
      <div className="min-h-0 overflow-y-auto p-2">
        <div className="sticky top-0 z-10 grid grid-cols-[32px_minmax(0,1fr)_64px_64px_minmax(120px,220px)] gap-4 border-b border-border bg-surface px-4 py-3 text-ui-base font-medium text-foreground-subtle">
          <span aria-hidden="true" />
          <span>{formatMessage({ id: "dataSync.overview.column.category" })}</span>
          <span className="text-center">
            {formatMessage({ id: "dataSync.overview.column.local" })}
          </span>
          <span className="text-center">
            {formatMessage({ id: "dataSync.overview.column.remote" })}
          </span>
          <span aria-hidden="true" />
        </div>
        <div className="mt-1 flex flex-col gap-1">
          <DataSyncProvidersOverviewRow
            state={props.providers}
            label={formatMessage({ id: "dataSync.category.providers" })}
            onNavigate={() => props.onNavigate("providers")}
          />
          {DATA_SYNC_CATEGORIES.map((category) => {
            const view = props.views[category.id];
            if (!view) return null;
            const selectableKeys = view.rows.filter((row) => row.selectable).map((row) => row.key);
            const label = formatMessage({ id: `dataSync.category.${category.id}` });
            return (
              <div
                key={category.id}
                className="grid grid-cols-[32px_minmax(0,1fr)] items-center gap-4 rounded-lg bg-background px-4 transition-colors hover:bg-surface-hover/50"
              >
                {/* 勾选框与整行跳转分开：点勾选框不进入分类页。 */}
                <Checkbox
                  data-testid={`data-sync-overview-checkbox-${category.id}`}
                  aria-label={label}
                  checked={
                    selectableKeys.length > 0 &&
                    selectableKeys.every((key) => view.selected.has(key))
                  }
                  disabled={props.disabled || view.phase !== "ready" || selectableKeys.length === 0}
                  onCheckedChange={(checked) =>
                    props.onSelectionChange(category.id, checked === true ? selectableKeys : [])
                  }
                />
                <button
                  type="button"
                  data-testid={`data-sync-overview-${category.id}`}
                  onClick={() => props.onNavigate(category.id)}
                  className="grid w-full grid-cols-[minmax(0,1fr)_64px_64px_minmax(120px,220px)] items-center gap-4 py-3 text-left text-ui-base"
                >
                  <span className="truncate font-medium text-foreground">{label}</span>
                  <span
                    data-testid={`data-sync-overview-local-${category.id}`}
                    className="text-center tabular-nums text-foreground-subtle"
                  >
                    {view.phase === "ready" ? view.localCount : "–"}
                  </span>
                  <span
                    data-testid={`data-sync-overview-remote-${category.id}`}
                    className="text-center tabular-nums text-foreground-subtle"
                  >
                    {view.phase === "ready" ? view.remoteCount : "–"}
                  </span>
                  <span className="flex min-w-0 items-center justify-end gap-2 text-foreground-subtle">
                    <span className="truncate text-right" data-phase={view.phase}>
                      {view.phase === "loading"
                        ? formatMessage({ id: "dataSync.overview.loading" })
                        : view.phase === "error"
                          ? formatMessage({ id: "dataSync.overview.loadFailed" })
                          : view.phase === "unsupported"
                            ? formatMessage({ id: "dataSync.category.unsupported" })
                            : selectableKeys.length === 0 && view.localCount === view.remoteCount
                              ? formatMessage({ id: "dataSync.difference.matching" })
                              : formatMessage(
                                  { id: "dataSync.difference.changes" },
                                  { count: selectableKeys.length },
                                )}
                    </span>
                    <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
