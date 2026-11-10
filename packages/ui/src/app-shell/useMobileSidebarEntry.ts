import { useLayoutEffect, useRef } from "react";
import {
  INITIAL_MOBILE_WORKSPACE_SIDEBAR_ENTRY_STATE,
  resolveMobileSidebarEntryTransition,
  type MobileWorkspaceSidebarEntryState,
} from "@/app-shell/mobileWorkspaceShell.js";

/**
 * 手机 Web 进入 / 退出时，把侧栏收开状态同步到既有 owner（useAppPanels）。
 *
 * 只在 viewport 事实变化时发命令：
 * - 进入手机：收起抽屉；
 * - 退出手机：恢复进入前的桌面可见性；
 * - 其它 render 不写任何宽度、面板贡献或持久化偏好。
 */
export function useMobileSidebarEntry({
  isMobileWeb,
  isSidebarVisible,
  onToggleSidebar,
}: {
  isMobileWeb: boolean;
  isSidebarVisible: boolean;
  onToggleSidebar: () => void;
}): void {
  const entryStateRef = useRef<MobileWorkspaceSidebarEntryState>(
    INITIAL_MOBILE_WORKSPACE_SIDEBAR_ENTRY_STATE,
  );
  const latestRef = useRef({ isSidebarVisible, onToggleSidebar });
  latestRef.current = { isSidebarVisible, onToggleSidebar };

  useLayoutEffect(() => {
    const transition = resolveMobileSidebarEntryTransition({
      isMobileWeb,
      isSidebarVisible: latestRef.current.isSidebarVisible,
      state: entryStateRef.current,
    });
    entryStateRef.current = transition.next;
    if (transition.toggleSidebar) {
      // 用 layout effect 在首帧前收起抽屉，避免手机首次打开先闪出桌面侧栏。
      latestRef.current.onToggleSidebar();
    }
  }, [isMobileWeb]);
}
