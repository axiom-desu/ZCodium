import { useCallback } from "react";
import type {
  ProjectTaskGroup,
  ProjectTaskGroupColor,
  ProjectTaskGroupMoveInput,
} from "./contract.js";
import { useServices } from "@/hooks/useServices.js";

/** 分组写操作复用既有 zcodeTaskService；成功后只重读同一棵 Host 树。 */
export function useProjectGroupCommands(refresh: () => Promise<void>) {
  const services = useServices();
  const service = services.zcodeTaskService;
  const projectService = services.projectService;

  const run = useCallback(
    async <T>(action: () => Promise<T>): Promise<T> => {
      if (!service) throw new Error("task-group.service-unavailable");
      const result = await action();
      await refresh();
      return result;
    },
    [refresh, service],
  );

  const createGroup = useCallback(
    () => run(() => service!.createTaskGroup()) as Promise<ProjectTaskGroup>,
    [run, service],
  );
  const renameGroup = useCallback(
    (groupId: string, title: string) =>
      run(() => service!.renameTaskGroup({ groupId, title })) as Promise<ProjectTaskGroup>,
    [run, service],
  );
  const updateGroupColor = useCallback(
    (groupId: string, color: ProjectTaskGroupColor) =>
      run(() => service!.updateTaskGroupColor({ groupId, color })) as Promise<ProjectTaskGroup>,
    [run, service],
  );
  const deleteGroup = useCallback(
    (groupId: string) => run(() => service!.deleteTaskGroup({ groupId })),
    [run, service],
  );
  const moveGroupNode = useCallback(
    async (input: ProjectTaskGroupMoveInput) => {
      if (!projectService) throw new Error("task-group.service-unavailable");
      await projectService.moveTaskGroupNode(input);
      await refresh();
    },
    [projectService, refresh],
  );

  return {
    supported: Boolean(service),
    createGroup,
    renameGroup,
    updateGroupColor,
    deleteGroup,
    moveGroupNode,
  };
}
