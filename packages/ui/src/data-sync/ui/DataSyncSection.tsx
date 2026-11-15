import { useEffect, useMemo, useState } from "react";
import { Info, LoaderCircle, Plug, RotateCcw, Server, Upload } from "lucide-react";
import type { DeviceSyncState } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { cn } from "@/components/lib/utils.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useSourceServerManagementSnapshot } from "@/hooks/useSourceServerManagementSnapshot.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { useDataSyncDialogStore } from "../app/dataSyncDialogStore.js";
import { buildDataSyncDevices, type DataSyncDeviceRow } from "../domain/devices.js";

/** 设备行最终显示态，同时写在行的 data-device-state 上供 E2E 断言。 */
type DataSyncDeviceDisplayState = "synced" | "sync-failed" | "connecting" | "disconnected";

const CONNECTION_STATUS_CLASS: Record<DataSyncDeviceRow["connection"], string> = {
  online: "text-success-surface-foreground",
  connecting: "text-progress-surface-foreground",
  disconnected: "text-foreground-subtle",
};

function isSameDay(left: number, right: number): boolean {
  const a = new Date(left);
  const b = new Date(right);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * 设置 → 数据与统计 → 数据同步。设备来自本机 Source 管理快照；「上次同步」只读本机
 * `deviceSyncStateService`（唯一数据源）。推送动作只打开窗口内唯一弹窗，不在此处建连接或后端。
 */
export function DataSyncSection(props: { now?: () => number }) {
  const { intl, locale } = useZCodeIntl();
  const now = props.now ?? Date.now;
  const { snapshot } = useSourceServerManagementSnapshot();
  const devices = useMemo(() => buildDataSyncDevices(snapshot), [snapshot]);
  const base = useBaseWorkspaceServices();
  const deviceSyncStateService = base.deviceSyncStateService;
  const resultVersion = useDataSyncDialogStore((state) => state.resultVersion);
  const openDialog = useDataSyncDialogStore((state) => state.open);
  const [syncStates, setSyncStates] = useState<Record<string, DeviceSyncState>>({});

  // 设备行的「上次同步」只读设备同步状态；推送结束由 Host 落盘后递增版本触发重读。
  useEffect(() => {
    if (!deviceSyncStateService) return;
    let disposed = false;
    void deviceSyncStateService
      .getDeviceSyncStates()
      .then((states) => {
        if (!disposed) setSyncStates(states);
      })
      .catch((error: unknown) =>
        logger.warn("[DataSync] 读取设备同步状态失败", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return () => {
      disposed = true;
    };
  }, [deviceSyncStateService, resultVersion]);

  const formatSyncStatus = (state: DeviceSyncState | undefined): string => {
    if (!state) return intl.formatMessage({ id: "dataSync.device.neverSynced" });
    if (state.lastResult !== "success") {
      return intl.formatMessage({ id: "dataSync.device.status.failed" });
    }
    if (isSameDay(state.lastSyncAt, now())) {
      return intl.formatMessage(
        { id: "dataSync.device.lastSynced.today" },
        {
          time: new Date(state.lastSyncAt).toLocaleTimeString(locale, {
            hour: "2-digit",
            minute: "2-digit",
          }),
        },
      );
    }
    return intl.formatMessage(
      { id: "dataSync.device.lastSynced" },
      {
        time: new Date(state.lastSyncAt).toLocaleString(locale, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }),
      },
    );
  };

  return (
    <div className="space-y-6" data-testid="data-sync-section">
      <div className="space-y-2">
        <div className="flex items-center gap-1 text-foreground-subtle">
          <p className="text-ui-base" data-testid="data-sync-description">
            {intl.formatMessage({ id: "dataSync.description" })}
          </p>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-md"
                data-testid="data-sync-rules-trigger"
                aria-label={intl.formatMessage({ id: "dataSync.rules.title" })}
              >
                <Info className="size-3.5" aria-hidden="true" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="gap-2 p-3" data-testid="data-sync-rules">
              <div className="font-medium">
                {intl.formatMessage({ id: "dataSync.rules.title" })}
              </div>
              <p className="text-foreground-subtle">
                {intl.formatMessage({ id: "dataSync.rules.description" })}
              </p>
            </PopoverContent>
          </Popover>
        </div>
      </div>
      {devices.length === 0 ? (
        <div
          data-testid="data-sync-empty"
          className="rounded-xl border border-dashed border-border px-6 py-12 text-center"
        >
          <Server className="mx-auto size-8 text-foreground-subtlest" aria-hidden="true" />
          <div className="mt-3 text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "dataSync.empty.title" })}
          </div>
          <p className="mx-auto mt-1 max-w-md text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "dataSync.empty.description" })}
          </p>
        </div>
      ) : (
        <div data-testid="data-sync-device-list" className="overflow-hidden rounded-xl bg-surface">
          {devices.map((device, index) => {
            const state = syncStates[device.sourceServerId];
            // 「上次同步失败」只取自设备同步状态：partial 与 failed 都算失败，且只在在线时显示。
            const displayState: DataSyncDeviceDisplayState =
              device.connection !== "online"
                ? device.connection
                : state !== undefined && state.lastResult !== "success"
                  ? "sync-failed"
                  : "synced";
            const statusText =
              displayState === "connecting"
                ? intl.formatMessage({ id: "dataSync.device.status.connecting" })
                : displayState === "disconnected"
                  ? intl.formatMessage({ id: "dataSync.device.status.offline" })
                  : formatSyncStatus(state);
            const actionMessageId =
              displayState === "sync-failed"
                ? "dataSync.action.retry"
                : displayState === "connecting"
                  ? "dataSync.action.connecting"
                  : "dataSync.action.sync";
            const ActionIcon =
              displayState === "connecting"
                ? LoaderCircle
                : displayState === "sync-failed"
                  ? RotateCcw
                  : displayState === "disconnected"
                    ? Plug
                    : Upload;
            return (
              <div
                key={device.sourceServerId}
                data-testid={`data-sync-device-${device.sourceServerId}`}
                data-source-server-id={device.sourceServerId}
                data-device-state={displayState}
                className={cn(
                  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:gap-4",
                  index > 0 && "border-t border-border/50",
                )}
              >
                <div className="col-span-2 min-w-0 sm:col-span-1">
                  <div className="text-ui-base font-medium text-foreground">{device.name}</div>
                  <div className="mt-0.5 break-words text-ui-sm text-foreground-subtle">
                    {device.description}
                  </div>
                  {displayState === "disconnected" ? (
                    <div
                      data-testid="data-sync-device-connect-hint"
                      className="mt-0.5 break-words text-ui-sm text-foreground-subtle"
                    >
                      {intl.formatMessage({ id: "dataSync.device.connectHint" })}
                    </div>
                  ) : null}
                </div>
                <div className="min-w-0 sm:min-w-32">
                  {/* 连接状态与同步结果来自不同事实源；在线不代表配置已同步，失败也不代表设备离线。 */}
                  <div
                    data-testid="data-sync-device-connection"
                    className={cn(
                      "flex items-center gap-1.5 text-ui-sm",
                      CONNECTION_STATUS_CLASS[device.connection],
                    )}
                  >
                    <span
                      className="size-1.5 shrink-0 rounded-full bg-current"
                      aria-hidden="true"
                    />
                    {device.connection === "online" ? (
                      intl.formatMessage({ id: "dataSync.device.status.online" })
                    ) : (
                      <span data-testid="data-sync-device-status">{statusText}</span>
                    )}
                  </div>
                  {device.connection === "online" ? (
                    <div
                      data-testid="data-sync-device-status"
                      className={cn(
                        "mt-0.5 text-ui-sm",
                        displayState === "sync-failed"
                          ? "text-destructive"
                          : "text-foreground-subtle",
                      )}
                    >
                      {statusText}
                    </div>
                  ) : null}
                </div>
                <Button
                  type="button"
                  data-testid="data-sync-device-action"
                  variant={displayState === "synced" ? "default" : "outline"}
                  className="min-w-24 justify-self-end rounded-lg"
                  disabled={displayState === "connecting" || displayState === "disconnected"}
                  onClick={() =>
                    openDialog({
                      sourceServerId: device.sourceServerId,
                      workspaceHistory: snapshot?.workspaceHistory,
                    })
                  }
                >
                  <ActionIcon
                    className={cn("size-3.5", displayState === "connecting" && "animate-spin")}
                    aria-hidden="true"
                  />
                  {intl.formatMessage({ id: actionMessageId })}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
