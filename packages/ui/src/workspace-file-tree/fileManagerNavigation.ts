/**
 * 文件管理器面板的纯布局/偏好投影（spec：.agents/specs/file-manager-navigation-pane.md）。
 *
 * 这里只做派生，不读 localStorage、不读远端：偏好事实由 store 持有，目录事实由
 * WorkspaceFileTree 的目录 hook 持有。
 */

/** 低于该宽度时目录栏与预览共用一屏，选中文件后自动收起目录。 */
const FILE_MANAGER_COMPACT_WIDTH_PX = 384;

interface FileManagerNavigationTarget {
  workspaceIdentity?: string | null;
  workspacePath: string;
}

/**
 * 偏好 key 与 workspace identity 规则一致：identity.trim() || path。
 * 同一路径挂到不同远端/连接世代时 identity 不同，偏好不会串。
 */
export function resolveFileManagerWorkspaceKey(target: FileManagerNavigationTarget): string {
  return target.workspaceIdentity?.trim() || target.workspacePath.trim();
}

export function isFileManagerCompactWidth(width: number): boolean {
  return width < FILE_MANAGER_COMPACT_WIDTH_PX;
}

/**
 * 目录栏是否展开。
 *
 * - 宽布局：只看用户偏好，缺席默认展开。
 * - 紧凑布局：选中文件后的临时收起（compactOverride）优先；其次用户偏好；
 *   最后移动 overlay 下为预览让位（有文件时收起），普通窄栏仍先显示目录。
 */
export function resolveFileManagerNavigationOpen({
  compactLayout,
  compactOverride,
  mobileOverlay,
  storedPreferenceOpen,
  hasSource,
}: {
  compactLayout: boolean;
  compactOverride: boolean | null;
  mobileOverlay: boolean;
  storedPreferenceOpen: boolean | undefined;
  hasSource: boolean;
}): boolean {
  if (!compactLayout) {
    return storedPreferenceOpen ?? true;
  }
  if (compactOverride !== null) {
    return compactOverride;
  }
  if (storedPreferenceOpen !== undefined) {
    return storedPreferenceOpen;
  }
  return !mobileOverlay || !hasSource;
}

/** 目录栏能否出现：没有 workspace 路径时导航没有意义，不渲染开关。 */
export function canShowFileManagerNavigation({
  workspacePath,
  hasSource,
  sourcePath,
}: {
  workspacePath: string;
  hasSource: boolean;
  sourcePath: string | null | undefined;
}): boolean {
  if (!workspacePath) return false;
  return hasSource ? Boolean(sourcePath) : true;
}
