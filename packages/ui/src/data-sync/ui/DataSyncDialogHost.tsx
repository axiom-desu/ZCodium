import { useEffect, useMemo, type ReactNode } from "react";
import type { DeviceSyncResult } from "@zcode/shared";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useSourceServerManagementSnapshot } from "@/hooks/useSourceServerManagementSnapshot.js";
import { logger } from "@/logger.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import {
  ensureSourceSettingsServices,
  useSourceSettingsServices,
} from "@/store/sourceSettingsServiceStore.js";
import { useDataSyncDialogStore } from "../app/dataSyncDialogStore.js";
import {
  buildDataSyncDevices,
  dataSyncConnectionKey,
  isDataSyncDeviceOnline,
} from "../domain/devices.js";
import { DataSyncDialog } from "./DataSyncDialog.js";

/**
 * 唯一弹窗挂载点（WindowRoot）：申请设备的 source-settings attachment、读取在线状态，
 * 推送结束把结果写进本机设备同步状态。最小化或离开设置页只隐藏内容，不卸载本组件与推送 owner。
 */
export function DataSyncDialogHost(): ReactNode {
  const request = useDataSyncDialogStore((state) => state.request);
  const minimized = useDataSyncDialogStore((state) => state.minimized);
  const setMinimized = useDataSyncDialogStore((state) => state.setMinimized);
  const close = useDataSyncDialogStore((state) => state.close);
  const recordResult = useDataSyncDialogStore((state) => state.recordResult);
  const base = useBaseWorkspaceServices();
  const platform = useOptionalPlatform();
  const { snapshot } = useSourceServerManagementSnapshot({ enabled: Boolean(request) });
  const tabs = useTabStore((state) => state.tabs);
  const workspaceTabs = useMemo(() => tabs.filter(isWorkspaceTab), [tabs]);
  const sourceServerId = request?.sourceServerId;
  const targetServices = useSourceSettingsServices(sourceServerId);
  const online = isDataSyncDeviceOnline(snapshot, sourceServerId);
  const requestSourceSettingsAttachment = platform?.requestSourceSettingsAttachment;
  const device = useMemo(() => {
    if (!sourceServerId) return undefined;
    return (
      buildDataSyncDevices(snapshot).find((row) => row.sourceServerId === sourceServerId) ?? {
        sourceServerId,
        name: sourceServerId,
        description: "",
      }
    );
  }, [snapshot, sourceServerId]);

  useEffect(() => {
    if (!online || targetServices || !requestSourceSettingsAttachment || !sourceServerId) return;
    const connectionKey = dataSyncConnectionKey(snapshot, sourceServerId);
    void ensureSourceSettingsServices(sourceServerId, connectionKey, (id) =>
      requestSourceSettingsAttachment(id),
    ).catch((error: unknown) =>
      logger.warn("[DataSync] 申请设备配置连接失败", {
        sourceServerId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }, [online, requestSourceSettingsAttachment, snapshot, sourceServerId, targetServices]);

  if (!request || !device) return null;
  const onPushFinished = async (result: DeviceSyncResult): Promise<void> => {
    const service = base.deviceSyncStateService;
    if (service) {
      try {
        await service.recordDeviceSyncResult({ sourceServerId: request.sourceServerId, result });
      } catch (error) {
        logger.warn("[DataSync] 写入设备同步状态失败", {
          sourceServerId: request.sourceServerId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // 设备结果落盘后递增版本：设置页/设备行据此重新读取，仍从 deviceSyncStateService 取结果。
    recordResult();
  };

  return (
    <DataSyncDialog
      open
      minimized={minimized}
      onMinimizedChange={setMinimized}
      device={device}
      online={online}
      sourceServices={base}
      targetServices={targetServices}
      workspaceHistory={request.workspaceHistory}
      workspaceTabs={workspaceTabs}
      initialCategory={request.category}
      workspace={request.workspace}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      onPushFinished={onPushFinished}
    />
  );
}
