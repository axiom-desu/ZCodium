import { memo, useState } from "react";
import {
  Cloud,
  Folder,
  FolderOpen,
  Folders,
  GripVertical,
  Lock,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Trash2,
  FolderSearch,
  MoveRight,
  AlertTriangle,
} from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ProjectTask, VirtualProject } from "./contract.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { cn } from "@/components/lib/utils.js";
import { useProjectSidebarIntl } from "./i18n.js";
import { ProjectTaskRow } from "./ProjectTaskRow.js";

const PROJECT_TASK_PAGE_SIZE = 5;

function ProjectFolderIcon({ project, expanded }: { project: VirtualProject; expanded: boolean }) {
  const multi = project.roots.length > 1;
  if (project.legacySingleRoot) return <Cloud className="size-4 shrink-0 text-foreground-subtle" />;
  if (multi) {
    return <Folders className="size-4 shrink-0 text-foreground-subtle" />;
  }
  return expanded ? (
    <FolderOpen className="size-4 shrink-0 text-foreground-subtle" />
  ) : (
    <Folder className="size-4 shrink-0 text-foreground-subtle" />
  );
}

/** 项目行只消费 Host 行；展开偏好、分页和菜单状态属于本地 UI。 */
export const ProjectRow = memo(function ProjectRow({
  project,
  tasks,
  expanded,
  hasUnread,
  legacyReadOnly,
  primaryRootMissing,
  refresh,
  onToggleExpanded,
  onSelectTask,
  onEdit,
  onPin,
  onDelete,
  onMoveTasks,
  onNewTask,
  onViewFiles,
  canReorder,
  busy = false,
}: {
  project: VirtualProject;
  tasks: ProjectTask[];
  expanded: boolean;
  hasUnread: boolean;
  legacyReadOnly: boolean;
  primaryRootMissing: boolean;
  refresh: () => Promise<void>;
  onToggleExpanded: () => void;
  onSelectTask: (task: ProjectTask) => void;
  onEdit: () => void;
  onPin: () => void;
  onDelete: () => void;
  onMoveTasks: () => void;
  onNewTask: () => void;
  onViewFiles: (rootPath: string) => void;
  canReorder: boolean;
  busy?: boolean;
}) {
  const intl = useProjectSidebarIntl();
  const [limit, setLimit] = useState(PROJECT_TASK_PAGE_SIZE);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: JSON.stringify([project.hostId, project.id]),
    disabled: legacyReadOnly || !canReorder,
  });
  const visibleTasks = tasks.slice(0, limit);
  const createDisabled = legacyReadOnly || primaryRootMissing || busy;
  const createTitle = legacyReadOnly
    ? intl.formatMessage({ id: "projectSidebar.legacyReadOnlyHint" })
    : primaryRootMissing
      ? intl.formatMessage({ id: "projectSidebar.noPrimaryRoot" })
      : intl.formatMessage({ id: "projectSidebar.newTask" });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-project-id={project.id}
      data-project-name={project.name}
      data-testid="project-row"
      className={cn("list-none", isDragging && "opacity-60")}
    >
      <div
        {...attributes}
        {...listeners}
        className={cn(
          "group flex h-8 min-w-0 touch-manipulation items-center gap-1 rounded-lg px-1.5",
          "hover:bg-surface-hover focus-within:bg-surface-hover",
        )}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="shrink-0 cursor-grab text-foreground-subtlest opacity-0 group-hover:opacity-100 focus-visible:opacity-100 active:cursor-grabbing"
          aria-label={intl.formatMessage({
            id: expanded ? "projectSidebar.collapse" : "projectSidebar.expand",
          })}
          tabIndex={-1}
        >
          <GripVertical className="size-3.5" />
        </Button>
        <button
          type="button"
          data-testid="project-toggle"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          title={project.roots.map((root) => root.rootPath).join("\n") || project.name}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/30"
        >
          <ProjectFolderIcon project={project} expanded={expanded} />
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-ui-base",
              primaryRootMissing ? "text-foreground-subtlest" : "text-foreground",
            )}
          >
            {project.name}
          </span>
          {legacyReadOnly ? (
            <Lock className="size-3 shrink-0 text-foreground-subtlest" aria-hidden="true" />
          ) : null}
          {primaryRootMissing ? (
            <ControlHintTooltip title={intl.formatMessage({ id: "projectSidebar.noPrimaryRoot" })}>
              <AlertTriangle className="size-3.5 shrink-0 text-warning" />
            </ControlHintTooltip>
          ) : null}
          {hasUnread ? (
            <span
              data-testid="project-unread-dot"
              className="size-1.5 shrink-0 rounded-full bg-brand"
              aria-hidden="true"
            />
          ) : null}
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          <ControlHintTooltip title={createTitle}>
            <span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                data-testid="project-new-task"
                aria-label={intl.formatMessage({ id: "projectSidebar.newTask" })}
                disabled={createDisabled}
                onClick={onNewTask}
                className="text-foreground-subtle opacity-0 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
              >
                <Plus className="size-3.5" />
              </Button>
            </span>
          </ControlHintTooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                data-testid="project-menu"
                aria-label={intl.formatMessage({ id: "projectSidebar.edit" })}
                className="text-foreground-subtle opacity-0 hover:text-foreground group-hover:opacity-100 data-[state=open]:opacity-100 focus-visible:opacity-100"
              >
                <MoreHorizontal className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <DropdownMenuItem disabled={legacyReadOnly} onSelect={onEdit}>
                <Pencil className="size-3.5" />
                {intl.formatMessage({ id: "projectSidebar.edit" })}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={legacyReadOnly} onSelect={onPin}>
                {project.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                {intl.formatMessage({
                  id: project.pinned ? "projectSidebar.unpin" : "projectSidebar.pin",
                })}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={legacyReadOnly || primaryRootMissing || tasks.length === 0}
                onSelect={onMoveTasks}
              >
                <MoveRight className="size-3.5" />
                {intl.formatMessage({ id: "projectSidebar.moveTasks" })}
              </DropdownMenuItem>
              {project.roots.length > 0 ? (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger disabled={primaryRootMissing}>
                    <FolderSearch className="size-3.5" />
                    {intl.formatMessage({ id: "projectSidebar.viewFiles" })}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {project.roots.map((root) => (
                      <DropdownMenuItem
                        key={root.rootPath}
                        onSelect={() => onViewFiles(root.rootPath)}
                      >
                        <Folder className="size-3.5" />
                        <span className="max-w-56 truncate" title={root.rootPath}>
                          {root.rootPath}
                        </span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={legacyReadOnly} onSelect={onDelete}>
                <Trash2 className="size-3.5 text-destructive" />
                <span className="text-destructive">
                  {intl.formatMessage({ id: "projectSidebar.delete" })}
                </span>
              </DropdownMenuItem>
              {legacyReadOnly ? (
                <p className="px-2 py-1.5 text-ui-xs text-foreground-subtlest">
                  {intl.formatMessage({ id: "projectSidebar.legacyReadOnlyHint" })}
                </p>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {expanded ? (
        <div className="pl-6 pr-1">
          {visibleTasks.length === 0 ? (
            <p className="px-2 py-1 text-ui-sm text-foreground-subtlest">
              {intl.formatMessage({ id: "projectSidebar.emptyProjectTasks" })}
            </p>
          ) : (
            <div className="flex flex-col gap-1">
              {visibleTasks.map((task) => (
                <ProjectTaskRow
                  key={task.taskId}
                  task={task}
                  refresh={refresh}
                  legacyReadOnly={legacyReadOnly}
                  onSelect={onSelectTask}
                />
              ))}
              {tasks.length > limit ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="ml-2 h-auto justify-start p-0 text-ui-sm text-foreground-subtlest hover:bg-transparent"
                  onClick={() => setLimit((current) => current + PROJECT_TASK_PAGE_SIZE)}
                >
                  {intl.formatMessage({ id: "projectSidebar.showMore" })}
                </Button>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </li>
  );
});
