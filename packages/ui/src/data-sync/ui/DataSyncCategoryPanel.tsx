import { ArrowRight, Check, CircleStop, Info } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { DataSyncBlockedReason, DataSyncModelOverrideSummary } from "@zcode/shared";
import {
  findMissingDataSyncDependencies,
  type DataSyncMissingDependencies,
  type DataSyncRow,
  type DataSyncRowStatus,
} from "../domain/compareRows.js";
import { resolveDataSyncCheckState } from "../domain/compareBatches.js";
import {
  DATA_SYNC_STOPPED_ERROR,
  DATA_SYNC_OFFLINE_ERROR,
  DATA_SYNC_PREFLIGHT_TIMEOUT_ERROR,
} from "../app/dataSyncErrors.js";
import type { DataSyncCategoryView, DataSyncItemError } from "../app/types.js";

type FormatMessage = ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"];

const BLOCKED_REASON_MESSAGE_ID: Record<DataSyncBlockedReason, string> = {
  "size-limit": "dataSync.blocked.sizeLimit",
  "contains-symlink": "dataSync.blocked.containsSymlink",
  "target-symlink": "dataSync.blocked.targetSymlink",
  "compat-directory": "dataSync.blocked.compatDirectory",
  "external-directory": "dataSync.blocked.externalDirectory",
  "target-compat-config": "dataSync.blocked.targetCompatConfig",
  "source-removed": "dataSync.blocked.sourceRemoved",
  "remote-latest-mismatch": "dataSync.blocked.remoteLatestMismatch",
  "cross-marketplace-dependency": "dataSync.blocked.crossMarketplaceDependency",
  "unsupported-source": "dataSync.blocked.unsupportedSource",
};

// 标签颜色遵循 DESIGN.md 的 *-surface 语义对；「更新」用 progress surface，四套主题下都保证对比度。
const BADGE_CLASS: Record<Exclude<DataSyncRowStatus, "blocked">, string> = {
  push: "bg-success-surface text-success-surface-foreground",
  update: "bg-progress-surface text-progress-surface-foreground",
  difference: "bg-warning-surface text-warning-surface-foreground",
  synced: "bg-surface text-foreground-subtle",
};

function formatPushError(formatMessage: FormatMessage, error: string): string {
  if (error === DATA_SYNC_OFFLINE_ERROR) {
    return formatMessage({ id: "dataSync.error.offline" });
  }
  if (error === DATA_SYNC_PREFLIGHT_TIMEOUT_ERROR) {
    return formatMessage({ id: "dataSync.error.preflightTimeout" });
  }
  return formatMessage({ id: "dataSync.error.pushFailed" }, { error });
}

function formatItemError(formatMessage: FormatMessage, error: DataSyncItemError): string {
  if (error.message === DATA_SYNC_STOPPED_ERROR) {
    return formatMessage({ id: "dataSync.item.stopped" });
  }
  return error.status === "conflict"
    ? formatMessage({ id: "dataSync.item.conflict" })
    : formatMessage(
        { id: "dataSync.item.failed" },
        { error: error.message ?? formatMessage({ id: "dataSync.item.unknownError" }) },
      );
}

/** 内置智能体模型覆盖行：说明行用 builtInModel，「差异」行的目标端模型用 targetModel。 */
function formatModelOverride(
  formatMessage: FormatMessage,
  id: "dataSync.subagents.builtInModel" | "dataSync.subagents.targetModel",
  summary: DataSyncModelOverrideSummary,
): string {
  return summary.reasoningLevel
    ? formatMessage(
        { id: `${id}WithReasoning` },
        { model: summary.modelId, level: summary.reasoningLevel },
      )
    : formatMessage({ id }, { model: summary.modelId });
}

/** 多个缺失项合并为一行：同类名称之间、MCP 与技能两组之间各用本地化分隔符。 */
function formatMissingDependencies(
  formatMessage: FormatMessage,
  missing: DataSyncMissingDependencies,
): string {
  const nameSeparator = formatMessage({ id: "dataSync.dependency.nameSeparator" });
  const groups: string[] = [];
  if (missing.mcpServers.length > 0) {
    groups.push(
      formatMessage(
        { id: "dataSync.dependency.missingMcp" },
        { names: missing.mcpServers.join(nameSeparator) },
      ),
    );
  }
  if (missing.skills.length > 0) {
    groups.push(
      formatMessage(
        { id: "dataSync.dependency.missingSkills" },
        { names: missing.skills.join(nameSeparator) },
      ),
    );
  }
  return groups.join(formatMessage({ id: "dataSync.dependency.groupSeparator" }));
}

function SelectionBox(props: { checked: boolean; disabled?: boolean }) {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center">
      <span
        className={cn(
          "flex size-4 items-center justify-center rounded-sm border",
          props.checked
            ? "border-primary bg-primary text-primary-foreground"
            : props.disabled
              ? "border-border/50 bg-surface text-transparent"
              : "border-border bg-background text-transparent",
        )}
      >
        <Check className="size-3.5" aria-hidden="true" />
      </span>
    </span>
  );
}

function RowNote(props: { row: DataSyncRow; formatMessage: FormatMessage }) {
  const { note } = props.row;
  if (note.kind === "version") {
    return (
      <span className="flex items-center gap-1 font-mono text-ui-xs text-foreground">
        <span>{note.from}</span>
        <ArrowRight className="size-3 text-foreground-subtle" aria-hidden="true" />
        <span>{note.to}</span>
      </span>
    );
  }
  if (note.kind === "sourceOlder" || note.kind === "contentDiffers") {
    return (
      <span className="text-ui-xs text-foreground">
        {props.formatMessage({
          id:
            note.kind === "sourceOlder"
              ? "dataSync.version.pushSourceOlder"
              : "dataSync.version.contentDiffers",
        })}
      </span>
    );
  }
  return null;
}

export function DataSyncCategoryPanel(props: {
  view: DataSyncCategoryView;
  dependencyTargets: Parameters<typeof findMissingDataSyncDependencies>[1];
  disabled: boolean;
  formatMessage: FormatMessage;
  onSelectionChange(keys: Iterable<string>): void;
  onStop(key: string): void;
}) {
  const { view, formatMessage } = props;
  const selectableKeys = view.rows.filter((row) => row.selectable).map((row) => row.key);
  const allSelected = resolveDataSyncCheckState(view.rows, view.selected) === true;
  const unsupported = view.phase === "unsupported";
  return (
    <div
      data-testid="data-sync-resource-panel"
      data-phase={view.phase}
      className="flex h-full min-h-0 flex-col gap-3 overflow-hidden"
    >
      {view.pushError ? (
        <div
          data-testid="data-sync-push-error"
          className="flex shrink-0 items-start gap-2 rounded-xl bg-destructive-surface px-3 py-2 text-ui-sm text-destructive-surface-foreground"
        >
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {formatPushError(formatMessage, view.pushError)}
        </div>
      ) : null}
      {unsupported ? (
        <div
          data-testid="data-sync-unsupported"
          data-unsupported-reason={view.unsupportedReason ?? ""}
          className="flex shrink-0 items-start gap-2 rounded-xl border border-border px-3 py-2 text-ui-sm text-foreground-subtle"
        >
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {formatMessage({ id: "dataSync.category.unsupported" })}
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background/50">
        <div className="flex shrink-0 items-center gap-3 border-b border-border bg-surface/50 px-5 py-3">
          <button
            data-testid="data-sync-select-all"
            type="button"
            role="checkbox"
            aria-checked={allSelected}
            disabled={props.disabled || unsupported || selectableKeys.length === 0}
            onClick={() => props.onSelectionChange(allSelected ? [] : selectableKeys)}
            className="flex items-center gap-3 text-ui-base text-foreground-subtle hover:text-foreground disabled:opacity-60"
          >
            <SelectionBox checked={allSelected} />
            {formatMessage({ id: "dataSync.selection.selectAll" })}
          </button>
        </div>
        <div
          data-testid="data-sync-resource-list"
          className="flex min-h-0 flex-col gap-1 overflow-y-auto p-2"
        >
          {view.phase === "loading" ? (
            <p className="px-3 py-6 text-center text-ui-sm text-foreground-subtle">
              {formatMessage({ id: "dataSync.overview.loading" })}
            </p>
          ) : view.phase === "error" ? (
            <p className="px-3 py-6 text-center text-ui-sm text-destructive">
              {formatMessage({ id: "dataSync.category.loadFailed" }, { error: view.error ?? "" })}
            </p>
          ) : view.phase === "unsupported" ? null : view.rows.length === 0 ? (
            <p className="px-3 py-6 text-center text-ui-sm text-foreground-subtle">
              {formatMessage({ id: "dataSync.category.empty" })}
            </p>
          ) : (
            view.rows.map((row) => {
              const checked = view.selected.has(row.key);
              const rowDisabled = props.disabled || !row.selectable;
              const itemError = view.itemErrors[row.key];
              const missingDependencies = findMissingDataSyncDependencies(
                row.dependencies,
                props.dependencyTargets,
              );
              const stoppable = view.push === "pushing" && view.stoppable.has(row.key);
              const rowButton = (
                <button
                  key={row.key}
                  type="button"
                  role="checkbox"
                  data-testid={`data-sync-row-${row.key}`}
                  data-sync-key={row.key}
                  data-sync-status={row.status}
                  aria-label={row.name}
                  aria-checked={checked}
                  disabled={rowDisabled}
                  onClick={() => {
                    const next = new Set(view.selected);
                    if (checked) next.delete(row.key);
                    else next.add(row.key);
                    props.onSelectionChange(next);
                  }}
                  className="flex w-full cursor-pointer gap-3 rounded-lg bg-background p-3 text-left transition-colors hover:bg-surface-hover/50 disabled:cursor-default disabled:hover:bg-background"
                >
                  <SelectionBox checked={checked} disabled={!row.selectable} />
                  <span className={cn("min-w-0 flex-1", !row.selectable && "opacity-60")}>
                    <span className="block truncate text-ui-base font-medium text-foreground">
                      {row.name}
                    </span>
                    {/* 说明行不截断：钩子在这里显示完整命令，长路径需要折行。 */}
                    <span className="mt-0.5 block break-words text-ui-sm text-foreground-subtle">
                      {row.note.kind === "blocked"
                        ? formatMessage({ id: BLOCKED_REASON_MESSAGE_ID[row.note.reason] })
                        : row.builtInModelOverride
                          ? formatModelOverride(
                              formatMessage,
                              "dataSync.subagents.builtInModel",
                              row.builtInModelOverride.source,
                            )
                          : (row.description ?? "")}
                    </span>
                    {row.builtInModelOverride?.target ? (
                      <span
                        data-testid={`data-sync-row-target-model-${row.key}`}
                        className="mt-0.5 block break-words text-ui-sm text-foreground-subtle"
                      >
                        {formatModelOverride(
                          formatMessage,
                          "dataSync.subagents.targetModel",
                          row.builtInModelOverride.target,
                        )}
                      </span>
                    ) : null}
                    {missingDependencies ? (
                      <span
                        data-testid={`data-sync-row-hint-${row.key}`}
                        className="mt-0.5 block text-ui-sm text-warning-surface-foreground"
                      >
                        {formatMissingDependencies(formatMessage, missingDependencies)}
                      </span>
                    ) : null}
                    {itemError ? (
                      <span
                        data-testid={`data-sync-row-error-${row.key}`}
                        className="mt-0.5 block text-ui-sm text-destructive"
                      >
                        {formatItemError(formatMessage, itemError)}
                      </span>
                    ) : null}
                  </span>
                  <span
                    data-testid={`data-sync-difference-${row.key}`}
                    className="mt-0.5 flex shrink-0 items-center gap-2 self-start"
                  >
                    <RowNote row={row} formatMessage={formatMessage} />
                    {row.status !== "blocked" ? (
                      <span
                        className={cn(
                          "shrink-0 rounded-full px-2 py-0.5 text-ui-xs",
                          BADGE_CLASS[row.status],
                        )}
                      >
                        {formatMessage({ id: `dataSync.operation.${row.status}` })}
                      </span>
                    ) : null}
                  </span>
                </button>
              );
              if (!stoppable) return rowButton;
              // 目标端 add / install 期间该行可单独「停止」；按钮放在行外，避免嵌套在行按钮里。
              return (
                <div key={row.key} className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">{rowButton}</div>
                  <Button
                    type="button"
                    data-testid={`data-sync-row-stop-${row.key}`}
                    variant="secondary"
                    size="sm"
                    className="mr-2 shrink-0"
                    onClick={() => props.onStop(row.key)}
                  >
                    <CircleStop aria-hidden="true" />
                    {formatMessage({ id: "dataSync.action.stop" })}
                  </Button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
