import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ExtensionGrant } from "@zcode/shared/extension-host";
import {
  ExtensionStatusSlotView,
  type ExtensionStatusSlotLabels,
} from "./ExtensionStatusSlotView.js";
import { useExtensionSlots } from "@/extensions/adapters/useExtensionSlots.js";

/**
 * 生产槽位：订阅 `services/extensions` 的投影并渲染状态区贡献。
 * 手机/Web/旧 Host 上没有扩展服务，useExtensionSlots 返回 available=false，组件不渲染。
 */
export function ExtensionStatusSlot({ className }: { className?: string }) {
  const view = useExtensionSlots("status.composer");
  const { intl } = useZCodeIntl();
  const labels: ExtensionStatusSlotLabels = {
    label: intl.formatMessage({ id: "extensions.status.label" }),
    start: intl.formatMessage({ id: "extensions.status.start" }),
    stop: intl.formatMessage({ id: "extensions.status.stop" }),
    enable: intl.formatMessage({ id: "extensions.status.enable" }),
    revoke: intl.formatMessage({ id: "extensions.status.revoke" }),
    pending: intl.formatMessage({ id: "extensions.status.pending" }),
    loading: intl.formatMessage({ id: "extensions.status.loading" }),
    error: intl.formatMessage({ id: "extensions.status.error" }),
    grants: {
      "projects.read": intl.formatMessage({ id: "extensions.status.grant.projects.read" }),
      "sessions.read": intl.formatMessage({ id: "extensions.status.grant.sessions.read" }),
      "sessions.write": intl.formatMessage({ id: "extensions.status.grant.sessions.write" }),
    } satisfies Record<ExtensionGrant, string>,
    notice: intl.formatMessage({ id: "extensions.status.notice" }),
  };
  return (
    <ExtensionStatusSlotView
      view={view}
      labels={labels}
      actions={view}
      {...(className ? { className } : {})}
    />
  );
}
