// 新建分屏的唯一派生点（spec：docs/specs/side-pane-full-view.md「多 pane」）。
// 完整视图是否生效由 shell 现有的 `useSidePaneFullView` controller 只读派生，
// 经 `splitPaneEntryContext.enabled` 下发给所有入口；这里只把它和 pane 上限组合，
// 不持久化第二份开关，也不把 DOM 查询当作策略。
interface WorkbenchSplitAvailabilityInput {
  /** `useV4SplitPaneEntry().enabled`：shell 已按完整视图状态派生的入口可用性。 */
  readonly splitEntryEnabled: boolean;
  readonly paneCount: number;
  readonly maxPanes: number;
}

/**
 * 右键菜单「在分屏打开」、任务行拖拽源、对话边缘 dragover/drop、pane 头分屏按钮
 * 都走同一裁决；拖拽中途进入完整视图时，drop 提交再调用一次即可拒绝。
 */
export function canCreateWorkbenchSplit({
  splitEntryEnabled,
  paneCount,
  maxPanes,
}: WorkbenchSplitAvailabilityInput): boolean {
  return splitEntryEnabled && paneCount < maxPanes;
}
