import { useEffect, useMemo, useState } from "react";
import { FolderPlus, Trash2, X } from "lucide-react";
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
import { Input } from "@/components/ui/input.js";
import { cn } from "@/components/lib/utils.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { getPathLeaf } from "@/lib/path.js";
import { useProjectSidebarIntl } from "./i18n.js";
import type { ProjectSidebarCommands } from "./useProjectSidebarCommands.js";
import { splitRoots } from "./view.js";
import type { ProjectSidebarScope } from "./useProjectSidebarData.js";
import { useProjectDialogLifetime } from "./useProjectDialogLifetime.js";

function isAbsolutePathLike(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function normalizeRoot(path: string): string {
  const trimmed = path.trim();
  // 只去掉末尾分隔符；不在 UI 做平台 realpath，归属路径由 Host 校验。
  return trimmed.length > 1 ? trimmed.replace(/[\\/]+$/, "") : trimmed;
}

/**
 * 编辑器是唯一表单草稿 owner。roots/primary 只影响保存后新任务；
 * 有 roots 时必须先确认本次目录信任，取消保留表单且不写库。
 */
export function ProjectEditorDialog({
  open,
  project,
  commands,
  scope,
  initialDeletePending = false,
  onClose,
  onSaved,
}: {
  open: boolean;
  project?: VirtualProject;
  commands: ProjectSidebarCommands;
  scope: ProjectSidebarScope;
  initialDeletePending?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const intl = useProjectSidebarIntl();
  const platform = useOptionalPlatform();
  const isCurrent = useProjectDialogLifetime(open, scope, project?.id);
  const initial = useMemo(() => {
    const split = project ? splitRoots(project) : { roots: [], primaryRoot: "" };
    return { name: project?.name ?? "", ...split };
  }, [project]);
  const [name, setName] = useState(initial.name);
  const [roots, setRoots] = useState<string[]>(initial.roots);
  const [primaryRoot, setPrimaryRoot] = useState(initial.primaryRoot);
  const [rootDraft, setRootDraft] = useState("");
  const [trustPending, setTrustPending] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 只在打开或切换到另一个项目时装载草稿；readTree 刷新带来的对象身份变化不能覆盖用户正在编辑的表单。
  useEffect(() => {
    if (!open) return;
    setName(initial.name);
    setRoots(initial.roots);
    setPrimaryRoot(initial.primaryRoot);
    setRootDraft("");
    setTrustPending(false);
    setDeletePending(initialDeletePending);
    setBusy(false);
    setError(null);
  }, [open, project?.id, initialDeletePending, scope.token]);

  const legacyReadOnly = project?.legacySingleRoot === true;
  const canSubmit = !busy && !legacyReadOnly;
  const addRoot = (path: string) => {
    const root = normalizeRoot(path);
    if (!root) return;
    if (!isAbsolutePathLike(root)) {
      setError(intl.formatMessage({ id: "projectSidebar.rootRequired" }));
      return;
    }
    setError(null);
    setRoots((current) => {
      if (current.includes(root)) return current;
      const next = [...current, root];
      setPrimaryRoot((primary) => primary || root);
      return next;
    });
    setRootDraft("");
  };
  const removeRoot = (root: string) => {
    setRoots((current) => {
      const next = current.filter((entry) => entry !== root);
      setPrimaryRoot((primary) => (primary === root ? (next[0] ?? "") : primary));
      return next;
    });
  };
  const selectFolder = async () => {
    if (!platform) {
      setError(intl.formatMessage({ id: "projectSidebar.selectFolderUnavailable" }));
      return;
    }
    const path = await platform.selectDirectory();
    if (isCurrent() && path) addRoot(path);
  };

  const persist = async () => {
    if (!canSubmit || !isCurrent()) return;
    setBusy(true);
    setError(null);
    try {
      await commands.saveProject({
        ...(project ? { id: project.id, hostId: project.hostId } : {}),
        ...(name.trim() ? { name: name.trim() } : {}),
        roots,
        ...(primaryRoot ? { primaryRoot } : {}),
      });
      if (!isCurrent()) return;
      onSaved();
      onClose();
    } catch (cause) {
      if (!isCurrent()) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (isCurrent()) setBusy(false);
    }
  };

  const requestSave = () => {
    if (roots.length === 0) {
      void persist();
      return;
    }
    setTrustPending(true);
  };

  const confirmDelete = async () => {
    if (!project || busy || !isCurrent()) return;
    setBusy(true);
    setError(null);
    try {
      await commands.deleteProject(project.id, project.hostId);
      if (!isCurrent()) return;
      onSaved();
      onClose();
    } catch (cause) {
      if (!isCurrent()) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (isCurrent()) setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (!next && !busy ? onClose() : undefined)}>
      <DialogContent data-testid="project-editor-dialog" className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({
              id: project ? "projectSidebar.editTitle" : "projectSidebar.createTitle",
            })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "projectSidebar.rootsHint" })}
          </DialogDescription>
        </DialogHeader>

        {legacyReadOnly ? (
          <p className="rounded-md bg-surface-hover px-3 py-2 text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "projectSidebar.legacyReadOnlyHint" })}
          </p>
        ) : null}

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-ui-sm font-medium text-foreground">
              {intl.formatMessage({ id: "projectSidebar.nameLabel" })}
            </span>
            <Input
              data-testid="project-editor-name"
              value={name}
              placeholder={intl.formatMessage({ id: "projectSidebar.namePlaceholder" })}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") requestSave();
              }}
            />
          </label>

          <div className="flex flex-col gap-1.5">
            <span className="text-ui-sm font-medium text-foreground">
              {intl.formatMessage({ id: "projectSidebar.rootsLabel" })}
            </span>
            {roots.length === 0 ? (
              <p className="text-ui-sm text-foreground-subtlest">
                {intl.formatMessage({ id: "projectSidebar.noRoots" })}
              </p>
            ) : (
              <ul className="flex flex-col gap-1" data-testid="project-editor-roots">
                {roots.map((root) => (
                  <li
                    key={root}
                    className={cn(
                      "flex min-w-0 items-center gap-2 rounded-md border border-border px-2 py-1.5",
                      primaryRoot === root && "border-brand/40 bg-accent/40",
                    )}
                  >
                    <input
                      type="radio"
                      name="project-primary-root"
                      className="size-3 shrink-0 accent-[var(--color-brand)]"
                      checked={primaryRoot === root}
                      aria-label={intl.formatMessage({ id: "projectSidebar.primaryRoot" })}
                      onChange={() => setPrimaryRoot(root)}
                    />
                    <span
                      className="min-w-0 flex-1 truncate text-ui-sm text-foreground-subtle"
                      title={root}
                    >
                      {root}
                    </span>
                    {getPathLeaf(root) !== root ? (
                      <span className="shrink-0 text-ui-xs text-foreground-subtlest">
                        {getPathLeaf(root)}
                      </span>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={intl.formatMessage({ id: "projectSidebar.removeRoot" })}
                      onClick={() => removeRoot(root)}
                    >
                      <X className="size-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex min-w-0 items-center gap-1.5">
              <Input
                data-testid="project-editor-root-input"
                value={rootDraft}
                placeholder={intl.formatMessage({ id: "projectSidebar.rootPlaceholder" })}
                onChange={(event) => setRootDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") addRoot(rootDraft);
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="project-editor-add-root-path"
                onClick={() => addRoot(rootDraft)}
              >
                {intl.formatMessage({ id: "projectSidebar.addRoot" })}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                data-testid="project-editor-add-root"
                aria-label={intl.formatMessage({ id: "projectSidebar.addRoot" })}
                onClick={() => void selectFolder()}
              >
                <FolderPlus className="size-3.5" />
              </Button>
            </div>
          </div>

          {trustPending ? (
            <div
              data-testid="project-editor-trust"
              className="flex flex-col gap-2 rounded-md border border-border bg-surface p-3"
            >
              <p className="text-ui-sm font-medium text-foreground">
                {intl.formatMessage({ id: "projectSidebar.trustTitle" })}
              </p>
              <p className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "projectSidebar.trustDescription" })}
              </p>
              <ul className="flex flex-col gap-1">
                {roots.map((root) => (
                  <li
                    key={root}
                    className="truncate text-ui-sm text-foreground-subtle"
                    title={root}
                  >
                    {root}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {deletePending ? (
            <div
              data-testid="project-editor-delete-confirm"
              className="flex flex-col gap-1 rounded-md border border-destructive/30 bg-destructive/5 p-3"
            >
              <p className="text-ui-sm font-medium text-foreground">
                {intl.formatMessage({ id: "projectSidebar.deleteTitle" })}
              </p>
              <p className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "projectSidebar.deleteDescription" })}
              </p>
            </div>
          ) : null}

          {error ? (
            <p role="alert" className="text-ui-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter className="flex-wrap">
          {project && !legacyReadOnly ? (
            deletePending ? (
              <Button
                type="button"
                variant="destructive"
                data-testid="project-editor-delete-apply"
                disabled={busy}
                onClick={() => void confirmDelete()}
              >
                {intl.formatMessage({ id: "projectSidebar.deleteConfirm" })}
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                data-testid="project-editor-delete"
                className="mr-auto text-destructive"
                disabled={busy}
                onClick={() => setDeletePending(true)}
              >
                <Trash2 className="size-3.5" />
                {intl.formatMessage({ id: "projectSidebar.delete" })}
              </Button>
            )
          ) : null}
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            {intl.formatMessage({ id: "projectSidebar.cancel" })}
          </Button>
          {trustPending ? (
            <Button
              type="button"
              data-testid="project-editor-trust-confirm"
              disabled={!canSubmit}
              onClick={() => void persist()}
            >
              {intl.formatMessage({ id: "projectSidebar.trustConfirm" })}
            </Button>
          ) : (
            <Button
              type="button"
              data-testid="project-editor-save"
              disabled={!canSubmit}
              onClick={requestSave}
            >
              {intl.formatMessage({
                id: busy ? "projectSidebar.saving" : "projectSidebar.save",
              })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
