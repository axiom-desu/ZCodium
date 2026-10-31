import { createRoot } from "react-dom/client";
import { V4WorkspaceChatArea } from "../../src/v4/V4WorkspaceChatArea.js";
import {
  V4SplitPaneEntryContext,
  useV4SplitPaneEntryValue,
} from "../../src/v4/splitPaneEntryContext.js";
import { useSidePaneFullView } from "../../src/side-pane-full-view/useSidePaneFullView.js";
import { useWorkbenchPaneCount } from "../../src/app-shell/useWorkbenchPaneCount.js";
import { usePaneLayoutStore } from "../../src/v4/paneLayoutStore.js";

// 分屏新建守卫的组件 E2E 夹具（spec：docs/specs/side-pane-full-view.md「多 pane」）。
// 真实生产组件：V4WorkspaceChatArea、V4SplitPaneEntryContext/useV4SplitPaneEntryValue、
// paneLayoutStore、workbenchSessionPlacement、useWorkbenchPaneCount、useSidePaneFullView。
// 只把重型对话叶子（SessionPane / V4PaneConversationProvider）替换成可断言的展示桩，
// 因此断言的是真实宿主的 dragover/drop 与 pane 头分屏接线，不是复制版 harness。
const workspacePath = "/fixture/workbench-split-guard";
const fixture = (window.workbenchSplitGuardFixture = {
  enterFullView: () => {},
  exitFullView: () => {},
  resetPanes: () => {},
});

const noop = () => {};

function Harness() {
  const paneCount = useWorkbenchPaneCount();
  const fullView = useSidePaneFullView({
    workspacePath,
    ownerId: "task-a",
    isSidePaneOpen: true,
    // 与 shell 相同：单 pane 才允许完整视图。
    enabled: paneCount <= 1,
  });
  const isFullView = fullView.fullView !== null;
  const resetPanes = usePaneLayoutStore((state) => state.resetToPrimaryPane);
  // 与 WorkspaceShellLayout 相同：唯一派生值来自现有 full view controller，
  // 同一 context value 同时给侧栏与对话区，不持久化第二份开关。
  const splitEntryValue = useV4SplitPaneEntryValue({
    enabled: !isFullView,
    canOpenSession: () => false,
    onOpenSession: noop,
  });
  fixture.enterFullView = fullView.enter;
  fixture.exitFullView = fullView.exit;
  fixture.resetPanes = resetPanes;

  return (
    <V4SplitPaneEntryContext.Provider value={splitEntryValue}>
      <div className="fixed inset-0 overflow-hidden bg-background">
        <V4WorkspaceChatArea workspacePath={workspacePath} sessionId={null} isDesktop={false} />
      </div>
      <div className="fixed left-2 top-2 z-[100] flex flex-col gap-1 rounded border border-border bg-background p-1 text-xs">
        <button type="button" data-testid="guard-enter-full-view" onClick={fullView.enter}>
          enter full view
        </button>
        <button type="button" data-testid="guard-exit-full-view" onClick={fullView.exit}>
          exit full view
        </button>
        <button type="button" data-testid="guard-reset-panes" onClick={resetPanes}>
          reset panes
        </button>
        <span data-testid="guard-full-view">{isFullView ? "true" : "false"}</span>
        <span data-testid="guard-split-enabled">{splitEntryValue.enabled ? "true" : "false"}</span>
        <span data-testid="guard-pane-count">{paneCount}</span>
      </div>
    </V4SplitPaneEntryContext.Provider>
  );
}

createRoot(document.getElementById("root")).render(<Harness />);
