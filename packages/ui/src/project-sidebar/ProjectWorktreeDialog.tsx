import { useState } from "react";
import { GitBranch, Plus, Trash2 } from "lucide-react";
import type { ManagedWorktreeEntry } from "@zcode/shared/managed-worktree";
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
import { useManagedWorktree } from "@/hooks/useManagedWorktree.js";
import { getPathLeaf } from "@/lib/path.js";
import { useProjectSidebarIntl } from "./i18n.js";

/**
 * 受管 worktree 的唯一 UI 入口（项目行菜单打开）。
 * 创建任务由 Host 服务完成 worktree + 会话启动；成功后走既有 onSelectTask 导航。
 * 删除必须逐个确认；force 只在没有任务使用时允许，Host 仍会复检。
 */
export function ProjectWorktreeDialog({
  open,
  project,
  onClose,
  onSelectTask,
  onChanged,
}: {
  open: boolean;
  project: VirtualProject | null;
  onClose: () => void;
  onSelectTask: (worktreeRoot: string, taskId: string) => void;
  onChanged: () => Promise<void> | void;
}) {
  const intl = useProjectSidebarIntl();
  const state = useManagedWorktree(project?.id ?? null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [force, setForce] = useState(false);

  if (!project) return null;
  const entries = state.groups.flatMap((group) => group.worktrees);

  const create = async () => {
    const created = await state.createTask(null);
    if (!created) return;
    await onChanged();
    onClose();
    onSelectTask(created.workspacePath, created.taskId);
  };

  const remove = async (entry: ManagedWorktreeEntry) => {
    await state.removeWorktree(entry.path, force);
    setConfirming(null);
    setForce(false);
    await onChanged();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (!next && !state.busy ? onClose() : undefined)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "projectSidebar.worktreeTitle" })}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "projectSidebar.worktreeDescription" })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {!state.capable ? (
            <p className="text-sm text-warning" data-testid="worktree-unsupported">
              {intl.formatMessage({ id: "projectSidebar.worktreeUnsupported" })}
            </p>
          ) : null}
          {state.error ? (
            <p className="text-sm text-destructive" data-testid="worktree-error">
              {state.error}
            </p>
          ) : null}
          {entries.length === 0 && !state.loading ? (
            <p className="text-sm text-foreground-muted">
              {intl.formatMessage({ id: "projectSidebar.worktreeEmpty" })}
            </p>
          ) : null}
          {entries.map((entry) => (
            <div
              key={entry.path}
              className="flex flex-col gap-2 rounded-md border border-border p-3"
              data-testid="worktree-row"
            >
              <div className="flex items-center gap-2">
                <GitBranch className="size-4 shrink-0 text-foreground-subtle" />
                <span className="truncate font-medium">{getPathLeaf(entry.path)}</span>
                <span className="text-xs text-foreground-muted">
                  {entry.branch ?? entry.head?.slice(0, 8) ?? "HEAD"}
                </span>
                {entry.dirty ? (
                  <span className="text-xs text-warning">
                    {intl.formatMessage({ id: "projectSidebar.worktreeDirty" })}
                  </span>
                ) : null}
              </div>
              <p className="truncate text-xs text-foreground-muted" title={entry.path}>
                {entry.path}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {entry.tasks.map((task) => (
                  <Button
                    key={task.taskId}
                    size="sm"
                    variant="outline"
                    data-testid="worktree-task"
                    onClick={() => onSelectTask(entry.path, task.taskId)}
                  >
                    {task.title}
                  </Button>
                ))}
                {confirming === entry.path ? (
                  <>
                    {entry.tasks.length === 0 ? (
                      <label className="flex items-center gap-1 text-xs">
                        <input
                          type="checkbox"
                          checked={force}
                          onChange={(event) => setForce(event.target.checked)}
                        />
                        {intl.formatMessage({ id: "projectSidebar.worktreeForce" })}
                      </label>
                    ) : null}
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={state.busy || !state.capable}
                      data-testid="worktree-remove-confirm"
                      onClick={() => void remove(entry)}
                    >
                      {intl.formatMessage({ id: "projectSidebar.worktreeRemoveConfirm" })}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                      {intl.formatMessage({ id: "projectSidebar.cancel" })}
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={state.busy || entry.creating || !state.capable}
                    data-testid="worktree-remove"
                    onClick={() => {
                      setForce(false);
                      setConfirming(entry.path);
                    }}
                  >
                    <Trash2 className="size-4" />
                    {intl.formatMessage({ id: "projectSidebar.worktreeRemove" })}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={state.busy}>
            {intl.formatMessage({ id: "projectSidebar.worktreeClose" })}
          </Button>
          <Button
            disabled={state.busy || !state.capable}
            data-testid="worktree-create"
            onClick={() => void create()}
          >
            <Plus className="size-4" />
            {intl.formatMessage({ id: "projectSidebar.worktreeNewTask" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
