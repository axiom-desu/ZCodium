import { useMemo } from "react";
import { usePaneLayoutStore } from "@/v4/paneLayoutStore.js";
import { useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";
import { collectWorkbenchLayout } from "@/v4/workbenchLayout.js";

/**
 * 当前活动 workbench 的 pane 数量（spec：docs/specs/side-pane-full-view.md）。
 * 完整视图的入口可用性由它派生：浮窗只承载一个对话，多 pane 时显式禁用入口。
 * 只订阅 root / activeGroup，不订阅 pane 内容，避免 streaming 触发壳层重渲染。
 */
export function useWorkbenchPaneCount(): number {
  const activeGroupRoot = useWorkbenchGroupStore((state) =>
    state.activeGroupId ? (state.groups[state.activeGroupId]?.root ?? null) : null,
  );
  const paneLayoutRoot = usePaneLayoutStore((state) => state.root);
  return useMemo(
    () => collectWorkbenchLayout(activeGroupRoot ?? paneLayoutRoot).leaves.length,
    [activeGroupRoot, paneLayoutRoot],
  );
}
