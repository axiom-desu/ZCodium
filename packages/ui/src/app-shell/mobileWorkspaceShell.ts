import { cn } from "@/components/lib/utils.js";

/**
 * 手机 Web 外壳的表现模型。
 *
 * 这里只回答“布局该怎么摆放”，不拥有任务、会话或面板状态：
 * - 侧栏显隐仍由 useAppPanels 的 isSidebarVisible 唯一拥有；
 * - 手机进入/退出只是在既有 toggle 上发一次命令，并记住进入前的桌面可见性；
 * - 不写侧栏宽度、不写右侧面板折叠偏好，回宽屏后由原 owner 状态自然恢复。
 */

export interface MobileWorkspaceSidebarEntryState {
  /** 本次会话是否已经记录过手机进入态，避免每次 render 反复收起/恢复。 */
  trackedMobileWeb: boolean;
  /** 进入手机前的桌面侧栏可见性，只存在内存里，退出时用来恢复。 */
  desktopSidebarVisible: boolean;
}

interface MobileWorkspaceSidebarEntryTransition {
  next: MobileWorkspaceSidebarEntryState;
  toggleSidebar: boolean;
}

export const INITIAL_MOBILE_WORKSPACE_SIDEBAR_ENTRY_STATE: MobileWorkspaceSidebarEntryState = {
  trackedMobileWeb: false,
  desktopSidebarVisible: false,
};

/**
 * 单次 viewport 变化的侧栏命令决策。
 *
 * 进入手机：记录桌面可见性并收起（手机默认关闭抽屉）。
 * 退出手机：把侧栏可见性恢复到进入前的桌面值（抽屉打开过也一并纠正）。
 * 其余帧：不发命令，保持唯一 owner 的值。
 */
export function resolveMobileSidebarEntryTransition({
  isMobileWeb,
  isSidebarVisible,
  state,
}: {
  isMobileWeb: boolean;
  isSidebarVisible: boolean;
  state: MobileWorkspaceSidebarEntryState;
}): MobileWorkspaceSidebarEntryTransition {
  if (isMobileWeb && !state.trackedMobileWeb) {
    return {
      next: {
        trackedMobileWeb: true,
        desktopSidebarVisible: isSidebarVisible,
      },
      // 手机进入时左栏默认关闭；桌面本来就收起时无需再多发一次 toggle。
      toggleSidebar: isSidebarVisible,
    };
  }

  if (!isMobileWeb && state.trackedMobileWeb) {
    return {
      next: {
        trackedMobileWeb: false,
        desktopSidebarVisible: state.desktopSidebarVisible,
      },
      // 手机抽屉可能被用户打开过，回宽屏时按进入前的值纠正，而不是保留手机态。
      toggleSidebar: isSidebarVisible !== state.desktopSidebarVisible,
    };
  }

  return { next: state, toggleSidebar: false };
}

/**
 * 手机侧栏抽屉打开时，主区单列：内容允许收缩到视口宽度，不再和侧栏竞争 flex 宽度。
 */
export function resolveWorkspaceContentPanelClassName({
  isMobileWeb,
  hasDesktopPanelInset,
}: {
  isMobileWeb: boolean;
  hasDesktopPanelInset: boolean;
}): string {
  return cn(
    "flex flex-1 flex-col",
    // 手机单列：内容可收缩到视口宽度；宽屏/桌面保持原有最小宽度约束。
    isMobileWeb ? "min-w-0" : "min-w-[320px]",
    hasDesktopPanelInset ? "p-1 pl-0 pt-0" : "p-0",
  );
}
