import { useEffect } from "react";
import type { AppNavigationHandler, IPlatformService } from "@zcode/shared";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { logger } from "@/logger.js";
import { navigateToAppSession } from "@/root/appControlNavigationAction.js";

/**
 * 桌面 App 控制导航：只在 Root 动作挂载且历史 tab 恢复完成后登记。
 * 手机/Web 没有该平台能力，因此不会接收桌面导航；卸载即注销 generation。
 */
export function useAppControlNavigation(options: {
  platform: IPlatformService;
  isDesktop?: boolean;
  enabled?: boolean;
  activateTabByPath(path: string, options?: { workspaceIdentity?: string }): boolean;
  addTab(path: string, options?: { workspaceIdentity?: string }): string;
}): void {
  const { platform, isDesktop, enabled = true, activateTabByPath, addTab } = options;
  useEffect(() => {
    if (!isDesktop || !enabled || !platform.onAppControlNavigation) return;
    const handler: AppNavigationHandler = async (target, signal) => {
      try {
        return navigateToAppSession(
          {
            activateTabByPath,
            addTab,
            setActiveTaskId: (workspacePath, taskId, workspaceIdentity) => {
              useZCodeSessionStore
                .getState()
                .setActiveTaskId(workspacePath, taskId, workspaceIdentity);
            },
          },
          target,
          { signal },
        );
      } catch (error) {
        logger.warn("[Root] app control navigation failed", { error: String(error) });
        return { status: "unavailable", reason: "navigation-failed" };
      }
    };
    return platform.onAppControlNavigation(handler);
  }, [activateTabByPath, addTab, enabled, isDesktop, platform]);
}
