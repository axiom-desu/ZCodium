import { useState } from "react";
import type { RemoteProjectEntry } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useRemoteProjects } from "@/hooks/useRemoteProjects.js";
import { useProjectSidebarIntl } from "./i18n.js";

/**
 * 远端项目入口的唯一 UI：列出本机保存的 intent，显式移除/恢复离线缓存。
 * 移除只删本机 entry，不冒充远端项目数据删除；远端生命周期仍归连接 registry。
 */
export function RemoteProjectsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const intl = useProjectSidebarIntl();
  const state = useRemoteProjects();
  const [confirming, setConfirming] = useState<string | null>(null);

  const remove = async (entry: RemoteProjectEntry) => {
    await state.removeEntry(entry.entryId);
    setConfirming(null);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (!next && !state.busy ? onClose() : undefined)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({ id: "projectSidebar.remoteProjectsTitle" })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "projectSidebar.remoteProjectsDescription" })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {state.error ? (
            <p className="text-sm text-destructive" data-testid="remote-project-error">
              {state.error}
            </p>
          ) : null}
          {state.entries.length === 0 && !state.loading ? (
            <p className="text-sm text-foreground-muted">
              {intl.formatMessage({ id: "projectSidebar.remoteProjectsEmpty" })}
            </p>
          ) : null}
          {state.entries.map((entry) => (
            <div
              key={entry.entryId}
              className="flex flex-col gap-2 rounded-md border border-border p-3"
              data-testid="remote-project-row"
              data-cached-deleted={entry.cachedDeleted ? "true" : "false"}
            >
              <div className="flex items-center gap-2">
                <span className="truncate font-medium">{entry.name}</span>
                {entry.cachedDeleted ? (
                  <span
                    className="text-xs text-warning"
                    data-testid="remote-project-cached-deleted"
                  >
                    {intl.formatMessage({ id: "projectSidebar.remoteProjectCachedDeleted" })}
                  </span>
                ) : null}
              </div>
              {entry.roots.map((root) => (
                <p key={root} className="truncate text-xs text-foreground-muted" title={root}>
                  {root}
                </p>
              ))}
              <div className="flex flex-wrap items-center gap-2">
                {entry.cachedDeleted ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={state.busy}
                    data-testid="remote-project-restore"
                    onClick={() => void state.restoreEntry(entry.entryId)}
                  >
                    {intl.formatMessage({ id: "projectSidebar.remoteProjectRestore" })}
                  </Button>
                ) : confirming === entry.entryId ? (
                  <>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={state.busy}
                      data-testid="remote-project-remove-confirm"
                      onClick={() => void remove(entry)}
                    >
                      {intl.formatMessage({ id: "projectSidebar.remoteProjectRemoveConfirm" })}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                      {intl.formatMessage({ id: "projectSidebar.cancel" })}
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={state.busy}
                    data-testid="remote-project-remove"
                    onClick={() => setConfirming(entry.entryId)}
                  >
                    {intl.formatMessage({ id: "projectSidebar.remoteProjectRemove" })}
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
