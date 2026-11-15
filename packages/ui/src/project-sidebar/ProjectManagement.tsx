import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildProjectManagementRows,
  selectProjectManagementRows,
  selectRemovedProjects,
  summarizeUnusedProjects,
  type ProjectManagementFilter,
  type ProjectManagementRow,
  type ProjectManagementSort,
} from "./project-management-view.js";
import {
  ProjectManagementFailureBanner,
  ProjectManagementSelectionBar,
  ProjectManagementSuggestion,
  ProjectManagementToolbar,
} from "./ProjectManagementControls.js";
import { ProjectManagementListRow, PROJECT_MANAGEMENT_GRID } from "./ProjectManagementRow.js";
import { ProjectEditorDialog } from "./ProjectEditorDialog.js";
import { ProjectRemovalDialog } from "./ProjectRemovalDialog.js";
import { RemovedProjects } from "./RemovedProjects.js";
import { useProjectManagement, type ProjectRemovalOptions } from "./useProjectManagement.js";
import { useProjectSidebarCommands } from "./useProjectSidebarCommands.js";
import { useProjectSidebarData } from "./useProjectSidebarData.js";

const PAGE = 50;
const EMPTY_UNUSED = { total: 0, missing: 0, empty: 0, idle: 0 };

/**
 * 项目管理的唯一入口：树事实只经 readTree owner，命令只经 IProjectService；
 * 本页只管理本机项目（数据删除只本机），远程项目保留展示、不提供移除。
 */
export function ProjectManagement({
  workspacePath,
  workspaceIdentity,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  const data = useProjectSidebarData({ workspacePath, workspaceIdentity });
  const commands = useProjectSidebarCommands(data.refresh);
  const state = useProjectManagement({ tree: data.tree, refresh: data.refresh });
  const { intl } = useZCodeIntl();
  const msg = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id: `projectManagement.${id}` }, values);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ProjectManagementFilter>("all");
  const [sort, setSort] = useState<ProjectManagementSort>("lastActive");
  const [limit, setLimit] = useState(PAGE);
  // 选择只是 UI 草稿：生效集合 = 草稿 ∩ 当前可见且可移除的行，树刷新后自然收敛，不另做同步。
  const [draft, setDraft] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState<readonly ProjectManagementRow[] | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);

  // 「最近活动」与疑似原因按目录版本取一次当前时间，渲染之间保持稳定。
  const now = useMemo(() => Date.now(), [data.tree]);
  const rows = useMemo(
    () => (data.tree ? buildProjectManagementRows({ tree: data.tree, now }) : []),
    [data.tree, now],
  );
  const unused = useMemo(
    () => (rows.length ? summarizeUnusedProjects(rows) : EMPTY_UNUSED),
    [rows],
  );
  const visible = useMemo(
    () => selectProjectManagementRows(rows, { query, filter, sort }),
    [rows, query, filter, sort],
  );
  const removed = useMemo(() => (data.tree ? selectRemovedProjects(data.tree) : []), [data.tree]);
  const selectable = useMemo(() => visible.filter((row) => row.removal), [visible]);
  const selected = useMemo(
    () => selectable.filter((row) => draft.has(row.key)),
    [selectable, draft],
  );
  const disabled = state.busy || data.loading;
  const canEdit = (row: ProjectManagementRow) =>
    Boolean(state.supported && !row.project.legacySingleRoot);

  // 同一目录可属于多个项目；只用 Host + ID 取当前事实，移除或刷新后不保留旧编辑草稿。
  const editingRow = rows.find((row) => row.key === editingKey && canEdit(row));
  useEffect(() => {
    if (editingKey && !editingRow) setEditingKey(null);
  }, [editingKey, editingRow]);

  const resetView = useCallback(() => {
    setDraft(new Set());
    setLimit(PAGE);
  }, []);
  const review = () => {
    setQuery("");
    setFilter("unused");
    setLimit(PAGE);
    // 预选全部候选，用户只需取消要保留的项目。
    setDraft(new Set(rows.filter((row) => row.reason && row.removal).map((row) => row.key)));
  };
  const toggle = (row: ProjectManagementRow, checked: boolean) =>
    setDraft((current) => {
      const next = new Set(current);
      if (checked) next.add(row.key);
      else next.delete(row.key);
      return next;
    });
  const confirm = useCallback(
    (batch: readonly ProjectManagementRow[], options?: ProjectRemovalOptions) => {
      setPending(null);
      setDraft(new Set());
      void state.remove(batch, options);
    },
    [state],
  );

  if (!data.supported) {
    // 旧 Host/Web 没有 Project channel：不伪造空树，明确说明不可用。
    return (
      <p role="alert" className="py-8 text-ui-base text-destructive">
        {msg("loadFailed")}
      </p>
    );
  }
  const allChecked = selectable.length > 0 && selected.length === selectable.length;
  return (
    <section data-testid="project-management" className="min-w-0 space-y-6">
      {state.failure ? (
        <ProjectManagementFailureBanner
          failure={state.failure}
          busy={state.busy}
          onRetry={() => void state.failure?.retry()}
          onDismiss={state.dismissFailure}
        />
      ) : null}
      {filter === "all" && unused.total > 0 && !data.loading ? (
        <ProjectManagementSuggestion unused={unused} disabled={disabled} onReview={review} />
      ) : null}
      <ProjectManagementToolbar
        query={query}
        onQueryChange={setQuery}
        filter={filter}
        onFilterChange={setFilter}
        sort={sort}
        onSortChange={setSort}
        unusedCount={unused.total}
        busy={state.busy}
        onResetView={resetView}
      />
      {data.error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 text-ui-base text-destructive"
        >
          <span>{msg("loadFailed")}</span>
          <Button variant="outline" onClick={() => void data.refresh()}>
            {msg("retry")}
          </Button>
        </div>
      ) : null}
      {data.loading ? (
        <p role="status" className="py-8 text-ui-base text-foreground-subtle">
          {msg("loading")}
        </p>
      ) : !visible.length ? (
        <p
          data-testid="project-management-empty"
          className="py-12 text-center text-ui-base text-foreground-subtle"
        >
          {msg(!rows.length ? "empty" : filter === "unused" && !query ? "noUnused" : "noResults")}
        </p>
      ) : (
        <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-surface">
          <div
            data-testid="project-management-header"
            className={cn(
              "grid grid-cols-[1rem_minmax(0,1fr)] items-center gap-x-3 px-4 py-2 text-ui-sm text-foreground-subtle",
              PROJECT_MANAGEMENT_GRID,
            )}
          >
            <Checkbox
              data-testid="project-management-select-all"
              aria-label={msg("selectAll")}
              disabled={disabled || !selectable.length}
              checked={allChecked ? true : selected.length ? "indeterminate" : false}
              onCheckedChange={() =>
                setDraft(allChecked ? new Set() : new Set(selectable.map((row) => row.key)))
              }
            />
            <span className="min-w-0 truncate md:pl-6.5">
              <span className="md:hidden">{msg("selectAll")}</span>
              <span className="hidden md:inline">{msg("column.project")}</span>
            </span>
            <span className="hidden md:block">{msg("column.device")}</span>
            <span className="hidden text-right md:block">{msg("column.sessions")}</span>
            <span className="hidden text-right md:block">{msg("column.lastActive")}</span>
            <span className="hidden md:block" />
          </div>
          {visible.slice(0, limit).map((row) => (
            <ProjectManagementListRow
              key={row.key}
              row={row}
              now={now}
              checked={draft.has(row.key) && row.removal !== null}
              disabled={disabled}
              onEdit={canEdit(row) ? () => setEditingKey(row.key) : undefined}
              onCheckedChange={(checked) => toggle(row, checked)}
              onRemove={() => setPending([row])}
            />
          ))}
          {visible.length > limit ? (
            <div className="flex justify-center border-t border-border p-2">
              <Button
                data-testid="project-management-show-more"
                variant="ghost"
                onClick={() => setLimit((n) => n + PAGE)}
              >
                {msg("showMore", { count: Math.min(PAGE, visible.length - limit) })}
              </Button>
            </div>
          ) : null}
        </div>
      )}
      <RemovedProjects
        projects={removed}
        disabled={disabled}
        onRestore={(project) => void state.restore(project)}
      />
      {selected.length ? (
        <ProjectManagementSelectionBar
          selectedCount={selected.length}
          visibleCount={visible.length}
          disabled={disabled}
          onClear={() => setDraft(new Set())}
          onRemove={() => setPending(selected)}
        />
      ) : null}
      <ProjectRemovalDialog
        rows={pending}
        measureData={state.measureData}
        onCancel={() => setPending(null)}
        onConfirm={confirm}
      />
      {editingRow ? (
        <ProjectEditorDialog
          key={editingRow.key}
          open
          project={editingRow.project}
          commands={commands}
          scope={data}
          onClose={() => setEditingKey(null)}
          onSaved={() => void data.refresh()}
        />
      ) : null}
    </section>
  );
}
