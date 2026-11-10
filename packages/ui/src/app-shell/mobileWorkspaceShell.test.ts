import { describe, expect, it } from "vitest";
import {
  INITIAL_MOBILE_WORKSPACE_SIDEBAR_ENTRY_STATE,
  resolveMobileSidebarEntryTransition,
} from "@/app-shell/mobileWorkspaceShell.js";

describe("resolveMobileSidebarEntryTransition", () => {
  it("desktop 初始帧不发射 toggle 命令", () => {
    const transition = resolveMobileSidebarEntryTransition({
      isMobileWeb: false,
      isSidebarVisible: true,
      state: INITIAL_MOBILE_WORKSPACE_SIDEBAR_ENTRY_STATE,
    });

    expect(transition.toggleSidebar).toBe(false);
    expect(transition.next.trackedMobileWeb).toBe(false);
  });

  it("进入手机时记录桌面可见性并收起左栏", () => {
    const transition = resolveMobileSidebarEntryTransition({
      isMobileWeb: true,
      isSidebarVisible: true,
      state: INITIAL_MOBILE_WORKSPACE_SIDEBAR_ENTRY_STATE,
    });

    expect(transition.toggleSidebar).toBe(true);
    expect(transition.next).toEqual({ trackedMobileWeb: true, desktopSidebarVisible: true });
  });

  it("桌面本来就收起时进入手机不再多 toggle 一次", () => {
    const transition = resolveMobileSidebarEntryTransition({
      isMobileWeb: true,
      isSidebarVisible: false,
      state: INITIAL_MOBILE_WORKSPACE_SIDEBAR_ENTRY_STATE,
    });

    expect(transition.toggleSidebar).toBe(false);
    expect(transition.next.desktopSidebarVisible).toBe(false);
  });

  it("手机内抽屉开合不触发进入/退出命令", () => {
    const transition = resolveMobileSidebarEntryTransition({
      isMobileWeb: true,
      isSidebarVisible: true,
      state: { trackedMobileWeb: true, desktopSidebarVisible: false },
    });

    expect(transition.toggleSidebar).toBe(false);
    expect(transition.next).toEqual({ trackedMobileWeb: true, desktopSidebarVisible: false });
  });

  it("回宽屏时把打开过的手机抽屉恢复成进入前的收起态", () => {
    const transition = resolveMobileSidebarEntryTransition({
      isMobileWeb: false,
      isSidebarVisible: true,
      state: { trackedMobileWeb: true, desktopSidebarVisible: false },
    });

    expect(transition.toggleSidebar).toBe(true);
    expect(transition.next.trackedMobileWeb).toBe(false);
  });

  it("回宽屏时把收起的手机抽屉恢复成进入前的展开态", () => {
    const transition = resolveMobileSidebarEntryTransition({
      isMobileWeb: false,
      isSidebarVisible: false,
      state: { trackedMobileWeb: true, desktopSidebarVisible: true },
    });

    expect(transition.toggleSidebar).toBe(true);
    expect(transition.next.trackedMobileWeb).toBe(false);
  });

  it("回宽屏时可见性已与进入前一致则不写命令", () => {
    const transition = resolveMobileSidebarEntryTransition({
      isMobileWeb: false,
      isSidebarVisible: false,
      state: { trackedMobileWeb: true, desktopSidebarVisible: false },
    });

    expect(transition.toggleSidebar).toBe(false);
  });
});
