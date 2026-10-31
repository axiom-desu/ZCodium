import { useCallback, useMemo } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { ProjectTask } from "./contract.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { toast } from "@/components/ui/toast.js";
import { useProjectSidebarIntl } from "./i18n.js";

/** 任务行复用既有 TaskService 命令；项目树只负责在提交后重读真实行。 */
export function useProjectTaskActions(task: ProjectTask, refresh: () => Promise<void>) {
  const services = useServices();
  const removeTaskState = useZCodeSessionStore((state) => state.removeTaskState);
  const intl = useProjectSidebarIntl();
  const scope = useMemo(
    () => ({
      taskId: task.taskId,
      workspacePath: task.workspacePath,
      ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
    }),
    [task.taskId, task.workspaceIdentity, task.workspacePath],
  );

  const report = useCallback(
    (cause: unknown) => {
      toast(
        intl.formatMessage(
          { id: "projectSidebar.actionFailed" },
          { error: cause instanceof Error ? cause.message : String(cause) },
        ),
      );
    },
    [intl],
  );

  return useMemo(
    () => ({
      rename: async (taskId: string, title: string): Promise<ZCodeTaskMeta | null> => {
        try {
          const meta = await services.zcodeTaskService.renameTask({ ...scope, taskId, title });
          await refresh();
          return meta;
        } catch (cause) {
          report(cause);
          return null;
        }
      },
      pin: async (taskId: string, pinned: boolean): Promise<ZCodeTaskMeta | null> => {
        try {
          const meta = await services.zcodeTaskService.setTaskPinned({ ...scope, taskId, pinned });
          await refresh();
          return meta;
        } catch (cause) {
          report(cause);
          return null;
        }
      },
      archive: async (taskId: string): Promise<ZCodeTaskMeta | null> => {
        try {
          const meta = await services.zcodeTaskService.archiveTask({ ...scope, taskId });
          // 与既有归档语义一致：同 Host + workspaceKey + taskId 的当前详情退出，
          // 不自动跳到下一条任务；项目树刷新后行消失。
          removeTaskState(task.workspacePath, taskId, task.workspaceIdentity);
          await refresh();
          return meta;
        } catch (cause) {
          report(cause);
          return null;
        }
      },
      unread: async (taskId: string, unread: boolean): Promise<ZCodeTaskMeta | null> => {
        try {
          const meta = await services.zcodeTaskService.setTaskUnread({ ...scope, taskId, unread });
          await refresh();
          return meta;
        } catch (cause) {
          report(cause);
          return null;
        }
      },
      unarchive: async (taskId: string): Promise<ZCodeTaskMeta | null> => {
        try {
          const meta = await services.zcodeTaskService.unarchiveTask({ ...scope, taskId });
          await refresh();
          return meta;
        } catch (cause) {
          report(cause);
          return null;
        }
      },
      remove: async (taskId: string): Promise<void> => {
        try {
          await services.zcodeTaskService.deleteTask({ ...scope, taskId });
          await refresh();
        } catch (cause) {
          report(cause);
        }
      },
    }),
    [
      refresh,
      removeTaskState,
      report,
      scope,
      services.zcodeTaskService,
      task.workspaceIdentity,
      task.workspacePath,
    ],
  );
}
