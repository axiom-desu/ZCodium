import { usePanelRef } from "react-resizable-panels";
import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { FolderOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import { TID_FILE_MANAGER_NAVIGATION_TOGGLE } from "@zcode/shared";
import { PreviewPane } from "@/PreviewPane.js";
import { WorkspaceFileTree } from "@/workspace-file-tree/WorkspaceFileTree.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { FileManagerTarget } from "@/workspace-file-tree/types.js";
import {
  canShowFileManagerNavigation,
  isFileManagerCompactWidth,
  resolveFileManagerNavigationOpen,
  resolveFileManagerWorkspaceKey,
} from "@/workspace-file-tree/fileManagerNavigation.js";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable.js";
import { logger } from "@/logger.js";

export { WorkspaceFileTree };

const FILE_MANAGER_PANEL_IDS = ["preview", "directory"];

// 目录栏边框与拖拽高亮共用同一条中线，避免 resize 指示线和目录边框左右错位。
const FILE_MANAGER_RESIZE_HANDLE_CLASS_NAME = cn(
  "aria-[orientation=vertical]:w-1 aria-[orientation=vertical]:translate-x-0 aria-[orientation=vertical]:my-0 aria-[orientation=vertical]:h-full",
  "hover:bg-transparent data-[separator=hover]:bg-transparent data-[separator=active]:bg-transparent focus-visible:bg-transparent",
  "aria-[orientation=vertical]:[mask-image:none] aria-[orientation=vertical]:[-webkit-mask-image:none]",
  "before:pointer-events-none before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-border before:content-['']",
  "after:pointer-events-none after:absolute after:rounded-full after:bg-foreground-subtlest/50 after:opacity-0 after:transition-opacity after:content-[''] after:inset-y-0 after:w-0.5 after:left-1/2 after:-translate-x-1/2",
  "hover:after:opacity-100 data-[separator=hover]:after:opacity-100 data-[separator=active]:after:opacity-100 focus-visible:after:opacity-100",
);

type FileManagerPaneProps = Omit<ComponentProps<typeof PreviewPane>, "source"> & {
  source: CodeViewerSource | null;
  target: FileManagerTarget;
  /** 移动远控 overlay：目录默认让位给预览，选中文件后自动收起。 */
  mobileOverlay?: boolean;
  canOpenLocalFileManager: boolean;
  onNavigate: (source: CodeViewerSource) => void;
};

/**
 * 文件管理器：预览 + 目录两栏（spec：.agents/specs/file-manager-navigation-pane.md）。
 *
 * preview 仍是 PreviewPane、目录仍是 WorkspaceFileTree，本组件只负责分栏、显隐偏好与
 * 「点目录行 → 更新当前 tab 的 source」，不持有目录数据，也不新建文件服务。
 */
export function FileManagerPane({
  source,
  target,
  mobileOverlay = false,
  canOpenLocalFileManager,
  onNavigate,
  ...previewProps
}: FileManagerPaneProps) {
  const { intl } = useZCodeIntl();
  const [headerContainer, setHeaderContainer] = useState<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isNarrow, setIsNarrow] = useState(mobileOverlay);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) {
        setIsNarrow(isFileManagerCompactWidth(entry.contentRect.width));
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  const workspaceKey = resolveFileManagerWorkspaceKey(target);
  const storedNavigationPreferenceOpen = useZCodeStore(
    (state) => state.fileManagerNavigationOpenByWorkspace[workspaceKey],
  );
  const setNavigationPreferenceOpen = useZCodeStore((state) => state.setFileManagerNavigationOpen);
  // Bug 原因：显隐原本由每个面板的 useState 持有，新文件 Tab 或应用重启会再次默认展开。
  // store 现在按 workspace 独占用户偏好；紧凑布局里选中文件后的自动收起只留在当前面板。
  const [compactNavigationOpenOverride, setCompactNavigationOpenOverride] = useState<
    boolean | null
  >(mobileOverlay ? !source : null);
  const compactLayout = mobileOverlay || isNarrow;
  const navigationOpen = resolveFileManagerNavigationOpen({
    compactLayout,
    compactOverride: compactNavigationOpenOverride,
    mobileOverlay,
    storedPreferenceOpen: storedNavigationPreferenceOpen,
    hasSource: Boolean(source),
  });
  const canNavigate = canShowFileManagerNavigation({
    workspacePath: target.workspacePath,
    hasSource: Boolean(source),
    sourcePath: source?.path,
  });
  const showNavigation = canNavigate && navigationOpen;
  const previewPanelRef = usePanelRef();
  const directoryPanelRef = usePanelRef();
  const navigationOnly = showNavigation && (isNarrow || mobileOverlay);
  useLayoutEffect(() => {
    // Panel 的 className 只作用于内层，hidden 会留下外层占位；必须用布局状态收放并恢复宽度。
    if (navigationOnly) previewPanelRef.current?.collapse();
    else previewPanelRef.current?.expand();
    if (showNavigation) directoryPanelRef.current?.expand();
    else directoryPanelRef.current?.collapse();
    logger.debug("[FileManager] 更新目录布局", { showNavigation, navigationOnly });
  }, [showNavigation, navigationOnly, previewPanelRef, directoryPanelRef]);
  const navigationLabel = intl.formatMessage({
    id: showNavigation ? "fileManager.hideNavigation" : "fileManager.showNavigation",
  });
  const navigate = (nextSource: CodeViewerSource) => {
    // 目录行只切换当前 tab 的 source；workspace 作用域沿用面板目标，避免预览读错 Host。
    onNavigate({
      ...nextSource,
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      workspaceRemoteSessionId: target.workspaceRemoteSessionId,
    });
    if (mobileOverlay || isNarrow) {
      setCompactNavigationOpenOverride(false);
    }
  };
  const toggleNavigation = () => {
    setNavigationPreferenceOpen(workspaceKey, !navigationOpen);
    setCompactNavigationOpenOverride(null);
  };

  return (
    <div
      ref={containerRef}
      className="@container flex h-full min-h-0 min-w-0 flex-col"
      data-file-manager-pane=""
    >
      <div className="flex h-10 shrink-0 items-center border-b border-border bg-surface/30">
        <div ref={setHeaderContainer} className="min-w-0 flex-1" data-file-manager-header="">
          {!source ? (
            <span className="px-3 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "fileManager.title" })}
            </span>
          ) : null}
        </div>
        {canNavigate ? (
          <div className="flex shrink-0 items-center border-l border-border px-1.5">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              data-testid={TID_FILE_MANAGER_NAVIGATION_TOGGLE}
              onClick={toggleNavigation}
              aria-label={navigationLabel}
              title={navigationLabel}
              aria-expanded={showNavigation}
            >
              {showNavigation ? (
                <PanelRightClose className="size-4" />
              ) : (
                <PanelRightOpen className="size-4" />
              )}
            </Button>
          </div>
        ) : null}
      </div>
      <ResizablePanelGroup
        layoutId="file-manager-layout"
        panelIds={FILE_MANAGER_PANEL_IDS}
        disabled={!showNavigation || isNarrow || mobileOverlay}
        className="min-h-0 flex-1"
      >
        <ResizablePanel
          id="preview"
          panelRef={previewPanelRef}
          collapsible
          collapsedSize="0px"
          minSize="160px"
          className="min-h-0 min-w-0"
        >
          {source ? (
            <PreviewPane {...previewProps} source={source} headerContainer={headerContainer} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-ui-base text-foreground-subtle">
              <FolderOpen className="size-6" />
              <span>{intl.formatMessage({ id: "fileManager.empty" })}</span>
            </div>
          )}
        </ResizablePanel>
        <ResizableHandle
          aria-label={intl.formatMessage({ id: "fileManager.resizeNavigation" })}
          className={cn(
            FILE_MANAGER_RESIZE_HANDLE_CLASS_NAME,
            (!showNavigation || isNarrow || mobileOverlay) && "hidden",
          )}
        />
        <ResizablePanel
          id="directory"
          panelRef={directoryPanelRef}
          collapsible
          collapsedSize="0px"
          defaultSize="192px"
          minSize="160px"
          maxSize={navigationOnly ? "100%" : "60%"}
          className="h-full min-w-0"
          onResize={(size) => logger.debug("[FileManager] 目录面板尺寸", size)}
        >
          {canNavigate ? (
            <WorkspaceFileTree
              {...target}
              canOpenLocalFileManager={canOpenLocalFileManager}
              activePreviewPath={source?.path}
              onOpenPreview={navigate}
              onOpenBrowserUrl={previewProps.onOpenBrowserUrl}
            />
          ) : null}
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
