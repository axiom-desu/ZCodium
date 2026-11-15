import type { EditorInfo } from "@zcode/shared";
import { ChevronDownIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import { FileApplicationChoices, FileSaveAsMenuItem } from "@/file-menu/index.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useFileContextActions } from "@/hooks/useFileContextActions.js";
import { useWorkspaceOpenInEditorTarget } from "@/hooks/useWorkspaceOpenInEditorTarget.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { persistLastSelectedEditorId } from "@/lib/editorPreference.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { getWorkspaceFileRelativePath } from "@/workspace-file-tree/model.js";
import { resolveWorkspaceEditorSelection } from "@/lib/workspaceEditorSelection.js";
import { logger } from "@/logger.js";

// 导出类型供共用时间线以 import type 引用（构建期擦除，不把 open-with 子树带进公开页 bundle）。
export type OpenSplitButtonTarget =
  | {
      type: "website";
      url: string;
      localPath?: string;
    }
  | {
      type: "file";
      path: string;
      title: string;
      label: string;
      previewSource?: CodeViewerSource;
    };

interface OpenSplitButtonProps {
  target: OpenSplitButtonTarget;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  hideOpenWithMenu?: boolean;
  stopPropagation?: boolean;
}

export function OpenSplitButton({
  target,
  onOpenBrowserUrl,
  onOpenFileLink,
  onOpenCodeViewer,
  hideOpenWithMenu = false,
  stopPropagation = false,
}: OpenSplitButtonProps) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const fileActions = useFileContextActions();
  const previewSource = target.type === "file" ? target.previewSource : undefined;
  const matchedOpenContext = useWorkspaceOpenInEditorTarget({
    workspacePath: previewSource?.workspacePath,
    workspaceIdentity: previewSource?.workspaceIdentity,
    workspaceRemoteSessionId: previewSource?.workspaceRemoteSessionId,
  });
  const openInEditorRemoteTarget = matchedOpenContext.remoteTarget;
  const isRemoteSource = Boolean(
    previewSource?.workspaceIdentity ||
    previewSource?.workspaceRemoteSessionId ||
    matchedOpenContext.isRemoteWorkspace,
  );
  const [editors, setEditors] = useState<EditorInfo[]>([]);
  const [editorsLoaded, setEditorsLoaded] = useState(false);
  const [loadingEditors, setLoadingEditors] = useState(false);
  const sortedEditors = useMemo(
    () =>
      isRemoteSource && !openInEditorRemoteTarget
        ? []
        : resolveWorkspaceEditorSelection({
            installedEditors: editors,
            selectedEditorId: null,
            remoteTarget: openInEditorRemoteTarget,
          }).availableEditors,
    [editors, isRemoteSource, openInEditorRemoteTarget],
  );
  const canPreview =
    target.type === "website"
      ? Boolean(onOpenBrowserUrl)
      : Boolean(onOpenFileLink || onOpenCodeViewer);
  const stopEventPropagation = (event: { stopPropagation: () => void }) => {
    if (stopPropagation) {
      event.stopPropagation();
    }
  };

  const loadEditors = useCallback(async () => {
    if (editorsLoaded || loadingEditors || target.type !== "file") {
      return;
    }

    setLoadingEditors(true);
    try {
      // 传入具体文件路径：Desktop 用系统关联追加该类型的本机应用（PDF/Office/媒体），
      // 不传时只返回 IDE/终端，文件类型的「打开方式」会缺失。
      setEditors(await platform.getInstalledEditors(target.path));
      setEditorsLoaded(true);
    } catch (error) {
      logger.warn("[OpenSplitButton] 获取第三方打开方式失败", {
        path: target.path,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoadingEditors(false);
    }
  }, [editorsLoaded, loadingEditors, platform, target]);

  const handlePreview = () => {
    if (target.type === "website") {
      onOpenBrowserUrl?.(target.url);
      return;
    }

    if (onOpenCodeViewer) {
      onOpenCodeViewer(
        target.previewSource ?? {
          type: "file",
          title: target.title,
          path: target.path,
        },
      );
      return;
    }

    onOpenFileLink?.({
      path: target.path,
      label: target.label,
      pathKind: "file",
      workspacePath: target.previewSource?.workspacePath,
      workspaceIdentity: target.previewSource?.workspaceIdentity,
      workspaceRemoteSessionId: target.previewSource?.workspaceRemoteSessionId,
    });
  };

  const handleOpenInEditor = (editor: EditorInfo) => {
    if (target.type !== "file") {
      return;
    }

    persistLastSelectedEditorId(editor.id);
    void platform
      .openInEditor(editor.id, target.path, {
        pathKind: "file",
        remoteTarget: openInEditorRemoteTarget,
        workspaceIdentity: target.previewSource?.workspaceIdentity,
      })
      .then((result) => {
        if (result.success) {
          return;
        }

        logger.warn("[OpenSplitButton] 第三方 App 打开文件失败", {
          editorId: editor.id,
          path: target.path,
          error: result.error ?? "unknown-error",
        });
      });
  };

  const handleOpenExternal = () => {
    if (target.type !== "website" || !target.localPath || !platform.openExternalFile) {
      platform.openExternal(target.type === "website" ? target.url : target.path);
      return;
    }

    const localPath = target.localPath;
    const reportFailure = (error: unknown) => {
      logger.warn("[OpenSplitButton] 浏览器打开本地文件失败", {
        path: localPath,
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "chat.previewCards.openExternalFailed" }));
    };
    void platform
      .openExternalFile(localPath)
      .then((result) => {
        if (!result.success) reportFailure(result.error ?? "unknown-error");
      })
      .catch(reportFailure);
  };

  const handleOpenWithDefaultApp = () => {
    if (target.type !== "file" || isRemoteSource || !platform.canOpenLocalFiles) {
      return;
    }
    if (!platform.openExternalFile) {
      toast(intl.formatMessage({ id: "chat.previewCards.openFileFailed" }));
      return;
    }
    const filePath = target.path;
    void platform
      .openExternalFile(filePath)
      .then((result) => {
        if (!result.success) {
          logger.warn("[OpenSplitButton] 默认应用打开文件失败", {
            path: filePath,
            error: result.error ?? "unknown-error",
          });
          toast(intl.formatMessage({ id: "chat.previewCards.openFileFailed" }));
        }
      })
      .catch((error) => {
        logger.warn("[OpenSplitButton] 默认应用打开文件失败", {
          path: filePath,
          error: error instanceof Error ? error.message : String(error),
        });
        toast(intl.formatMessage({ id: "chat.previewCards.openFileFailed" }));
      });
  };

  if (hideOpenWithMenu) {
    return (
      <div
        className="flex h-7 shrink-0 items-center overflow-hidden rounded-lg border border-border bg-input transition-all hover:border-border-hover"
        onClick={stopEventPropagation}
        onPointerDown={stopEventPropagation}
      >
        <Button
          type="button"
          variant="ghost"
          size="default"
          className="h-7 rounded-none border-0 gap-1 px-2"
          disabled={!canPreview}
          onClick={(event) => {
            stopEventPropagation(event);
            handlePreview();
          }}
        >
          {intl.formatMessage({ id: "common.open" })}
        </Button>
      </div>
    );
  }

  return (
    <DropdownMenu onOpenChange={(open) => open && void loadEditors()}>
      <div
        className="flex h-7 shrink-0 items-center overflow-hidden rounded-lg border border-border bg-input transition-all hover:border-border-hover"
        onClick={stopEventPropagation}
        onPointerDown={stopEventPropagation}
      >
        <Button
          type="button"
          variant="ghost"
          size="default"
          className="h-7 rounded-none border-0 gap-1 pr-1.5"
          disabled={!canPreview}
          onClick={(event) => {
            stopEventPropagation(event);
            handlePreview();
          }}
        >
          {intl.formatMessage({ id: "common.open" })}
        </Button>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            className="!w-5 rounded-none border-0 text-foreground-subtlest"
            aria-label={intl.formatMessage({ id: "appHeader.selectOpenApp" })}
            title={intl.formatMessage({ id: "appHeader.selectOpenApp" })}
            onClick={stopEventPropagation}
          >
            <ChevronDownIcon className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent align="end" side="top" className="w-44" onClick={stopEventPropagation}>
        {target.type === "website" ? (
          <DropdownMenuItem onSelect={handleOpenExternal}>
            <ExternalLinkIcon className="size-4" />
            <span>
              {intl.formatMessage({
                id: "chat.previewCards.openExternal",
              })}
            </span>
          </DropdownMenuItem>
        ) : (
          <>
            {/* 打开方式与另存为共用 file-menu 公开组件，A3-lite 直接用 EditorInfo 候选。 */}
            <FileApplicationChoices
              applications={sortedEditors}
              loading={loadingEditors}
              onSelect={handleOpenInEditor}
              onOpenDefault={
                isRemoteSource || !platform.canOpenLocalFiles ? undefined : handleOpenWithDefaultApp
              }
            />
            <FileSaveAsMenuItem
              variant="dropdown"
              path={target.path}
              workspacePath={target.previewSource?.workspacePath}
              workspaceIdentity={target.previewSource?.workspaceIdentity}
              workspaceRemoteSessionId={target.previewSource?.workspaceRemoteSessionId}
            />
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => void fileActions.copyAbsolutePath({ path: target.path })}
            >
              <CopyIcon className="size-4" />
              {intl.formatMessage({ id: "fileActions.copyAbsolutePath" })}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                void fileActions.copyRelativePath({
                  path: target.path,
                  relativePath: target.previewSource?.workspacePath
                    ? getWorkspaceFileRelativePath(target.previewSource.workspacePath, target.path)
                    : target.label,
                })
              }
            >
              <CopyIcon className="size-4" />
              {intl.formatMessage({ id: "fileActions.copyRelativePath" })}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
