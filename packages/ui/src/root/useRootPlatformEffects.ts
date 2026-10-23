/* oxlint-disable eslint(max-lines) -- Root 平台事件共用窗口生命周期。 */
import { useEffect, useRef } from "react";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { IPlatformService } from "@zcode/shared";
import { isWorkspaceTab, type TabStoreState, type WindowTabState } from "@/store/tabStore.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { logger } from "@/logger.js";
import { toast } from "@/components/ui/toast.js";
import { matchesPrimaryShortcut } from "@/lib/keyboardShortcuts.js";
import { isShortcutRecordingActive } from "@/shortcuts/bindings.js";
import { isRendererReloadNavigation } from "@/lib/rendererNavigation.js";
import { shouldPublishCompleteWorkspaceSnapshot } from "@/root/rootPlatformWorkspaceSync.js";

export function useRootPlatformEffects({
  initialWorkspaceAbsPath,
  initialWorkspaceIdentity,
  initialWorkspacePurpose,
  initialTaskId,
  canBootstrapInitialWorkspace = true,
  addTab,
  setIsBootstrappingInitialWorkspace,
  platform,
  activateTabByPath,
  startDraftInWorkspace,
  startNewTaskFromActiveWorkspace,
  openWorkspace,
  openWorkspacePath,
  setWorkspaceActionError,
  allowOpenWorkspace = true,
  isDesktop,
  locale,
  tabs,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  totalUnreadTaskCount,
  hasCompletedFullTabRestore = true,
  intl,
}: {
  initialWorkspaceAbsPath?: string;
  initialWorkspaceIdentity?: string;
  initialWorkspacePurpose?: import("@zcode/shared").WorkspacePurpose;
  initialTaskId?: string;
  canBootstrapInitialWorkspace?: boolean;
  addTab: (
    workspacePath: string,
    options?: {
      workspaceIdentity?: string;
      workspacePurpose?: import("@zcode/shared").WorkspacePurpose;
    },
  ) => void;
  setIsBootstrappingInitialWorkspace: (value: boolean) => void;
  platform: IPlatformService;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  startDraftInWorkspace: (workspacePath: string, workspaceIdentity?: string) => void;
  startNewTaskFromActiveWorkspace: (source: string) => void;
  openWorkspace: () => void;
  openWorkspacePath: (workspacePath: string) => void;
  setWorkspaceActionError: (message: string | null) => void;
  allowOpenWorkspace?: boolean;
  isDesktop?: boolean;
  locale: ReturnType<typeof import("@/i18n/IntlProvider.js").useZCodeIntl>["locale"];
  tabs: WindowTabState[];
  activeWorkspacePath?: string | null;
  activeWorkspaceIdentity?: string | null;
  reconnectingRemoteWorkspaceKeys?: string[];
  remoteWorkspaceErrorByWorkspaceKey?: Record<string, string>;
  totalUnreadTaskCount: number;
  hasCompletedFullTabRestore?: boolean;
  intl: ReturnType<typeof import("@/i18n/IntlProvider.js").useZCodeIntl>["intl"];
}) {
  const didBootstrapInitialWorkspaceRef = useRef(false);

  useEffect(() => {
    // 历史会话完成首轮恢复后再注入显式工作区，避免恢复结果覆盖用户打开的目标。
    if (!canBootstrapInitialWorkspace || didBootstrapInitialWorkspaceRef.current) {
      return;
    }

    didBootstrapInitialWorkspaceRef.current = true;
    if (initialWorkspaceAbsPath) {
      addTab(
        initialWorkspaceAbsPath,
        initialWorkspaceIdentity || initialWorkspacePurpose
          ? {
              ...(initialWorkspaceIdentity ? { workspaceIdentity: initialWorkspaceIdentity } : {}),
              ...(initialWorkspacePurpose ? { workspacePurpose: initialWorkspacePurpose } : {}),
            }
          : undefined,
      );
      if (initialTaskId) {
        useZCodeSessionStore
          .getState()
          .setActiveTaskId(initialWorkspaceAbsPath, initialTaskId, initialWorkspaceIdentity);
      } else if (!isRendererReloadNavigation()) {
        // main 注入 initial workspace 只表达工作区入口；没有显式 taskId
        // 的 app 冷启动必须进入草稿，不能让 renderer-local last-session/group/pane
        // 抢回历史会话；同一 renderer reload 则保留当前 session 续流资格。
        startDraftInWorkspace(initialWorkspaceAbsPath, initialWorkspaceIdentity);
      }
    }
    // Dock 最近项目会通过 initialWorkspaceAbsPath 直达工作区。
    // 如果这里仍然等首屏先按默认空 tab 渲染一次，窗口会先闪出打开工作区中间页，
    // 再异步补上目标 workspace，视觉上像是“打开错页再跳转”。
    // 这里把初始工作区注入也纳入启动保护期，等首个 tab 准备好后再渲染正式内容。
    setIsBootstrappingInitialWorkspace(false);
  }, [
    addTab,
    canBootstrapInitialWorkspace,
    initialTaskId,
    initialWorkspaceAbsPath,
    initialWorkspaceIdentity,
    initialWorkspacePurpose,
    setIsBootstrappingInitialWorkspace,
    startDraftInWorkspace,
  ]);

  useEffect(() => {
    const disposeFocusTab = platform.onFocusTab((path: string) => {
      logger.info("[Root] onFocusTab:", path);
      if (activateTabByPath(path)) {
        // 系统 workspace focus 是 workspace-only 导航；任务通知另有
        // 显式 taskId 路径，不能在这里隐式恢复这个 workspace 上次选中的 session。
        startDraftInWorkspace(path);
      }
    });
    const disposeNewTab = platform.onNewTab(() => {
      logger.info("[Root] onNewTab");
      setWorkspaceActionError(null);
      // 新标签过去会打开工作区中间页，导致启动/快捷键都可能进入中间页。
      // 现在新标签语义收敛为“打开工作区”动作，由 Root 决定目录选择或默认 workspace 兜底。
      openWorkspace();
    });
    const disposeNewTask = platform.onNewTask(() => {
      startNewTaskFromActiveWorkspace("onNewTask");
    });
    const disposeOpenWorkspace = platform.onOpenWorkspace(() => {
      logger.info("[Root] onOpenWorkspace");
      openWorkspace();
    });
    const disposeOpenWorkspacePath = platform.onOpenWorkspacePath
      ? platform.onOpenWorkspacePath((path: string) => {
          if (!allowOpenWorkspace) {
            logger.info("[Root] 当前模式不支持通过 deep link 打开文件夹，已忽略请求");
            return;
          }

          logger.info("[Root] onOpenWorkspacePath:", path);
          // 系统服务 deep link 对应输入框上方 Open folder 语义。
          // 这里复用 handleSelectProject，而不是把路径作为聊天附件，才能保留 tab 去重、
          // 跨窗口激活和 recentProjects 更新这些手动打开文件夹的既有行为。
          openWorkspacePath(path);
        })
      : () => {};
    const disposeNotificationClick = platform.onTaskNotificationClick((taskId: string) => {
      logger.info("[Root] onTaskNotificationClick:", taskId);
      // 遍历所有 workspace 找到 taskId 所属的 workspace，然后激活对应 tab 并切换任务
      const workspaces = useZCodeSessionStore.getState().workspaces;
      for (const [workspacePath, workspaceState] of Object.entries(workspaces)) {
        const taskMeta = workspaceState.taskListCache?.find((task) => task.taskId === taskId);
        const hasTask = workspaceState.activeTaskId === taskId || Boolean(taskMeta);
        if (hasTask) {
          const targetWorkspacePath = taskMeta?.workspacePath ?? workspacePath;
          const targetWorkspaceIdentity = taskMeta?.workspaceIdentity;
          // 通知点击会从全局 workspace store 反查 task。
          // 远端任务必须用 task meta 自带的 workspaceIdentity 激活和选中，否则会落到 path-only 桶。
          activateTabByPath(
            targetWorkspacePath,
            targetWorkspaceIdentity ? { workspaceIdentity: targetWorkspaceIdentity } : undefined,
          );
          useZCodeSessionStore
            .getState()
            .setActiveTaskId(targetWorkspacePath, taskId, targetWorkspaceIdentity);
          return;
        }
      }
      logger.warn("[Root] onTaskNotificationClick: task not found in any workspace:", taskId);
    });
    const disposeUpdateCheckResult = platform.onUpdateCheckResult
      ? platform.onUpdateCheckResult((payload) => {
          logger.info("[Root] onUpdateCheckResult:", payload.kind);
          switch (payload.kind) {
            case "up-to-date":
              toast(
                intl.formatMessage(
                  { id: "update.toast.upToDate" },
                  { version: payload.currentVersion },
                ),
              );
              return;
            case "downloading":
              toast(
                intl.formatMessage(
                  { id: "update.toast.downloading" },
                  { version: payload.version },
                ),
              );
              return;
            case "available":
              toast(
                intl.formatMessage({ id: "update.toast.available" }, { version: payload.version }),
              );
              return;
            case "already-downloading":
              toast(
                intl.formatMessage(
                  { id: "update.toast.alreadyDownloading" },
                  { progress: payload.progress },
                ),
              );
              return;
            case "ready":
              toast(intl.formatMessage({ id: "update.toast.ready" }, { version: payload.version }));
              return;
            case "dev-skipped":
              toast(intl.formatMessage({ id: "update.toast.devSkipped" }));
              return;
            case "error":
              toast(intl.formatMessage({ id: "update.toast.error" }, { error: payload.message }));
              return;
          }
        })
      : () => {};
    return () => {
      disposeFocusTab();
      disposeNewTab();
      disposeNewTask();
      disposeOpenWorkspace();
      disposeOpenWorkspacePath();
      disposeNotificationClick();
      disposeUpdateCheckResult();
    };
  }, [activeWorkspaceIdentity, activeWorkspacePath, platform, tabs]);

  useEffect(() => {
    if (!isDesktop || !shouldPublishCompleteWorkspaceSnapshot(hasCompletedFullTabRestore)) {
      return;
    }

    const paths = tabs
      .filter(isWorkspaceTab)
      // 启动期远程 workspace 现在会先以“断开占位 tab”恢复，
      // 这些 tab 没有 remoteSessionId，但本质仍是远程会话，不能当成本地路径同步给主进程窗口列表。
      // 这里改成按完整远程身份字段过滤，避免把远程路径误同步到本地窗口标签。
      .filter((tab) => !tab.remoteSessionId && !tab.workspaceIdentity && !tab.remoteTarget)
      .map((tab) => tab.workspacePath);
    platform.syncWindowTabs(paths);
  }, [hasCompletedFullTabRestore, isDesktop, platform, tabs]);

  useEffect(() => {
    if (isDesktop) {
      return;
    }

    function handleWindowKeydown(event: KeyboardEvent) {
      // 录制态键盘归录制器独占。本监听先于录制监听注册（同 capture 阶段），
      // 不短路的话录制期按 Cmd/Ctrl+N、O 预览会真实触发新建任务/打开工作区。
      if (isShortcutRecordingActive()) {
        return;
      }
      const isNewTaskShortcut = matchesPrimaryShortcut(event, "n");
      const isOpenWorkspaceShortcut = matchesPrimaryShortcut(event, "o");

      if (!isNewTaskShortcut && !isOpenWorkspaceShortcut) {
        return;
      }

      // Web 端没有宿主菜单，补一层 best-effort 键盘监听，按平台主修饰键落到同一套根级动作。
      // 耦合说明：这里固定使用默认键位（Ctrl/Cmd+N、+O），与「menu 通道命令在 Web 端不可配置」
      // （设置页置灰）配套——若未来放开 Web 端 menu 通道改键，
      // 此处必须改为读快捷键生效表，否则用户改键后 Web 行为会分裂。
      event.preventDefault();
      if (isOpenWorkspaceShortcut) {
        openWorkspace();
        return;
      }

      startNewTaskFromActiveWorkspace("web CmdOrCtrl+N");
    }

    window.addEventListener("keydown", handleWindowKeydown, true);
    return () => {
      window.removeEventListener("keydown", handleWindowKeydown, true);
    };
  }, [isDesktop, openWorkspace, startNewTaskFromActiveWorkspace]);

  useEffect(() => {
    if (!isDesktop) {
      return;
    }

    let disposed = false;

    // 原生菜单文案之前在 main 进程里写死，renderer 切换 locale 只会更新 React 标题栏菜单。
    // 结果就是桌面端会同时出现两套语言，Help 里的反馈/导出日志也无法跟随当前语言切换。
    // 这里把当前 locale 主动同步给 main，让原生菜单和标题栏菜单都从同一份语言状态重建。
    platform.setApplicationLocale(locale).catch((error) => {
      if (disposed) {
        return;
      }
      logger.error("[Root] 同步应用菜单语言失败", { locale, error });
    });

    return () => {
      disposed = true;
    };
  }, [isDesktop, locale, platform]);

  useEffect(() => {
    // Dock badge 一期只统计“后台完成后还没点开”的 task 数。
    // 失败态红点和 permission tag 仍留在各自 UI 语义里，避免把平台徽标混成泛化告警数。
    platform.syncWindowUnreadCount(totalUnreadTaskCount);
  }, [platform, totalUnreadTaskCount]);

  const activeTabId = useTabStore((state: TabStoreState) => state.activeTabId);
  const activeTabCandidate = useTabStore((state: TabStoreState) =>
    state.tabs.find((tab: WindowTabState) => tab.id === state.activeTabId),
  );
  const activeTab =
    activeTabCandidate && isWorkspaceTab(activeTabCandidate) ? activeTabCandidate : undefined;
  const lastSyncedSessionIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!isDesktop) return;
    const workspacePath = activeTab?.workspacePath;
    const workspaceIdentity = activeTab?.workspaceIdentity;
    const syncActiveSession = (): void => {
      const nextSessionId = workspacePath
        ? (useZCodeSessionStore.getState().getWorkspaceState(workspacePath, workspaceIdentity)
            .activeTaskId ?? null)
        : null;
      if (nextSessionId === lastSyncedSessionIdRef.current) return;
      lastSyncedSessionIdRef.current = nextSessionId;
      platform.syncActiveTaskSession(nextSessionId);
    };
    syncActiveSession();
    return useZCodeSessionStore.subscribe(syncActiveSession);
  }, [activeTab, activeTabId, isDesktop, platform]);
}
