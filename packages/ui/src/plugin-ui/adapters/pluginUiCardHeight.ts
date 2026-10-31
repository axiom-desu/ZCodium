import type { PluginSandboxHandle } from "@zcode/shared/mcp-apps";
import { PLUGIN_UI_CARD_MAX_HEIGHT_PX, PLUGIN_UI_CARD_MIN_HEIGHT_PX } from "../contract.js";

/** 卡片高度 clamp：下限取资源 `minFrameHeight` 与宿主最小值的较大者，上限固定。 */
export function clampCardHeight(next: number, handle: PluginSandboxHandle | null): number {
  const min = Math.max(PLUGIN_UI_CARD_MIN_HEIGHT_PX, handle?.resourceMeta?.minFrameHeight ?? 0);
  return Math.min(PLUGIN_UI_CARD_MAX_HEIGHT_PX, Math.max(min, next));
}
