import { MoveRight } from "lucide-react";
import type { ProjectTask, ProjectTaskGroup } from "./contract.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { cn } from "@/components/lib/utils.js";
import { useProjectSidebarIntl } from "./i18n.js";
import { ProjectTaskRow } from "./ProjectTaskRow.js";
import type { ProjectGroupedRow } from "./grouped.js";
import { GROUP_COLOR_CLASS } from "./grouped-colors.js";

/** 单任务行：drag 数据在行外层，菜单移动仍复用现有 group 命令。 */
export function ProjectGroupedTaskItem({
  row,
  groups,
  dropSide,
  refresh,
  onSelectTask,
  legacyReadOnly,
  onMoveTask,
}: {
  row: Extract<ProjectGroupedRow, { type: "task" }>;
  groups: readonly ProjectTaskGroup[];
  dropSide: "before" | "after" | null;
  refresh: () => Promise<void>;
  onSelectTask: (task: ProjectTask) => void;
  legacyReadOnly: boolean;
  onMoveTask: (task: ProjectTask, targetGroupId: string | null) => void;
}) {
  const intl = useProjectSidebarIntl();
  return (
    <div
      data-project-grouped-drag="task"
      data-project-group-id={row.groupId ?? undefined}
      data-project-grouped-task-row={row.key}
      data-project-grouped-drop="task"
      className={cn("group relative flex min-w-0 items-start", row.groupId && "pl-4")}
    >
      {dropSide ? (
        <div
          data-testid="project-grouped-drop-indicator"
          className={cn(
            "pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-primary",
            dropSide === "before" ? "top-0" : "bottom-0",
          )}
        />
      ) : null}
      <div className="min-w-0 flex-1">
        <ProjectTaskRow
          task={row.task}
          refresh={refresh}
          legacyReadOnly={legacyReadOnly}
          onSelect={onSelectTask}
        />
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            data-testid="project-group-task-menu"
            aria-label={intl.formatMessage({ id: "projectSidebar.moveTaskToGroup" })}
            className="shrink-0 text-foreground-subtlest opacity-0 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
          >
            <MoveRight className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuLabel>
            {intl.formatMessage({ id: "projectSidebar.moveTaskToGroup" })}
          </DropdownMenuLabel>
          <DropdownMenuItem
            disabled={row.groupId === null}
            onSelect={() => onMoveTask(row.task, null)}
          >
            {intl.formatMessage({ id: "projectSidebar.moveTaskToTop" })}
          </DropdownMenuItem>
          {groups.map((group) => (
            <DropdownMenuItem
              key={group.id}
              disabled={row.groupId === group.id}
              onSelect={() => onMoveTask(row.task, group.id)}
            >
              <span className={cn("size-2 rounded-full", GROUP_COLOR_CLASS[group.color])} />
              {group.title}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
