import { sortInstalledEditorsForOpenWith } from "@/lib/openWithEditors.js";
import { toFileUrl } from "@/lib/path.js";
import type { WorkspaceFileTreeRow } from "@/workspace-file-tree/model.js";

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function replaceSetValue(set: Set<string>, value: string, present: boolean): Set<string> {
  const next = new Set(set);
  if (present) {
    next.add(value);
  } else {
    next.delete(value);
  }
  return next;
}

function isMacLike(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  return /mac/i.test(navigator.userAgent);
}

function isWindowsLike(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  return /windows/i.test(navigator.userAgent);
}

export function getFileManagerLabel(intl: { formatMessage: (desc: { id: string }) => string }) {
  if (isMacLike()) {
    return intl.formatMessage({ id: "appHeader.openInFinder" });
  }

  if (isWindowsLike()) {
    return intl.formatMessage({ id: "appHeader.openInFileExplorer" });
  }

  return intl.formatMessage({ id: "appHeader.openInFileManager" });
}

export function isWorkspaceFileTreeHtmlFile(
  row: Pick<WorkspaceFileTreeRow, "path" | "type">,
): boolean {
  if (row.type !== "file") {
    return false;
  }

  return /\.(?:html|htm)$/i.test(row.path);
}

export function createWorkspaceFileTreeHtmlBrowserUrl(
  row: Pick<WorkspaceFileTreeRow, "path" | "type">,
): string | null {
  if (!isWorkspaceFileTreeHtmlFile(row)) {
    return null;
  }

  return toFileUrl(row.path);
}

export const sortInstalledEditorsForFileTree = sortInstalledEditorsForOpenWith;

/**
 * 单击 HTML 文件是否走内置浏览器。
 *
 * 四个条件缺一不可：本机偏好开启、本地（非远程）文件树、平台提供了内置浏览器打开端口、
 * 目标确实是 HTML 文件。其余情况单击回落到源码预览；右键「打开」永远是预览。
 */
export function shouldOpenWorkspaceFileTreeHtmlInBrowser({
  row,
  htmlClickOpensBrowser,
  isRemoteWorkspace,
  hasBrowserOpener,
}: {
  row: Pick<WorkspaceFileTreeRow, "path" | "type">;
  htmlClickOpensBrowser: boolean;
  isRemoteWorkspace: boolean;
  hasBrowserOpener: boolean;
}): boolean {
  return (
    htmlClickOpensBrowser &&
    !isRemoteWorkspace &&
    hasBrowserOpener &&
    isWorkspaceFileTreeHtmlFile(row)
  );
}

/**
 * 文件管理器两栏同时被折叠到 0 后需要重挂载分组才能恢复。
 *
 * react-resizable-panels 用「分栏宽度之和」测量组宽，两栏都是 0 时它会认为组宽也是 0，
 * 之后容器恢复宽度也不会重新分配（表现为黑屏）。这里只判断“已恢复宽度但两栏仍为 0”，
 * 重挂载由调用方执行（保持 panel 顺序与 header 不变）。
 */
export function shouldResetFileManagerLayout({
  containerWidthPx,
  previewSizePercentage,
  directorySizePercentage,
}: {
  containerWidthPx: number;
  previewSizePercentage: number;
  directorySizePercentage: number;
}): boolean {
  return containerWidthPx >= 160 && previewSizePercentage === 0 && directorySizePercentage === 0;
}
