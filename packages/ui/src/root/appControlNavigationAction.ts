import type { AppNavigationResult, AppNavigationTarget } from "@zcode/shared";

interface AppNavigationActionDeps {
  /** 已有 tab 时只激活，返回是否命中。 */
  activateTabByPath(path: string, options?: { workspaceIdentity?: string }): boolean;
  /** 缺少 tab 时补一个并激活；只走既有 tab owner。 */
  addTab(path: string, options?: { workspaceIdentity?: string }): string;
  /** 既有 session store 的唯一选中入口；不另建导航 store。 */
  setActiveTaskId(workspacePath: string, taskId: string, workspaceIdentity?: string): void;
  isWorkspaceVisible?(path: string, options?: { workspaceIdentity?: string }): boolean;
}

/**
 * App 控制的显式导航落地：复用 Root 已有动作（tab 激活/补开 + 既有 session 选中）。
 * 只有这里真正提交后才返回 opened；取消发生在提交前则返回 unavailable。
 */
export function navigateToAppSession(
  deps: AppNavigationActionDeps,
  target: AppNavigationTarget,
  options?: { signal?: AbortSignal },
): AppNavigationResult {
  if (options?.signal?.aborted) return { status: "unavailable", reason: "navigation-cancelled" };
  const tabOptions = target.workspaceIdentity
    ? { workspaceIdentity: target.workspaceIdentity }
    : undefined;
  const activated = deps.activateTabByPath(target.workspacePath, tabOptions);
  if (!activated) {
    if (deps.isWorkspaceVisible && !deps.isWorkspaceVisible(target.workspacePath, tabOptions)) {
      return { status: "unavailable", reason: "workspace-not-available" };
    }
    deps.addTab(target.workspacePath, tabOptions);
  }
  if (options?.signal?.aborted) return { status: "unavailable", reason: "navigation-cancelled" };
  // 任务归属已由 Host 的 AppControlService 校验；这里只提交既有 session 选中。
  deps.setActiveTaskId(target.workspacePath, target.taskId, target.workspaceIdentity);
  return { status: "opened" };
}
