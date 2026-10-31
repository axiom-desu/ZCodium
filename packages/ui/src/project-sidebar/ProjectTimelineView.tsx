import { Fragment, useMemo, useState } from "react";
import type { ProjectTask } from "./contract.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useProjectSidebarIntl } from "./i18n.js";
import { ProjectTaskRow } from "./ProjectTaskRow.js";
import { timelineDateHeadings } from "./view.js";

const TIMELINE_PAGE_SIZE = 20;

function taskKey(task: ProjectTask): string {
  return JSON.stringify([
    task.hostId,
    task.workspaceIdentity?.trim() || task.workspacePath,
    task.taskId,
  ]);
}

/** 时间线只切同一有序数组的可见窗口；排序和行集合由调用方从 Host 树派生。 */
export function ProjectTimelineView({
  tasks,
  refresh,
  onSelectTask,
  legacyReadOnly,
}: {
  tasks: readonly ProjectTask[];
  refresh: () => Promise<void>;
  onSelectTask: (task: ProjectTask) => void;
  legacyReadOnly: (task: ProjectTask) => boolean;
}) {
  const intl = useProjectSidebarIntl();
  const { locale } = useZCodeIntl();
  const [limit, setLimit] = useState(TIMELINE_PAGE_SIZE);
  const visible = useMemo(() => tasks.slice(0, limit), [limit, tasks]);
  const headings = useMemo(
    () =>
      timelineDateHeadings(
        visible.map((task) => task.updatedAt),
        Date.now(),
        locale,
      ),
    [locale, visible],
  );

  if (tasks.length === 0) {
    return (
      <p
        className="px-3 py-2 text-ui-base text-foreground-subtle"
        data-testid="project-timeline-empty"
      >
        {intl.formatMessage({ id: "projectSidebar.emptyTimeline" })}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-0.5" data-testid="project-timeline-view">
      {visible.map((task, index) => (
        <Fragment key={taskKey(task)}>
          {headings[index] ? (
            <h3
              data-timeline-date-heading={headings[index]!.key}
              className="px-2.5 pt-2 pb-1 text-ui-base font-medium text-foreground-subtle"
            >
              {intl.formatMessage({ id: headings[index]!.id }, headings[index]!.values)}
            </h3>
          ) : null}
          <ProjectTaskRow
            task={task}
            refresh={refresh}
            legacyReadOnly={legacyReadOnly(task)}
            onSelect={onSelectTask}
          />
        </Fragment>
      ))}
      {tasks.length > visible.length ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="project-timeline-show-more"
          className="ml-8.5 h-auto justify-start p-0 text-ui-base text-foreground-subtlest hover:bg-transparent"
          onClick={() => setLimit((current) => current + TIMELINE_PAGE_SIZE)}
        >
          {intl.formatMessage({ id: "projectSidebar.showMore" })}
        </Button>
      ) : null}
    </div>
  );
}
