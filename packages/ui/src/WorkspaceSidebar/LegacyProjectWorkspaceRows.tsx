import { useMemo } from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragCancelEvent,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import type { RemoteConnectionLogEntry } from "@/hooks/useRemoteConnectionLogs.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { TID_WORKSPACE_LIST, type ZCodeTaskMeta } from "@zcode/shared";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import {
  SortableWorkspaceSidebarItem,
  restrictVerticalDragWithinContainer,
} from "@/SortableWorkspaceSidebar.js";
import { useProjectSidebarTreeContext } from "@/project-sidebar/index.js";
import { WorkspaceDragOverlay } from "@/WorkspaceSidebar/WorkspaceDragOverlay.js";
import {
  resolveWorkspaceDragExpanded,
  workspaceVerticalListSortingStrategy,
} from "@/lib/workspaceSidebarDrag.js";

const EMPTY_WORKSPACE_TASK_ITEMS: ZCodeTaskMeta[] = [];
const EMPTY_RECONNECTING_LOGS: Record<string, RemoteConnectionLogEntry[]> = {};

interface WorkspaceTaskGroupView {
  items: ZCodeTaskMeta[];
  hasMore: boolean;
  hasUnread: boolean;
  liveWorkflowCount: number;
}

/**
 * legacy workspace 行仍由 WorkspaceSidebar 装配。这里只按项目树事实过滤：
 * 已被项目 root 接管的 tab 让位给项目行；项目内任务不再在旧行重复出现。
 */
export function LegacyProjectWorkspaceRows({
  workspaceTabs,
  workspacePath,
  expandedWorkspacePaths,
  workspaceTaskGroupByKey,
  workspaceTaskLoadingByKey,
  activeWorkspaceDragId,
  activeWorkspaceDragWidth,
  activateTab,
  closeTab,
  toggleWorkspaceExpanded,
  onSelectTask,
  onStartDraftInWorkspace,
  onShowMoreWorkspaceTasks,
  reconnectingRemoteWorkspaceKeys,
  remoteWorkspaceErrorByWorkspaceKey,
  reconnectingRemoteWorkspaceLogsByWorkspaceKey = EMPTY_RECONNECTING_LOGS,
  onReconnectRemoteWorkspace,
  onOpenFileTree,
  onDragStart,
  onDragEnd,
  onDragCancel,
}: {
  workspaceTabs: WorkspaceTabState[];
  workspacePath: string;
  expandedWorkspacePaths: Set<string>;
  workspaceTaskGroupByKey: ReadonlyMap<string, WorkspaceTaskGroupView>;
  workspaceTaskLoadingByKey: Record<string, boolean>;
  activeWorkspaceDragId: string | null;
  activeWorkspaceDragWidth: number | null;
  activateTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  toggleWorkspaceExpanded: (path: string) => void;
  onSelectTask: (
    workspacePath: string,
    taskId: string,
    workspaceIdentity?: string,
    remoteSessionId?: string,
    expectedUnreadAt?: number,
  ) => void;
  onStartDraftInWorkspace: (workspacePath: string, workspaceIdentity?: string) => void;
  onShowMoreWorkspaceTasks: (workspaceKey: string) => void;
  reconnectingRemoteWorkspaceKeys: string[];
  remoteWorkspaceErrorByWorkspaceKey: Record<string, string>;
  reconnectingRemoteWorkspaceLogsByWorkspaceKey?: Record<string, RemoteConnectionLogEntry[]>;
  onReconnectRemoteWorkspace: (workspaceKey: string) => Promise<void>;
  onOpenFileTree: (target: {
    workspacePath: string;
    workspaceName: string;
    workspaceIdentity?: string;
    workspaceRemoteSessionId?: string;
    revealPath?: string;
    temporaryExternalDirectory?: boolean;
  }) => void;
  onDragStart: (event: DragStartEvent) => void;
  onDragEnd: (event: DragEndEvent) => void;
  onDragCancel: (event: DragCancelEvent) => void;
}) {
  const facts = useProjectSidebarTreeContext();
  const tabs = useMemo(
    () =>
      facts
        ? workspaceTabs.filter((tab) => !facts.isWorkspaceCoveredByProject(tab))
        : workspaceTabs,
    [facts, workspaceTabs],
  );
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const activeTab = useMemo(
    () =>
      activeWorkspaceDragId ? (tabs.find((tab) => tab.id === activeWorkspaceDragId) ?? null) : null,
    [activeWorkspaceDragId, tabs],
  );
  if (tabs.length === 0) {
    return null;
  }
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictVerticalDragWithinContainer]}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      <SortableContext
        items={tabs.map((tab) => tab.id)}
        strategy={workspaceVerticalListSortingStrategy}
      >
        <ul data-testid={TID_WORKSPACE_LIST} className="space-y-2 pb-4">
          {tabs.map((tab) => {
            const workspaceKey = buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity);
            const group = workspaceTaskGroupByKey.get(workspaceKey);
            const items = (group?.items ?? EMPTY_WORKSPACE_TASK_ITEMS).filter(
              (task) => !facts?.isTaskOwnedByProject(task),
            );
            return (
              <SortableWorkspaceSidebarItem
                key={tab.id}
                tab={tab}
                isActiveWorkspace={tab.workspacePath === workspacePath}
                isExpanded={resolveWorkspaceDragExpanded({
                  activeDragId: activeWorkspaceDragId,
                  expanded: expandedWorkspacePaths.has(tab.workspacePath),
                  tabId: tab.id,
                })}
                activateTab={activateTab}
                closeTab={closeTab}
                toggleWorkspaceExpanded={toggleWorkspaceExpanded}
                onSelectTask={onSelectTask}
                onStartDraftInWorkspace={onStartDraftInWorkspace}
                taskItems={items}
                taskListLoading={workspaceTaskLoadingByKey[workspaceKey] ?? false}
                taskListHasMore={group?.hasMore ?? false}
                taskListHasUnread={group?.hasUnread ?? false}
                taskListLiveWorkflowCount={group?.liveWorkflowCount ?? 0}
                workspaceKey={workspaceKey}
                onShowMoreWorkspaceTasks={onShowMoreWorkspaceTasks}
                reconnectingRemoteWorkspaceKeys={reconnectingRemoteWorkspaceKeys}
                remoteWorkspaceErrorByWorkspaceKey={remoteWorkspaceErrorByWorkspaceKey}
                reconnectingRemoteWorkspaceLogsByWorkspaceKey={
                  reconnectingRemoteWorkspaceLogsByWorkspaceKey
                }
                onReconnectRemoteWorkspace={onReconnectRemoteWorkspace}
                onOpenFileTree={onOpenFileTree}
              />
            );
          })}
        </ul>
      </SortableContext>
      {typeof document === "undefined"
        ? null
        : createPortal(
            <DragOverlay>
              {activeTab ? (
                <WorkspaceDragOverlay tab={activeTab} width={activeWorkspaceDragWidth} />
              ) : null}
            </DragOverlay>,
            document.body,
          )}
    </DndContext>
  );
}
