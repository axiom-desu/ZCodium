import { Check, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import type { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { DataSyncCategoryAdapter } from "../app/categories.js";
import type { DataSyncCategoryView } from "../app/types.js";
import type { DataSyncCategoryId } from "../contract.js";

type FormatMessage = ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"];

export function DialogFooterBar(props: {
  providersTab: boolean;
  activeCategory: DataSyncCategoryAdapter | undefined;
  activeView: DataSyncCategoryView | undefined;
  offline: boolean;
  pushing: boolean;
  pushAllState: "idle" | "pushing" | "done";
  hasOverviewSelection: boolean;
  formatMessage: FormatMessage;
  onClose(): void;
  onClear(id: DataSyncCategoryId): void;
  onPushCategory(id: DataSyncCategoryId): void;
  onPushAll(): void;
}) {
  const { activeCategory, activeView, formatMessage } = props;
  if (props.providersTab) {
    // 模型提供商只读：没有推送按钮，也不参与「推送全部」。
    return (
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
        {!props.pushing ? (
          <Button
            type="button"
            data-testid="data-sync-close"
            variant="secondary"
            size="lg"
            onClick={props.onClose}
          >
            {formatMessage({ id: "dataSync.action.close" })}
          </Button>
        ) : null}
      </div>
    );
  }
  if (activeCategory && activeView) {
    const selectedCount = activeView.selected.size;
    const categoryPushing = activeView.push === "pushing";
    const pushDisabled =
      props.offline || props.pushing || selectedCount === 0 || activeView.phase === "unsupported";
    return (
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3 text-ui-base text-foreground-subtle">
          <span data-testid="data-sync-selection-summary">
            {selectedCount === 0
              ? formatMessage({ id: "dataSync.selection.empty" })
              : formatMessage({ id: "dataSync.selection.summary" }, { count: selectedCount })}
          </span>
          {activeView.failedCount > 0 && !categoryPushing ? (
            <span data-testid="data-sync-failure-summary" className="text-destructive">
              {formatMessage(
                { id: "dataSync.selection.failed" },
                { count: activeView.failedCount },
              )}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            data-testid="data-sync-clear"
            variant="secondary"
            size="lg"
            disabled={selectedCount === 0 || props.offline || props.pushing}
            onClick={() => props.onClear(activeCategory.id)}
          >
            {formatMessage({ id: "dataSync.action.clear" })}
          </Button>
          <Button
            type="button"
            data-testid="data-sync-push"
            size="lg"
            disabled={pushDisabled}
            onClick={() => props.onPushCategory(activeCategory.id)}
          >
            {/* 当前分类失败后，其他分类可能仍在推送；文案与禁用条件必须使用同一整批状态。 */}
            {props.pushing ? (
              <>
                <RefreshCw className="size-3.5 animate-spin" aria-hidden="true" />
                {formatMessage({ id: "dataSync.action.transferring" })}
              </>
            ) : activeView.push !== "idle" ? (
              <>
                <Check className="size-3.5" aria-hidden="true" />
                {formatMessage({ id: "dataSync.action.transferAgain" })}
              </>
            ) : (
              formatMessage(
                { id: "dataSync.action.pushCategory" },
                { category: formatMessage({ id: `dataSync.category.${activeCategory.id}` }) },
              )
            )}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
      {!props.pushing ? (
        <Button
          type="button"
          data-testid="data-sync-close"
          variant="secondary"
          size="lg"
          onClick={props.onClose}
        >
          {formatMessage({ id: "dataSync.action.close" })}
        </Button>
      ) : null}
      <Button
        type="button"
        data-testid="data-sync-push-all"
        size="lg"
        disabled={props.offline || props.pushing || !props.hasOverviewSelection}
        onClick={props.onPushAll}
      >
        {props.pushing ? (
          <>
            <RefreshCw className="size-3.5 animate-spin" aria-hidden="true" />
            {formatMessage({
              id:
                props.pushAllState === "pushing"
                  ? "dataSync.action.transferringAll"
                  : "dataSync.action.transferring",
            })}
          </>
        ) : props.pushAllState === "done" ? (
          <>
            <Check className="size-3.5" aria-hidden="true" />
            {formatMessage({ id: "dataSync.action.transferredAll" })}
          </>
        ) : (
          <>
            <RefreshCw className="size-3.5" aria-hidden="true" />
            {formatMessage({ id: "dataSync.action.pushAll" })}
          </>
        )}
      </Button>
    </div>
  );
}
