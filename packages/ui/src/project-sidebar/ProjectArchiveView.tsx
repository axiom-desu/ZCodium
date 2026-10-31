import { useMemo } from "react";
import { ArchiveX, Folder, Trash2 } from "lucide-react";
import type { ProjectTask, ProjectTree } from "./contract.js";
import { Button } from "@/components/ui/button.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import { useProjectSidebarIntl } from "./i18n.js";
import { useProjectTaskActions } from "./useProjectTaskActions.js";
import { buildProjectArchiveGroups } from "./view.js";

function ArchiveTaskRow({ task, refresh }: { task: ProjectTask; refresh: () => Promise<void> }) {
  const intl = useProjectSidebarIntl();
  const confirm = useConfirmDialog();
  const actions = useProjectTaskActions(task, refresh);
  const title = task.title || intl.formatMessage({ id: "projectSidebar.untitled" });
  return (
    <li
      data-testid="project-archive-task"
      className="flex min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 hover:bg-surface-hover"
    >
      <span className="min-w-0 flex-1 truncate text-ui-base text-foreground" title={title}>
        {title}
      </span>
      <span className="shrink-0 text-ui-sm text-foreground-subtle">
        {formatTaskRelativeTime(task.updatedAt, intl)}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="project-archive-unarchive"
        aria-label={intl.formatMessage({ id: "projectSidebar.unarchive" })}
        onClick={() => void actions.unarchive(task.taskId)}
      >
        <ArchiveX className="size-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        data-testid="project-archive-delete"
        aria-label={intl.formatMessage({ id: "projectSidebar.deleteTask" })}
        className="text-destructive hover:text-destructive"
        onClick={() => {
          void (async () => {
            const confirmed = await confirm({
              title: intl.formatMessage({ id: "projectSidebar.deleteTaskTitle" }),
              description: intl.formatMessage({ id: "projectSidebar.deleteTaskDescription" }),
              confirmLabel: intl.formatMessage({ id: "projectSidebar.deleteTask" }),
              confirmVariant: "destructive",
            });
            if (confirmed) await actions.remove(task.taskId);
          })();
        }}
      >
        <Trash2 className="size-3.5" />
      </Button>
    </li>
  );
}

/** 归档视图按 Host + projectId 分组；软删项目仍按原 ID/名称展示。 */
export function ProjectArchiveView({
  tree,
  refresh,
}: {
  tree: ProjectTree;
  refresh: () => Promise<void>;
}) {
  const intl = useProjectSidebarIntl();
  const groups = useMemo(() => buildProjectArchiveGroups(tree), [tree]);

  if (groups.length === 0) {
    return (
      <p
        className="px-3 py-2 text-ui-base text-foreground-subtle"
        data-testid="project-archive-empty"
      >
        {intl.formatMessage({ id: "projectSidebar.emptyArchive" })}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid="project-archive-view">
      {groups.map((group) => {
        const name = group.project
          ? `${group.project.name}${group.project.deleted ? ` · ${intl.formatMessage({ id: "projectSidebar.deletedProject" })}` : ""}`
          : intl.formatMessage({ id: "projectSidebar.unclassified" });
        return (
          <section
            key={group.key}
            data-testid="project-archive-group"
            data-project-id={group.projectId ?? ""}
          >
            <h3 className="flex min-w-0 items-center gap-1.5 px-2.5 py-1 text-ui-sm font-medium text-foreground-subtle">
              <Folder className="size-3 shrink-0" />
              <span className="min-w-0 flex-1 truncate" title={name}>
                {name}
              </span>
              <span className="shrink-0">{group.tasks.length}</span>
            </h3>
            <ul className="space-y-0.5">
              {group.tasks.map((task) => (
                <ArchiveTaskRow key={`${group.key}:${task.taskId}`} task={task} refresh={refresh} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
