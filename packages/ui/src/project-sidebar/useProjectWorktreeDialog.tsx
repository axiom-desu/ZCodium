import { useState } from "react";
import type { VirtualProject } from "./contract.js";
import { ProjectWorktreeDialog } from "./ProjectWorktreeDialog.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useRemoteProjectsDialog } from "./useRemoteProjectsDialog.js";

/**
 * 项目侧栏的 worktree 入口 owner：只持有"当前打开的项目"这一 UI 状态。
 * 能力缺失时 canManage=false，菜单项不渲染（远端/手机/旧 Host 默认拒绝）。
 */
export function useProjectWorktreeDialog(
  onSelectTask: (
    workspacePath: string,
    taskId: string,
    workspaceIdentity?: string,
    remoteSessionId?: string,
  ) => void,
  onChanged: () => Promise<void>,
) {
  const services = useOptionalServices();
  const [project, setProject] = useState<VirtualProject | null>(null);
  const remote = useRemoteProjectsDialog();
  const canManage = Boolean(services?.managedWorktreeService);
  const worktree = project ? (
    <ProjectWorktreeDialog
      open
      project={project}
      onClose={() => setProject(null)}
      onSelectTask={(workspacePath, taskId) =>
        onSelectTask(workspacePath, taskId, undefined, undefined)
      }
      onChanged={onChanged}
    />
  ) : null;
  return {
    canManage,
    canManageRemote: remote.canManage,
    openFor: setProject,
    openRemote: remote.open,
    element: (
      <>
        {worktree}
        {remote.element}
      </>
    ),
  };
}
