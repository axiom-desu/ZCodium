import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { IServiceAccessor } from "@zcode/services";
import { remoteHostIdFromWorkspaceIdentity } from "@zcode/shared";
import {
  useBaseWorkspaceServices,
  useWorkspaceServicesResolution,
} from "@/hooks/useWorkspaceServices.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import {
  ensureSourceSettingsServices,
  useSourceSettingsServices,
} from "@/store/sourceSettingsServiceStore.js";
import {
  isExactConfigLogicalSession,
  type ConfigDirectoryTarget,
} from "@/lib/configDirectoryCatalog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

type ConfigServicesResolution = ReturnType<typeof useWorkspaceServicesResolution> & {
  configAuthorityKey?: string;
};
const ConfigServicesContext = createContext<{
  resolution: ConfigServicesResolution;
  target: ConfigDirectoryTarget;
} | null>(null);
const epochs = new WeakMap<IServiceAccessor, number>();
let nextEpoch = 0;
/** 服务换代也属于配置请求上下文；同 identity 的旧代理不能回写新代理投影。 */
export function configServiceAuthority(services: IServiceAccessor): string {
  let epoch = epochs.get(services);
  if (!epoch) {
    epoch = ++nextEpoch;
    epochs.set(services, epoch);
  }
  return `settings:${epoch}`;
}

/** 仅 Settings 消费此 DI 端口；conversation 的 workspace service hook 保持原合同。 */
export function useConfigDirectoryServicesResolution(
  ...args: Parameters<typeof useWorkspaceServicesResolution>
): ConfigServicesResolution {
  const workspace = useWorkspaceServicesResolution(...args);
  const scoped = useContext(ConfigServicesContext);
  const identity = args[2]?.trim();
  // 远端 hostId 与 catalog 同源：canonical remote host identity，不手写 server: 前缀。
  const requestedHost = (identity ? remoteHostIdFromWorkspaceIdentity(identity) : null) ?? "local";
  // 表单换 Source 的首帧，父层尚未收到 scope 回报时也不能把 B 的路径写给 A。
  return scoped?.target.hostId === requestedHost ? scoped.resolution : workspace;
}
export function ConfigDirectoryServicesBoundary({
  target,
  admitSourceSettings = false,
  onUnavailable,
  children,
}: {
  target: ConfigDirectoryTarget | null;
  admitSourceSettings?: boolean;
  onUnavailable?: () => void;
  children: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const logical = useWorkspaceServicesResolution(
    target?.workspacePath,
    target?.remoteSessionId,
    target?.workspaceIdentity,
    target?.remoteTarget,
  );
  const baseServices = useBaseWorkspaceServices();
  const settingsServices = useSourceSettingsServices(target?.sourceServerId);
  const [failedTarget, setFailedTarget] = useState<ConfigDirectoryTarget | null>(null);
  // logical session 是 workspace scope：只有 target 自己的 remoteSessionId 精确命中才可用，
  // 否则走 Source settings attachment，绝不借用同 Source 其他目录或回落本机 base services。
  const exactLogicalSession = isExactConfigLogicalSession(target, logical.remoteSessionId);
  const services =
    target?.hostId === "local"
      ? baseServices
      : exactLogicalSession
        ? logical.services
        : settingsServices;
  useEffect(() => {
    if (
      !admitSourceSettings ||
      !target?.configOnline ||
      !target.sourceServerId ||
      exactLogicalSession ||
      settingsServices
    )
      return;
    const request = platform?.requestSourceSettingsAttachment;
    if (!request) return;
    let disposed = false;
    void ensureSourceSettingsServices(target.sourceServerId, target.sourceConnection, (id) =>
      request.call(platform, id),
    )
      .then(() => {
        if (!disposed) setFailedTarget(target);
      })
      .catch(() => {
        if (!disposed) setFailedTarget(target);
      });
    return () => {
      disposed = true;
    };
  }, [admitSourceSettings, exactLogicalSession, platform, settingsServices, target]);
  const configAuthorityKey = services
    ? `${configServiceAuthority(services)}:${target?.sourceGeneration ?? 0}`
    : "";
  const resolution = useMemo(
    () => ({
      ...logical,
      services: services ?? logical.services,
      rpcReady: Boolean(services),
      configAuthorityKey,
    }),
    [configAuthorityKey, logical, services],
  );
  const ready = Boolean(target?.configOnline && services);
  useEffect(() => {
    if (!ready) onUnavailable?.();
  }, [onUnavailable, ready]);
  if (!target?.configOnline || !services) {
    const reason = target?.disabledReason;
    const messageId =
      reason === "legacy"
        ? "settings.plugin.configDirectory.legacy"
        : reason === "offline"
          ? "settings.plugin.configDirectory.offline"
          : target?.configOnline &&
              admitSourceSettings &&
              platform?.requestSourceSettingsAttachment &&
              failedTarget !== target
            ? "common.connecting"
            : "settings.plugin.configDirectory.unavailable";
    return (
      <div
        data-testid="plugin-settings-directory-readonly"
        className="rounded-xl border border-dashed border-border px-4 py-8 text-ui-base text-foreground-subtle"
      >
        {intl.formatMessage({ id: messageId })}
      </div>
    );
  }
  return (
    <ConfigServicesContext.Provider key={configAuthorityKey} value={{ resolution, target }}>
      {children}
    </ConfigServicesContext.Provider>
  );
}
