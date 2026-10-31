import { useCallback } from "react";
import type {
  ProjectDirectories,
  ProjectTaskRef,
  SaveProjectInput,
  VirtualProject,
} from "./contract.js";
import { useServices } from "@/hooks/useServices.js";
import { splitRoots } from "./view.js";

/**
 * 只发 ProjectService 命令并在提交后重读 Host 树；不乐观写项目/任务行。
 * 调用方在 await 后向 readTree owner 验证 token 再关闭编辑器；refresh 也在 IO 前验票。
 */
export function useProjectSidebarCommands(refresh: () => Promise<void>) {
  const service = useServices().projectService;

  const run = useCallback(
    async <T>(action: () => Promise<T>): Promise<T> => {
      if (!service) throw new Error("project.service-unavailable");
      const result = await action();
      await refresh();
      return result;
    },
    [refresh, service],
  );

  const saveProject = useCallback(
    (input: SaveProjectInput) => run(() => service!.saveProject(input)),
    [run, service],
  );

  const deleteProject = useCallback(
    (id: string, hostId?: string) => run(() => service!.deleteProject(id, hostId)),
    [run, service],
  );

  const reorderProjects = useCallback(
    (ids: string[]) => run(() => service!.reorderProjects(ids)),
    [run, service],
  );

  const moveTask = useCallback(
    (input: { task: ProjectTaskRef; projectId: string; addMissingRoot?: boolean }) =>
      run(() => service!.moveTask(input)),
    [run, service],
  );

  const prepareSession = useCallback(
    (projectId?: string): Promise<ProjectDirectories> => {
      if (!service) return Promise.reject(new Error("project.service-unavailable"));
      return service.prepareSession(projectId ? { projectId } : {});
    },
    [service],
  );

  const togglePinned = useCallback(
    (project: VirtualProject) =>
      saveProject({ id: project.id, hostId: project.hostId, pinned: !project.pinned }),
    [saveProject],
  );

  /** 恢复必须显式提交原 roots/primary；服务端再次校验 exact match。 */
  const restoreProject = useCallback(
    (project: VirtualProject) => {
      const { roots, primaryRoot } = splitRoots(project);
      return saveProject({
        restoreProjectId: project.id,
        hostId: project.hostId,
        roots,
        ...(primaryRoot ? { primaryRoot } : {}),
      });
    },
    [saveProject],
  );

  return {
    supported: Boolean(service),
    saveProject,
    deleteProject,
    reorderProjects,
    moveTask,
    prepareSession,
    togglePinned,
    restoreProject,
  };
}

export type ProjectSidebarCommands = ReturnType<typeof useProjectSidebarCommands>;
