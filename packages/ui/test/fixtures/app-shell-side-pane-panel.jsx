import { TID_SIDE_PANE_TOGGLE } from "@zcode/shared";
import { SidePaneFullViewToggleButton } from "@/side-pane-full-view/index.js";

/**
 * 桌面完整视图守卫的面板展示替身：只画完整视图入口与 slot，不复制 App 的开关/owner 状态。
 * 这里刻意不声明 panel/frame 的真实 DOM 契约：手机 E2E 已改为挂载真实
 * AnimatedSidePanePanel，避免替身把外层 Panel 与内层 frame 混成一个节点造成 falsepass。
 */
export function AnimatedSidePanePanel({
  isVisible,
  onCloseSidePane,
  fullViewToggle,
  fullViewSlotRef,
}) {
  return (
    <div
      className={
        isVisible
          ? "relative flex h-full min-h-0 flex-1 flex-col overflow-hidden border border-border bg-background"
          : "hidden"
      }
    >
      <div className="flex h-10 shrink-0 items-center gap-1 px-2">
        <button
          type="button"
          data-testid={TID_SIDE_PANE_TOGGLE}
          className="rounded border border-border px-2 py-1 text-ui-sm"
          onClick={onCloseSidePane}
        >
          close pane
        </button>
        {fullViewToggle ? <SidePaneFullViewToggleButton {...fullViewToggle} /> : null}
      </div>
      <div
        ref={fullViewSlotRef}
        data-side-pane-content-slot=""
        className="relative min-h-0 flex-1 overflow-hidden"
      >
        <p className="p-2 text-ui-sm text-foreground-subtle">panel content</p>
      </div>
    </div>
  );
}
