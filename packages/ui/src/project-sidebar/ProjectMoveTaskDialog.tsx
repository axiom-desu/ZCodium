import { useEffect, useMemo, useState } from "react";
import type { ProjectTask, VirtualProject } from "./contract.js";
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
import { projectRowKey } from "./view.js";
import type { ProjectSidebarScope } from "./useProjectSidebarData.js";
import { useProjectDialogLifetime } from "./useProjectDialogLifetime.js";

/** 缺 root 不在后台自动补；必须由用户显式确认后带 addMissingRoot 重试。 */
export function ProjectMoveTaskDialog({
  open,
  project,
  projects,
  tasks,
  commands,
  scope,
  onClose,
}: {
  open: boolean;
  project: VirtualProject;
  projects: VirtualProject[];
  tasks: ProjectTask[];
  commands: ProjectSidebarCommands;
  scope: ProjectSidebarScope;
  onClose: () => void;
}) {
  const intl = useProjectSidebarIntl();
  const isCurrent = useProjectDialogLifetime(open, scope, project.id);
  const targets = useMemo(
    () =>
      projects.filter(
        (candidate) =>
          candidate.hostId === project.hostId &&
          projectRowKey(candidate) !== projectRowKey(project) &&
          !candidate.legacySingleRoot,
      ),
    [project, projects],
  );
  const [taskId, setTaskId] = useState(tasks[0]?.taskId ?? "");
  const [targetId, setTargetId] = useState(targets[0]?.id ?? "");
  const [missingRoot, setMissingRoot] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 只在打开时装载选项；树刷新不能重置用户正在选择的 task/target。
  useEffect(() => {
    if (!open) return;
    setTaskId(tasks[0]?.taskId ?? "");
    setTargetId(targets[0]?.id ?? "");
    setMissingRoot(false);
    setBusy(false);
    setError(null);
  }, [open, project.id, scope.token]);

  const move = async (addMissingRoot: boolean) => {
    const task = tasks.find((candidate) => candidate.taskId === taskId);
    if (!task || !targetId || busy || !isCurrent()) return;
    setBusy(true);
    setError(null);
    try {
      await commands.moveTask({
        task: {
          taskId: task.taskId,
          workspacePath: task.workspacePath,
          ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
        },
        projectId: targetId,
        ...(addMissingRoot ? { addMissingRoot: true } : {}),
      });
      if (!isCurrent()) return;
      onClose();
    } catch (cause) {
      if (!isCurrent()) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      setMissingRoot(message.includes("project.root-confirmation-required"));
      setError(message);
    } finally {
      if (isCurrent()) setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (!next && !busy ? onClose() : undefined)}>
      <DialogContent data-testid="project-move-dialog" className="max-w-md">
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "projectSidebar.moveTitle" })}</DialogTitle>
          <DialogDescription>{project.name}</DialogDescription>
        </DialogHeader>
        {tasks.length === 0 || targets.length === 0 ? (
          <p className="text-ui-sm text-foreground-subtlest">
            {intl.formatMessage({ id: "projectSidebar.emptyProjectTasks" })}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-ui-sm font-medium text-foreground">
                {intl.formatMessage({ id: "projectSidebar.moveTaskLabel" })}
              </span>
              <select
                data-testid="project-move-task"
                className="h-8 w-full rounded-md border border-input bg-input px-2 text-ui-sm text-foreground"
                value={taskId}
                onChange={(event) => setTaskId(event.target.value)}
              >
                {tasks.map((task) => (
                  <option key={task.taskId} value={task.taskId}>
                    {task.title || task.taskId}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-ui-sm font-medium text-foreground">
                {intl.formatMessage({ id: "projectSidebar.moveTargetLabel" })}
              </span>
              <select
                data-testid="project-move-target"
                className="h-8 w-full rounded-md border border-input bg-input px-2 text-ui-sm text-foreground"
                value={targetId}
                onChange={(event) => setTargetId(event.target.value)}
              >
                {targets.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </select>
            </label>
            {missingRoot ? (
              <p className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "projectSidebar.moveMissingRoot" })}
              </p>
            ) : null}
            {error && !missingRoot ? (
              <p role="alert" className="text-ui-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            {intl.formatMessage({ id: "projectSidebar.cancel" })}
          </Button>
          {missingRoot ? (
            <Button
              type="button"
              data-testid="project-move-add-root"
              disabled={busy}
              onClick={() => void move(true)}
            >
              {intl.formatMessage({ id: "projectSidebar.moveMissingRootAction" })}
            </Button>
          ) : (
            <Button
              type="button"
              data-testid="project-move-apply"
              disabled={busy || tasks.length === 0 || targets.length === 0}
              onClick={() => void move(false)}
            >
              {intl.formatMessage({ id: "projectSidebar.moveAction" })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
