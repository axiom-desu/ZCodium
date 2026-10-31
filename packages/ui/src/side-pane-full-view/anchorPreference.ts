import type { FloatingAnchor } from "@/side-pane-full-view/contract.js";
import { DEFAULT_FLOATING_ANCHOR, parseFloatingAnchor } from "@/side-pane-full-view/model.js";
import { logger } from "@/logger.js";

/**
 * 浮窗吸附位置是全局偏好（spec：docs/specs/side-pane-full-view.md），不随对话切换；
 * 与完整视图记录（按 workspace + owner 的 renderer 内存）分开存放。
 */
const FLOATING_ANCHOR_STORAGE_KEY = "zcode:side-pane-full-view:floating-anchor";

export function readFloatingAnchorPreference(): FloatingAnchor {
  try {
    return (
      parseFloatingAnchor(window.localStorage.getItem(FLOATING_ANCHOR_STORAGE_KEY)) ??
      DEFAULT_FLOATING_ANCHOR
    );
  } catch {
    return DEFAULT_FLOATING_ANCHOR;
  }
}

export function writeFloatingAnchorPreference(anchor: FloatingAnchor): void {
  try {
    window.localStorage.setItem(FLOATING_ANCHOR_STORAGE_KEY, anchor);
  } catch (error) {
    logger.warn("[SidePaneFullView] 浮窗吸附位置写入失败", { anchor, error });
  }
}
