import { createContext, useContext } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { ProjectTree, VirtualProject, ProjectSidebarWorkspaceRef } from "./contract.js";

/** 模块内部投影；legacy workspace 行通过它过滤已被项目行接管的 tab/task。 */
interface ProjectSidebarTreeContextValue {
  tree: ProjectTree | null;
  projects: VirtualProject[];
  isWorkspaceCoveredByProject(tab: ProjectSidebarWorkspaceRef): boolean;
  isTaskOwnedByProject(
    task: Pick<ZCodeTaskMeta, "workspacePath" | "workspaceIdentity" | "taskId">,
  ): boolean;
}

const ProjectSidebarTreeContext = createContext<ProjectSidebarTreeContextValue | null>(null);

export const ProjectSidebarTreeProvider = ProjectSidebarTreeContext.Provider;

/** WorkspaceSidebar 的 legacy 行只读取该投影；没有 Provider 时保持旧渲染路径。 */
export function useProjectSidebarTreeContext(): ProjectSidebarTreeContextValue | null {
  return useContext(ProjectSidebarTreeContext);
}
