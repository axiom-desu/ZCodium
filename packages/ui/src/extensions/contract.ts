import type { ExtensionGrant, ExtensionSlotProjection } from "@zcode/shared/extension-host";
import type { ExtensionsSnapshot } from "@zcode/services";

/**
 * UI 扩展槽位契约：只消费 `services/extensions` 的投影。
 * UI 不持有授权、进程或贡献状态；没有扩展服务（手机/Web/旧 Host）时不渲染任何扩展 UI。
 */
export interface ExtensionSlotViewState {
  /** 服务是否可用；false 时组件返回 null。 */
  available: boolean;
  loading: boolean;
  phase: ExtensionsSnapshot["phase"];
  /** 与当前 generation 匹配的槽位（已按 order/pluginId/id 排序）。 */
  slots: ExtensionSlotProjection[];
  /** 待用户确认授权的插件（needs-consent）。 */
  pending: Array<{ pluginId: string; name: string; declared: ExtensionGrant[] }>;
  canStart: boolean;
  error?: string;
}

export interface ExtensionSlotActions {
  start(): Promise<void>;
  stop(): Promise<void>;
  grant(pluginId: string): Promise<void>;
  revoke(pluginId: string): Promise<void>;
}
