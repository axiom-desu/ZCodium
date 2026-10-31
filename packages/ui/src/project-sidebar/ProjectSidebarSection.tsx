import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type {
  ProjectSidebarSectionProps,
  ProjectSidebarWorkspaceRef,
  ProjectTask,
  VirtualProject,
} from "./contract.js";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useProjectSidebarIntl } from "./i18n.js";
import { ProjectArchiveView } from "./ProjectArchiveView.js";
import { ProjectEditorDialog } from "./ProjectEditorDialog.js";
import { ProjectGroupedView } from "./ProjectGroupedView.js";
import { ProjectMoveTaskDialog } from "./ProjectMoveTaskDialog.js";
import { ProjectRestoreDialog } from "./ProjectRestoreDialog.js";
import { ProjectRow } from "./ProjectRow.js";
import { ProjectSidebarTreeProvider } from "./ProjectSidebarContext.js";
import { ProjectTaskRow } from "./ProjectTaskRow.js";
import { ProjectTimelineView } from "./ProjectTimelineView.js";
import { ProjectViewTabs } from "./ProjectViewTabs.js";
import { useProjectSidebarCommands } from "./useProjectSidebarCommands.js";
import { useProjectSidebarData } from "./useProjectSidebarData.js";
import { useProjectSidebarPreferences } from "./useProjectSidebarPreferences.js";
import {
  buildProjectRowModels,
  countProjectTreeUnreadTasks,
  filterLegacyWorkspaceTabs,
  isProjectLegacyReadOnly,
  isProjectPrimaryRootMissing,
  isTaskInLegacyReadOnlyProject,
  projectTaskKey,
  reorderProjectIds,
  projectTaskWorkspaceKey,
  selectDeletedProjects,
  selectProjectRows,
  selectTimelineTasks,
  selectUnassignedTasks,
  selectVisibleProjects,
} from "./view.js";

/**
 * 既有 projects 分区内的项目视图。行事实只来自 readTree；编辑器/信任/移动草稿归本模块，
 * legacy workspace 行由外壳通过 children 继续渲染。
 */
export function ProjectSidebarSection({
  activeWorkspacePath,
  activeWorkspaceIdentity,
  onSelectTask,
  onCreateTask,
  onOpenFileTree,
  children,
  legacyWorkspaceTabs = [],
  actionRequest,
  onActionHandled,
  onUnreadTaskCountChange,
  onViewModeChange,
}: ProjectSidebarSectionProps) {
  const intl = useProjectSidebarIntl();
  const data = useProjectSidebarData({
    workspacePath: activeWorkspacePath,
    workspaceIdentity: activeWorkspaceIdentity,
  });
  const commands = useProjectSidebarCommands(data.refresh);
  const tree = data.tree;
  const projects = useMemo(() => (tree ? selectVisibleProjects(tree) : []), [tree]);
  const deletedProjects = useMemo(() => (tree ? selectDeletedProjects(tree) : []), [tree]);
  const { expandedKeys, toggle, view, setView } = useProjectSidebarPreferences(projects);
  const rows = useMemo(
    () => (tree ? buildProjectRowModels(tree, expandedKeys) : []),
    [expandedKeys, tree],
  );
  const legacyTabs = useMemo(
    () => filterLegacyWorkspaceTabs(legacyWorkspaceTabs, projects),
    [legacyWorkspaceTabs, projects],
  );
  const legacyKeys = useMemo(() => new Set(legacyTabs.map(projectTaskWorkspaceKey)), [legacyTabs]);
  const unassignedTasks = useMemo(
    () => (tree ? selectUnassignedTasks(tree, legacyKeys) : []),
    [legacyKeys, tree],
  );
  // 旧 workspace 行仍在 children 里渲染自己的任务；树视图排除这些已知行，
  // 既不让同一任务出现两次，也不丢没有 legacy 行的未归类任务。
  const groupedTasks = useMemo(
    () => (tree ? tree.tasks.filter((task) => !legacyKeys.has(projectTaskWorkspaceKey(task))) : []),
    [legacyKeys, tree],
  );
  const groupedPinnedTasks = useMemo(
    () => groupedTasks.filter((task) => task.pinned && !task.archived),
    [groupedTasks],
  );
  const timelineTasks = useMemo(
    () => (tree ? selectTimelineTasks(tree, legacyKeys) : []),
    [legacyKeys, tree],
  );
  const taskLegacyReadOnly = (task: ProjectTask) =>
    tree ? isTaskInLegacyReadOnlyProject(tree, task) : false;
  const unreadTaskCount = useMemo(() => (tree ? countProjectTreeUnreadTasks(tree) : 0), [tree]);

  useEffect(() => {
    onViewModeChange?.(view);
  }, [onViewModeChange, view]);

  useEffect(() => {
    // 只上报权威树派生计数；刷新失败时 data.tree 保持上一份成功快照，
    // 不因临时错误把角标清零。宿主负责写平台角标，Sidebar 不持有第二份未读事实。
    onUnreadTaskCountChange?.(unreadTaskCount);
  }, [onUnreadTaskCountChange, unreadTaskCount]);
  const [editor, setEditor] = useState<{
    project?: VirtualProject;
    deletePending?: boolean;
  } | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [moveProject, setMoveProject] = useState<VirtualProject | null>(null);
  const [busyProjectId, setBusyProjectId] = useState<string | null>(null);
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const handledActionIdRef = useRef<number | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const notifyActionFailed = useCallback(
    (cause: unknown) => {
      if (!data.isCurrentToken(data.token)) return;
      toast(
        intl.formatMessage(
          { id: "projectSidebar.actionFailed" },
          {
            error: cause instanceof Error ? cause.message : String(cause),
          },
        ),
      );
    },
    [data.token, data.isCurrentToken, intl],
  );

  useEffect(() => {
    // scope/服务换代都撤销旧编辑器；迟到回包由 readTree owner token 另行拒绝。
    setEditor(null);
    setRestoreOpen(false);
    setMoveProject(null);
    setBusyProjectId(null);
    setCollapsedGroupKeys(new Set());
  }, [data.token]);

  useEffect(() => {
    if (!actionRequest || handledActionIdRef.current === actionRequest.id) return;
    handledActionIdRef.current = actionRequest.id;
    if (actionRequest.type === "create") {
      setEditor({});
    } else {
      setRestoreOpen(true);
    }
    onActionHandled?.(actionRequest);
  }, [actionRequest, onActionHandled]);

  const toggleGroupCollapsed = useCallback((groupId: string) => {
    setCollapsedGroupKeys((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (!event.over || event.active.id === event.over.id) return;
      const ids = reorderProjectIds(projects, String(event.active.id), String(event.over.id));
      if (!ids) return;
      void commands.reorderProjects(ids).catch(notifyActionFailed);
    },
    [commands, notifyActionFailed, projects],
  );

  const selectTask = useCallback(
    (task: ProjectTask) => {
      onSelectTask(
        task.workspacePath,
        task.taskId,
        task.workspaceIdentity,
        undefined,
        task.unreadAt,
      );
    },
    [onSelectTask],
  );

  const createTask = useCallback(
    async (project: VirtualProject) => {
      if (
        !data.isCurrentToken(data.token) ||
        isProjectLegacyReadOnly(project) ||
        isProjectPrimaryRootMissing(project)
      )
        return;
      setBusyProjectId(project.id);
      const token = data.token;
      try {
        // 只校验/初始化真实 root；归属与冻结执行目录由 Host 预占在 createSession 前完成。
        const directories = await commands.prepareSession(project.id);
        // 等待期间切 workspace/profile/服务代际时，迟到回包不得落到新选择上。
        if (!data.isCurrentToken(token)) return;
        onCreateTask({
          workspacePath: directories.workspacePath,
          ...(directories.workspaceIdentity
            ? { workspaceIdentity: directories.workspaceIdentity }
            : {}),
          projectId: directories.projectId ?? project.id,
        });
      } catch (cause) {
        notifyActionFailed(cause);
      } finally {
        if (data.isCurrentToken(token)) setBusyProjectId(null);
      }
    },
    [commands, data.token, data.isCurrentToken, notifyActionFailed, onCreateTask],
  );

  const isTaskOwnedByProject = useCallback(
    (task: Pick<ZCodeTaskMeta, "workspacePath" | "workspaceIdentity" | "taskId">) => {
      if (!tree) return false;
      return tree.tasks.some(
        (candidate) =>
          candidate.projectId !== null && projectTaskKey(candidate) === projectTaskKey(task),
      );
    },
    [tree],
  );

  const contextValue = useMemo(
    () => ({
      tree,
      projects,
      isWorkspaceCoveredByProject: (tab: ProjectSidebarWorkspaceRef) => !legacyTabs.includes(tab),
      isTaskOwnedByProject,
    }),
    [isTaskOwnedByProject, legacyTabs, projects, tree],
  );

  if (!data.supported) {
    // 旧 Host 没有 Project channel：保持既有 workspace 行与所有面板不变。
    return <>{children}</>;
  }

  return (
    <ProjectSidebarTreeProvider value={contextValue}>
      <div className="flex flex-col gap-1.5" data-testid="project-sidebar-section">
        <ProjectViewTabs view={view} onChange={setView} />

        {data.error ? (
          <div className="flex items-center gap-2 px-3 py-1">
            <p role="alert" className="min-w-0 flex-1 text-ui-sm text-destructive">
              {intl.formatMessage({ id: "projectSidebar.loadError" })}: {data.error}
            </p>
            <Button type="button" variant="ghost" size="sm" onClick={() => void data.refresh()}>
              {intl.formatMessage({ id: "projectSidebar.retry" })}
            </Button>
          </div>
        ) : null}

        {view === "projects" &&
        rows.length === 0 &&
        unassignedTasks.length === 0 &&
        !data.loading ? (
          <p className="px-3 py-2 text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "projectSidebar.emptyProjects" })}
          </p>
        ) : null}

        {view === "projects" && rows.length > 0 ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={rows.map((row) => row.key)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="space-y-1" data-testid="project-list">
                {rows.map((row) => (
                  <ProjectRow
                    key={row.key}
                    project={row.project}
                    tasks={row.tasks}
                    expanded={row.expanded}
                    hasUnread={row.hasUnread}
                    legacyReadOnly={row.legacyReadOnly}
                    primaryRootMissing={row.primaryRootMissing}
                    canReorder={!row.legacyReadOnly}
                    refresh={data.refresh}
                    onToggleExpanded={() => toggle(row.key)}
                    onSelectTask={selectTask}
                    onEdit={() => setEditor({ project: row.project })}
                    onPin={() => void commands.togglePinned(row.project).catch(notifyActionFailed)}
                    onDelete={() => setEditor({ project: row.project, deletePending: true })}
                    onMoveTasks={() => setMoveProject(row.project)}
                    onNewTask={() => void createTask(row.project)}
                    onViewFiles={(rootPath) =>
                      onOpenFileTree?.({
                        workspacePath: rootPath,
                        workspaceName: row.project.name,
                      })
                    }
                    busy={busyProjectId === row.project.id}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        ) : null}

        {view === "projects" && unassignedTasks.length > 0 ? (
          <div className="flex flex-col gap-1 pt-1" data-testid="project-unassigned-tasks">
            <h3 className="px-2.5 text-ui-base font-medium text-foreground-subtlest">
              {intl.formatMessage({ id: "projectSidebar.unassignedTitle" })}
            </h3>
            {unassignedTasks.map((task) => (
              <ProjectTaskRow
                key={projectTaskKey(task)}
                task={task}
                refresh={data.refresh}
                legacyReadOnly={false}
                onSelect={selectTask}
              />
            ))}
          </div>
        ) : null}

        {view === "grouped" && tree ? (
          <ProjectGroupedView
            tree={tree}
            structure={tree.taskGroups}
            tasks={groupedTasks}
            pinnedTasks={groupedPinnedTasks}
            collapsed={collapsedGroupKeys}
            onToggleCollapsed={toggleGroupCollapsed}
            refresh={data.refresh}
            onSelectTask={selectTask}
            legacyReadOnly={taskLegacyReadOnly}
          />
        ) : view === "timeline" ? (
          <ProjectTimelineView
            tasks={timelineTasks}
            refresh={data.refresh}
            onSelectTask={selectTask}
            legacyReadOnly={taskLegacyReadOnly}
          />
        ) : view === "archive" && tree ? (
          <ProjectArchiveView tree={tree} refresh={data.refresh} />
        ) : null}

        {children}

        <ProjectEditorDialog
          open={editor !== null}
          project={editor?.project}
          initialDeletePending={editor?.deletePending}
          commands={commands}
          scope={data}
          onClose={() => setEditor(null)}
          onSaved={() => void data.refresh()}
        />
        <ProjectRestoreDialog
          open={restoreOpen}
          projects={deletedProjects}
          commands={commands}
          scope={data}
          onClose={() => setRestoreOpen(false)}
          onRestored={() => void data.refresh()}
        />
        {moveProject ? (
          <ProjectMoveTaskDialog
            open
            project={moveProject}
            projects={projects}
            tasks={
              tree
                ? selectProjectRows(tree, {
                    kind: "project",
                    projectId: moveProject.id,
                    hostId: moveProject.hostId,
                  })
                : []
            }
            commands={commands}
            scope={data}
            onClose={() => setMoveProject(null)}
          />
        ) : null}
      </div>
    </ProjectSidebarTreeProvider>
  );
}
