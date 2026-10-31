import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Hash, Pencil, Plus, Trash2 } from "lucide-react";
import type {
  ProjectTask,
  ProjectTaskGroupColor,
  ProjectTaskGroupStructure,
  ProjectTree,
} from "./contract.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { toast } from "@/components/ui/toast.js";
import { cn } from "@/components/lib/utils.js";
import { useProjectSidebarIntl } from "./i18n.js";
import { ProjectTaskRow } from "./ProjectTaskRow.js";
import { ProjectGroupedTaskItem } from "./ProjectGroupedTaskItem.js";
import {
  buildProjectGroupedRows,
  countTasksByGroup,
  moveProjectGroupedTask,
  projectGroupTaskKey,
} from "./grouped.js";
import { buildProjectGroupedMoveCommand, collapseProjectGroupedRows } from "./grouped-drag.js";
import { ProjectGroupedDragOverlay } from "./ProjectGroupedDragOverlay.js";
import { useProjectGroupCommands } from "./useProjectGroupCommands.js";
import { useProjectGroupedDrag } from "./useProjectGroupedDrag.js";
import { GROUP_COLOR_CLASS, TASK_GROUP_COLORS } from "./grouped-colors.js";

/** 分组视图只接收 ProjectSidebarSection 已过滤的同一棵树行；不自行订阅或补事实。 */
export function ProjectGroupedView({
  tree,
  structure,
  tasks,
  pinnedTasks,
  collapsed,
  onToggleCollapsed,
  refresh,
  onSelectTask,
  legacyReadOnly,
}: {
  tree: ProjectTree;
  structure: ProjectTaskGroupStructure | undefined;
  tasks: readonly ProjectTask[];
  pinnedTasks: readonly ProjectTask[];
  collapsed: ReadonlySet<string>;
  onToggleCollapsed: (groupId: string) => void;
  refresh: () => Promise<void>;
  onSelectTask: (task: ProjectTask) => void;
  legacyReadOnly: (task: ProjectTask) => boolean;
}) {
  const intl = useProjectSidebarIntl();
  const commands = useProjectGroupCommands(refresh);
  const report = (cause: unknown) => {
    toast(
      intl.formatMessage(
        { id: "projectSidebar.actionFailed" },
        { error: cause instanceof Error ? cause.message : String(cause) },
      ),
    );
  };
  const rows = useMemo(
    () => buildProjectGroupedRows(tasks, structure, collapsed),
    [collapsed, structure, tasks],
  );
  // 菜单移动使用未折叠的完整可见行，避免收起组时把组内任务从排序输入里漏掉。
  const allRows = useMemo(
    () => buildProjectGroupedRows(tasks, structure, new Set()),
    [structure, tasks],
  );
  const drag = useProjectGroupedDrag({
    rows: allRows,
    epoch: commands.moveGroupNode,
    onMove: commands.moveGroupNode,
    onError: report,
  });
  // hover 只改变本组件的临时行序；Esc/取消丢弃，drop 后才提交一条单节点命令。
  const displayRows = useMemo(
    () => collapseProjectGroupedRows(drag.preview ?? rows, collapsed),
    [collapsed, drag.preview, rows],
  );
  const counts = useMemo(() => countTasksByGroup(displayRows), [displayRows]);
  const groups = structure?.groups ?? [];
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!renamingGroupId) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renamingGroupId]);

  const createGroup = () => {
    if (busy) return;
    setBusy(true);
    void commands
      .createGroup()
      .then((group) => {
        setRenamingGroupId(group.id);
        setRenameDraft(group.title === "New Group" ? "" : group.title);
      })
      .catch(report)
      .finally(() => setBusy(false));
  };

  const moveTask = (task: ProjectTask, targetGroupId: string | null) => {
    const source = {
      type: "task" as const,
      rowKey: `task:${projectGroupTaskKey(task)}`,
    };
    const nextRows = moveProjectGroupedTask(allRows, task, targetGroupId);
    const command = buildProjectGroupedMoveCommand(allRows, nextRows, source);
    // 菜单移动与指针拖拽走同一单节点命令，不再提交可见快照覆盖不可见成员。
    if (!command) return;
    void commands.moveGroupNode(command).catch(report);
  };

  const submitRename = (groupId: string) => {
    const title = renameDraft.trim();
    setRenamingGroupId(null);
    if (!title) return;
    void commands.renameGroup(groupId, title).catch(report);
  };

  return (
    <div
      className="flex flex-col gap-1"
      data-testid="project-grouped-view"
      onPointerDown={drag.handlePointerDown}
      onClickCapture={drag.handleClickCapture}
      onDragStartCapture={drag.handleNativeDragStart}
    >
      {pinnedTasks.length > 0 ? (
        <section data-testid="project-grouped-pinned">
          <h3 className="px-2.5 py-1 text-ui-base font-medium text-foreground-subtlest">
            {intl.formatMessage({ id: "projectSidebar.pinnedTasks" })}
          </h3>
          {pinnedTasks.map((task) => (
            <ProjectTaskRow
              key={projectGroupTaskKey(task)}
              task={task}
              refresh={refresh}
              legacyReadOnly={legacyReadOnly(task)}
              onSelect={onSelectTask}
            />
          ))}
        </section>
      ) : null}

      <div className="flex min-w-0 items-center justify-between px-2.5 py-1">
        <span className="text-ui-sm font-medium text-foreground-subtlest">
          {intl.formatMessage({ id: "projectSidebar.groupsTitle" })}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          data-testid="project-group-create"
          aria-label={intl.formatMessage({ id: "projectSidebar.newGroup" })}
          disabled={!commands.supported || busy}
          onClick={createGroup}
        >
          <Plus className="size-3.5" />
        </Button>
      </div>

      {displayRows.length === 0 ? (
        <p className="px-3 py-2 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "projectSidebar.emptyGrouped" })}
        </p>
      ) : null}

      {displayRows.map((row) => {
        if (row.type === "task") {
          const taskDropTarget =
            drag.dropTarget?.zone === "task" && drag.dropTarget.rowKey === row.key
              ? drag.dropTarget
              : null;
          return (
            <ProjectGroupedTaskItem
              key={row.key}
              row={row}
              groups={groups}
              dropSide={taskDropTarget?.side ?? null}
              refresh={refresh}
              onSelectTask={onSelectTask}
              legacyReadOnly={legacyReadOnly(row.task)}
              onMoveTask={moveTask}
            />
          );
        }
        if (row.type === "empty") {
          const emptyDropActive =
            drag.dropTarget?.zone === "group-empty" && drag.dropTarget.groupId === row.groupId;
          return (
            <p
              key={row.key}
              data-project-grouped-drop="group-empty"
              data-project-grouped-group-id={row.groupId}
              className={cn(
                "relative pl-6 pr-2 py-1 text-ui-sm text-foreground-subtlest",
                emptyDropActive && "rounded-md bg-primary/10 text-foreground",
              )}
            >
              {intl.formatMessage({ id: "projectSidebar.emptyGroupTasks" })}
            </p>
          );
        }
        const group = row.group;
        const isCollapsed = collapsed.has(group.id);
        const groupDropTarget =
          drag.dropTarget?.zone === "group-header" && drag.dropTarget.groupId === group.id
            ? drag.dropTarget
            : null;
        const groupDropActive = groupDropTarget !== null;
        return (
          <section key={row.key} data-testid="project-group" data-project-group-id={group.id}>
            <div
              data-project-grouped-drag="group"
              data-project-grouped-group-id={group.id}
              data-project-grouped-drop="group-header"
              className="group relative flex h-8 min-w-0 items-center gap-1 rounded-lg px-1.5 hover:bg-surface-hover focus-within:bg-surface-hover"
            >
              {groupDropActive ? (
                <div
                  data-testid="project-grouped-drop-indicator"
                  className={cn(
                    "pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-primary",
                    groupDropTarget?.side === "before" ? "top-0" : "bottom-0",
                  )}
                />
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                data-testid="project-group-toggle"
                aria-label={intl.formatMessage({
                  id: isCollapsed ? "projectSidebar.expand" : "projectSidebar.collapse",
                })}
                aria-expanded={!isCollapsed}
                onClick={() => onToggleCollapsed(group.id)}
              >
                {isCollapsed ? (
                  <ChevronRight className="size-3.5" />
                ) : (
                  <ChevronDown className="size-3.5" />
                )}
              </Button>
              <span
                className={cn("size-2 shrink-0 rounded-full", GROUP_COLOR_CLASS[group.color])}
              />
              {renamingGroupId === group.id ? (
                <input
                  ref={renameInputRef}
                  data-testid="project-group-rename-input"
                  value={renameDraft}
                  onChange={(event) => setRenameDraft(event.target.value)}
                  onBlur={() => submitRename(group.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") submitRename(group.id);
                    if (event.key === "Escape") setRenamingGroupId(null);
                  }}
                  className="min-w-0 flex-1 rounded-sm bg-surface px-1 text-ui-base text-foreground outline-none ring-1 ring-input-border-focused"
                />
              ) : (
                <button
                  type="button"
                  data-project-grouped-drag-allowed=""
                  className="min-w-0 flex-1 truncate text-left text-ui-base text-foreground"
                  onClick={() => onToggleCollapsed(group.id)}
                >
                  {group.title}
                </button>
              )}
              <span className="inline-flex min-w-5 shrink-0 items-center justify-center rounded-full bg-tag/50 px-1.5 py-0.5 text-ui-sm leading-none text-foreground-subtle">
                {counts.get(group.id) ?? 0}
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    data-testid="project-group-menu"
                    aria-label={intl.formatMessage({ id: "projectSidebar.groupMenu" })}
                    className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-44">
                  <DropdownMenuItem
                    disabled={!commands.supported}
                    onSelect={() => {
                      setRenamingGroupId(group.id);
                      setRenameDraft(group.title);
                    }}
                  >
                    <Pencil className="size-3.5" />
                    {intl.formatMessage({ id: "projectSidebar.renameGroup" })}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel>
                    {intl.formatMessage({ id: "projectSidebar.groupColor" })}
                  </DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={group.color}
                    onValueChange={(value) => {
                      if (!TASK_GROUP_COLORS.includes(value as ProjectTaskGroupColor)) return;
                      void commands
                        .updateGroupColor(group.id, value as ProjectTaskGroupColor)
                        .catch(report);
                    }}
                  >
                    {TASK_GROUP_COLORS.map((color) => (
                      <DropdownMenuRadioItem key={color} value={color}>
                        <span className={cn("size-2 rounded-full", GROUP_COLOR_CLASS[color])} />
                        {intl.formatMessage({ id: `taskGroup.color.${color}` })}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={!commands.supported}
                    onSelect={() => void commands.deleteGroup(group.id).catch(report)}
                  >
                    <Trash2 className="size-3.5 text-destructive" />
                    <span className="text-destructive">
                      {intl.formatMessage({ id: "projectSidebar.ungroup" })}
                    </span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </section>
        );
      })}
      {tree.tasks.length === 0 ? null : (
        <div className="flex items-center gap-1 px-2.5 py-1 text-ui-sm text-foreground-subtlest">
          <Hash className="size-3" />
          {intl.formatMessage({ id: "projectSidebar.groupsHint" })}
        </div>
      )}
      {drag.overlay ? (
        <ProjectGroupedDragOverlay
          source={drag.overlay.source}
          x={drag.overlay.x}
          y={drag.overlay.y}
          rows={allRows}
        />
      ) : null}
    </div>
  );
}
