import { useEffect, useState } from "react";
import type { VirtualProject } from "./contract.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useProjectSidebarIntl } from "./i18n.js";
import type { ProjectSidebarCommands } from "./useProjectSidebarCommands.js";
import type { ProjectSidebarScope } from "./useProjectSidebarData.js";
import { useProjectDialogLifetime } from "./useProjectDialogLifetime.js";

/** 恢复必须是用户显式选择；提交原 roots，由服务端做 exact-match 校验。 */
export function ProjectRestoreDialog({
  open,
  projects,
  commands,
  scope,
  onClose,
  onRestored,
}: {
  open: boolean;
  projects: VirtualProject[];
  commands: ProjectSidebarCommands;
  scope: ProjectSidebarScope;
  onClose: () => void;
  onRestored: () => void;
}) {
  const intl = useProjectSidebarIntl();
  const isCurrent = useProjectDialogLifetime(open, scope);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setBusyId(null);
    setError(null);
  }, [open, scope.token]);
  const restore = async (project: VirtualProject) => {
    if (busyId !== null || !isCurrent()) return;
    setBusyId(project.id);
    setError(null);
    try {
      await commands.restoreProject(project);
      if (!isCurrent()) return;
      onRestored();
      onClose();
    } catch (cause) {
      if (!isCurrent()) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (isCurrent()) setBusyId(null);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => (!next && !busyId ? onClose() : undefined)}>
      <DialogContent data-testid="project-restore-dialog" className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "projectSidebar.restoreProjects" })}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "projectSidebar.restoreHint" })}
          </DialogDescription>
        </DialogHeader>
        {projects.length === 0 ? (
          <p className="text-ui-sm text-foreground-subtlest">
            {intl.formatMessage({ id: "projectSidebar.restoreEmpty" })}
          </p>
        ) : (
          <ul className="flex max-h-72 flex-col gap-2 overflow-y-auto">
            {projects.map((project) => (
              <li
                key={project.id}
                className="flex min-w-0 items-center gap-3 rounded-md border border-border px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-ui-base text-foreground">{project.name}</p>
                  <p
                    className="truncate text-ui-sm text-foreground-subtlest"
                    title={project.roots.map((root) => root.rootPath).join("\n")}
                  >
                    {project.roots.map((root) => root.rootPath).join(" · ") || "—"}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  data-testid={`project-restore-${project.name}`}
                  disabled={busyId !== null}
                  onClick={() => void restore(project)}
                >
                  {intl.formatMessage({ id: "projectSidebar.restore" })}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {error ? (
          <p role="alert" className="text-ui-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busyId !== null} onClick={onClose}>
            {intl.formatMessage({ id: "projectSidebar.cancel" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
