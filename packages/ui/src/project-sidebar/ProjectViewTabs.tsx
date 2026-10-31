import { Archive, Clock3, Folder, Hash } from "lucide-react";
import type { ProjectSidebarViewMode } from "./contract.js";
import { Button } from "@/components/ui/button.js";
import { useProjectSidebarIntl } from "./i18n.js";

const PROJECT_VIEW_TABS = [
  { id: "projects", labelId: "projectSidebar.viewProjects", Icon: Folder },
  { id: "grouped", labelId: "projectSidebar.viewGrouped", Icon: Hash },
  { id: "timeline", labelId: "projectSidebar.viewTimeline", Icon: Clock3 },
  { id: "archive", labelId: "projectSidebar.viewArchive", Icon: Archive },
] as const;

/** 四个视图共享同一 ProjectSidebar read-model；这里只写本客户端偏好。 */
export function ProjectViewTabs({
  view,
  onChange,
}: {
  view: ProjectSidebarViewMode;
  onChange: (mode: ProjectSidebarViewMode) => void;
}) {
  const intl = useProjectSidebarIntl();
  return (
    <div
      className="flex min-w-0 items-center gap-0.5 px-1.5"
      role="tablist"
      aria-label={intl.formatMessage({ id: "projectSidebar.viewsLabel" })}
      data-testid="project-view-tabs"
    >
      {PROJECT_VIEW_TABS.map((tab) => (
        <Button
          key={tab.id}
          type="button"
          variant="ghost"
          size="icon-sm"
          role="tab"
          aria-selected={view === tab.id}
          data-testid={`project-view-${tab.id}`}
          aria-label={intl.formatMessage({ id: tab.labelId })}
          title={intl.formatMessage({ id: tab.labelId })}
          onClick={() => onChange(tab.id)}
          className={
            view === tab.id
              ? "bg-selected text-foreground"
              : "text-foreground-subtlest hover:text-foreground"
          }
        >
          <tab.Icon className="size-3.5" />
        </Button>
      ))}
    </div>
  );
}
