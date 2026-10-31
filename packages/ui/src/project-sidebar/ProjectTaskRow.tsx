import { memo } from "react";
import type { ProjectTask } from "./contract.js";
import { TaskList } from "@/TaskList.js";
import { useZCodeSessionStore, selectWorkspaceZCodeState } from "@/store/zcodeSessionStore.js";
import { useProjectSidebarIntl } from "./i18n.js";
import { useProjectTaskActions } from "./useProjectTaskActions.js";

const NO_PINNED: ProjectTask[] = [];

/**
 * 每个任务行复用既有 TaskList（含 rename/pin/archive/unread and context menu）。
 * workspacePath 必须取任务自身：项目多 root 时不能用项目主目录代替。
 */
export const ProjectTaskRow = memo(function ProjectTaskRow({
  task,
  onSelect,
  refresh,
  legacyReadOnly,
}: {
  task: ProjectTask;
  onSelect: (task: ProjectTask) => void;
  refresh: () => Promise<void>;
  legacyReadOnly: boolean;
}) {
  const intl = useProjectSidebarIntl();
  const actions = useProjectTaskActions(task, refresh);
  const activeTaskId = useZCodeSessionStore(
    (state) =>
      selectWorkspaceZCodeState(state, task.workspacePath, task.workspaceIdentity).activeTaskId,
  );
  const tasks = [task];
  return (
    <TaskList
      workspacePath={task.workspacePath}
      workspaceIdentity={task.workspaceIdentity}
      tasks={tasks}
      pinnedTasks={NO_PINNED}
      activeTaskId={activeTaskId}
      onSelectTask={() => onSelect(task)}
      showCreateButton={false}
      showFooter={false}
      showEmptyState={false}
      sortBy="updated"
      onRenameTask={actions.rename}
      onSetTaskPinned={actions.pin}
      onArchiveTask={actions.archive}
      onSetTaskUnread={actions.unread}
      readOnlyReason={
        legacyReadOnly ? intl.formatMessage({ id: "projectSidebar.legacyReadOnly" }) : undefined
      }
    />
  );
});
