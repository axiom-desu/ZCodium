import { useMemo, useState } from "react";
import { CloudOff, Package, RefreshCw } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  DATA_SYNC_CATEGORIES,
  DATA_SYNC_OVERVIEW_ICON,
  findDataSyncCategory,
} from "../app/categories.js";
import type { DataSyncCategoryView } from "../app/types.js";
import { useDataSyncDialog } from "../app/useDataSyncDialog.js";
import { useDataSyncProviders } from "../app/useDataSyncProviders.js";
import type { DataSyncCategoryId, DataSyncDialogProps } from "../contract.js";
import { DataSyncCategoryPanel } from "./DataSyncCategoryPanel.js";
import { DialogFooterBar } from "./DataSyncDialogFooter.js";
import { DataSyncOverviewPanel } from "./DataSyncOverviewPanel.js";
import { DataSyncMinimizeButton, DataSyncMinimizedProgress } from "./DataSyncMinimizedProgress.js";
import { DataSyncProvidersPanel } from "./DataSyncProvidersPanel.js";

type ActiveTab = "overview" | "providers" | DataSyncCategoryId;

/** 依赖提示的两端列表：只用已就绪分类的最近一次加载结果，推送后刷新完成即随之更新。 */
function readyDependencyKeys(view: DataSyncCategoryView | undefined) {
  return view?.phase === "ready" ? { source: view.sourceKeys, target: view.targetKeys } : undefined;
}

export function DataSyncDialog(props: DataSyncDialogProps) {
  const { intl } = useZCodeIntl();
  const [activeTab, setActiveTab] = useState<ActiveTab>(props.initialCategory ?? "overview");
  const state = useDataSyncDialog({
    categories: DATA_SYNC_CATEGORIES,
    sourceServerId: props.device.sourceServerId,
    sourceServices: props.sourceServices,
    targetServices: props.targetServices,
    online: props.online,
    workspaceHistory: props.workspaceHistory,
    workspaceTabs: props.workspaceTabs,
    workspace: props.workspace,
    onPushFinished: props.onPushFinished,
  });
  const providers = useDataSyncProviders({
    sourceServices: props.sourceServices,
    sourceServerId: props.device.sourceServerId,
    online: props.online,
  });
  const activeCategory = findDataSyncCategory(activeTab);
  const activeView = activeCategory ? state.views[activeCategory.id] : undefined;
  const offline = !props.online;
  const disabled = !state.connected || state.pushing || offline;
  // 分类已结束不代表整批结束；进度始终取推送 owner 的状态。
  const syncingCategory = Object.values(state.views).find((view) => view.push === "pushing")?.id;
  const minimized = props.minimized ?? false;
  const failed = Object.values(state.views).some(
    (view) => view.push === "failed" || view.failedCount > 0,
  );
  const finished = Object.values(state.views).some(
    (view) => view.push === "done" || view.push === "failed",
  );
  const changeMinimized = (next: boolean) => {
    logger.info("[DataSync] 切换最小化状态", {
      sourceServerId: props.device.sourceServerId,
      minimized: next,
      pushing: state.pushing,
    });
    props.onMinimizedChange?.(next);
  };
  // 推送中禁止关闭弹窗；没有全局取消，结果完整返回后才能关闭。
  const blockClose = (event: Event) => {
    if (state.pushing) event.preventDefault();
  };
  const tabs = useMemo(
    () => [
      { id: "overview" as const, icon: DATA_SYNC_OVERVIEW_ICON },
      { id: "providers" as const, icon: Package },
      ...DATA_SYNC_CATEGORIES,
    ],
    [],
  );

  return (
    <>
      {props.open && minimized ? (
        <DataSyncMinimizedProgress
          deviceName={props.device.name}
          pushing={state.pushing}
          failed={offline || failed}
          finished={finished}
          onRestore={() => changeMinimized(false)}
        />
      ) : null}
      <Dialog
        open={props.open && !minimized}
        onOpenChange={(open) => {
          if (!open && state.pushing) return;
          props.onOpenChange(open);
        }}
      >
        <DialogContent
          data-testid="data-sync-dialog"
          className="h-[calc(100vh-6rem)] max-h-[42rem] max-w-4xl overflow-hidden rounded-2xl p-0 max-md:h-[calc(100dvh-2rem)] max-md:max-h-[calc(100dvh-2rem)]"
          showCloseButton={!state.pushing}
          onEscapeKeyDown={blockClose}
          onInteractOutside={blockClose}
        >
          {props.onMinimizedChange ? (
            <DataSyncMinimizeButton
              pushing={state.pushing}
              onMinimize={() => changeMinimized(true)}
            />
          ) : null}
          <DialogHeader className="sr-only">
            <DialogTitle>{intl.formatMessage({ id: "dataSync.dialog.title" })}</DialogTitle>
            <DialogDescription>
              {intl.formatMessage({ id: "dataSync.overview.description" })}
            </DialogDescription>
          </DialogHeader>
          <div className="flex h-full min-h-0 min-w-0 flex-col md:flex-row">
            <aside className="flex shrink-0 flex-col gap-2 p-1 md:w-56">
              <div
                data-testid="data-sync-sidebar-frame"
                className="flex flex-col gap-3 border-border bg-surface p-3 max-md:border-b max-md:pr-20 md:h-full md:gap-4 md:rounded-xl md:border md:p-4"
              >
                <div className="hidden text-ui-base font-medium uppercase tracking-wide text-foreground-subtle md:block">
                  {intl.formatMessage({ id: "dataSync.dialog.categories" })}
                </div>
                {/* 窄窗口下分类变为顶部横向滚动标签。 */}
                <nav
                  className="flex gap-2 overflow-x-auto md:flex-col"
                  aria-label={intl.formatMessage({ id: "dataSync.dialog.categories" })}
                >
                  {tabs.map((item) => {
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        data-testid={`data-sync-tab-${item.id}`}
                        aria-current={activeTab === item.id ? "page" : undefined}
                        onClick={() => setActiveTab(item.id)}
                        className={cn(
                          "flex shrink-0 items-center gap-3 rounded-xl px-3 py-3 text-ui-base font-medium transition-colors md:w-full",
                          activeTab === item.id
                            ? "bg-card text-foreground"
                            : "text-foreground-subtle hover:bg-background-alt hover:text-foreground",
                        )}
                      >
                        <Icon className="size-4 shrink-0" aria-hidden="true" />
                        {intl.formatMessage({ id: `dataSync.category.${item.id}` })}
                      </button>
                    );
                  })}
                </nav>
              </div>
            </aside>
            <section
              data-testid="data-sync-dialog-main"
              className="flex min-h-0 min-w-0 flex-1 flex-col gap-5 overflow-hidden p-4 md:p-6"
            >
              <div className="shrink-0 pr-8">
                <h3 className="text-ui-lg font-medium text-foreground">
                  {intl.formatMessage({ id: `dataSync.category.${activeTab}` })}
                </h3>
                <div
                  data-testid="data-sync-dialog-device"
                  className="mt-2 flex min-w-0 items-center gap-2 text-ui-base text-foreground-subtle"
                >
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      offline ? "border border-foreground-subtlest" : "bg-success",
                    )}
                    aria-hidden="true"
                  />
                  <span className="truncate">{props.device.name}</span>
                  <span className="text-foreground-subtlest">·</span>
                  <span className="truncate">{props.device.description}</span>
                </div>
              </div>
              {offline ? (
                <div
                  data-testid="data-sync-offline"
                  className="flex shrink-0 items-start gap-2 rounded-xl border border-border px-3 py-2 text-ui-sm text-foreground-subtle"
                >
                  <CloudOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  {intl.formatMessage({ id: "dataSync.dialog.offline" })}
                </div>
              ) : null}
              {state.pushing ? (
                <div
                  role="status"
                  data-testid="data-sync-progress"
                  className="flex shrink-0 items-center gap-2 rounded-xl bg-progress-surface px-3 py-2 text-ui-sm text-progress-surface-foreground"
                >
                  <RefreshCw className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
                  {syncingCategory
                    ? intl.formatMessage(
                        { id: "dataSync.progress.category" },
                        {
                          category: intl.formatMessage({
                            id: `dataSync.category.${syncingCategory}`,
                          }),
                        },
                      )
                    : intl.formatMessage({ id: "dataSync.action.transferring" })}
                </div>
              ) : null}
              <div className="min-h-0 flex-1 overflow-hidden">
                {activeTab === "providers" ? (
                  <DataSyncProvidersPanel state={providers} disabled={offline} />
                ) : activeCategory && activeView ? (
                  <DataSyncCategoryPanel
                    key={activeCategory.id}
                    view={activeView}
                    dependencyTargets={{
                      mcp: readyDependencyKeys(state.views.mcp),
                      skills: readyDependencyKeys(state.views.skills),
                    }}
                    disabled={disabled}
                    formatMessage={intl.formatMessage}
                    onSelectionChange={(keys) => state.setSelection(activeCategory.id, keys)}
                    onStop={(key) => state.stopItem(activeCategory.id, key)}
                  />
                ) : (
                  <DataSyncOverviewPanel
                    providers={providers}
                    views={state.views}
                    disabled={disabled}
                    formatMessage={intl.formatMessage}
                    onNavigate={setActiveTab}
                    onSelectionChange={state.setSelection}
                  />
                )}
              </div>
              <DialogFooterBar
                providersTab={activeTab === "providers"}
                activeCategory={activeCategory}
                activeView={activeView}
                offline={!state.connected}
                pushing={state.pushing}
                pushAllState={state.pushAllState}
                hasOverviewSelection={Object.values(state.views).some(
                  (view) => view.selected.size > 0,
                )}
                formatMessage={intl.formatMessage}
                onClose={() => props.onOpenChange(false)}
                onClear={(id) => state.setSelection(id, [])}
                onPushCategory={state.pushCategory}
                onPushAll={state.pushAll}
              />
            </section>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
