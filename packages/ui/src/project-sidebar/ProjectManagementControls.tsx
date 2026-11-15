import {
  Clock,
  FolderMinus,
  FolderX,
  MessageCircleOff,
  Search,
  TriangleAlert,
  X,
} from "lucide-react";
import { useId } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatCountMessage,
  type ProjectManagementFilter,
  type ProjectManagementSort,
} from "./project-management-view.js";
import type { ProjectManagementFailure } from "./useProjectManagement.js";

const SORTS = ["lastActive", "name", "sessions"] as const;

function useMessages() {
  const { intl } = useZCodeIntl();
  return {
    intl,
    msg: (id: string, values?: Record<string, string | number>) =>
      intl.formatMessage({ id: `projectManagement.${id}` }, values),
    count: (id: string, n: number, values?: Record<string, string | number>) =>
      formatCountMessage(intl, `projectManagement.${id}`, n, values),
  };
}

/** 失败横幅：项目名 + 原因 + 重试；重试保留原批次身份，不扩充已确认集合。 */
export function ProjectManagementFailureBanner({
  failure,
  busy,
  onRetry,
  onDismiss,
}: {
  failure: ProjectManagementFailure;
  busy: boolean;
  onRetry(): void;
  onDismiss(): void;
}) {
  const { msg, count } = useMessages();
  return (
    <div
      role="alert"
      data-testid="project-management-failure"
      className="flex min-w-0 items-center gap-3 rounded-xl bg-warning-surface py-2.5 pl-4 pr-3 text-warning-surface-foreground"
    >
      <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 text-ui-base">
        {count(`failure.${failure.kind}`, failure.count, {
          name: failure.name,
          reason: failure.reason,
        })}
      </span>
      <Button
        data-testid="project-management-retry"
        variant="outline"
        className="shrink-0 border-current text-inherit hover:bg-transparent"
        disabled={busy}
        onClick={onRetry}
      >
        {msg("retry")}
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        className="shrink-0 text-inherit"
        aria-label={msg("dismiss")}
        onClick={onDismiss}
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}

export function ProjectManagementSuggestion({
  unused,
  disabled,
  onReview,
}: {
  unused: { total: number; missing: number; empty: number; idle: number };
  disabled: boolean;
  onReview(): void;
}) {
  const { msg, count } = useMessages();
  return (
    <div
      data-testid="project-management-suggestion"
      className="flex min-w-0 flex-wrap items-center gap-4 rounded-xl border border-card-border bg-card p-4"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="text-ui-base font-medium">{count("suggestion.title", unused.total)}</span>
        <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-ui-sm text-foreground-subtle">
          {(
            [
              ["missing", FolderX],
              ["empty", MessageCircleOff],
              ["idle", Clock],
            ] as const
          ).map(([reason, Icon]) =>
            unused[reason] ? (
              <span key={reason} className="flex items-center gap-1.5">
                <Icon aria-hidden="true" className="size-3.5" />
                {count(`suggestion.${reason}`, unused[reason])}
              </span>
            ) : null,
          )}
        </div>
      </div>
      <Button
        data-testid="project-management-review"
        variant="outline"
        size="lg"
        disabled={disabled}
        onClick={onReview}
      >
        {msg("review", { count: unused.total })}
      </Button>
    </div>
  );
}

export function ProjectManagementToolbar({
  query,
  onQueryChange,
  filter,
  onFilterChange,
  sort,
  onSortChange,
  unusedCount,
  busy,
  onResetView,
}: {
  query: string;
  onQueryChange(query: string): void;
  filter: ProjectManagementFilter;
  onFilterChange(filter: ProjectManagementFilter): void;
  sort: ProjectManagementSort;
  onSortChange(sort: ProjectManagementSort): void;
  unusedCount: number;
  busy: boolean;
  onResetView(): void;
}) {
  const { msg } = useMessages();
  const sortId = useId();
  return (
    <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,12rem)_auto]">
      <div className="relative min-w-0 sm:col-span-2 lg:col-span-1">
        <Search
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-foreground-subtle"
        />
        <Input
          data-testid="project-management-search"
          type="search"
          placeholder={msg("search")}
          aria-label={msg("search")}
          value={query}
          onChange={(event) => {
            onQueryChange(event.target.value);
            onResetView();
          }}
          className="pl-8 pr-8 text-mobile-input-safe sm:text-ui-base"
        />
        {query ? (
          <button
            type="button"
            aria-label={msg("clearSearch")}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-foreground-subtle hover:bg-surface-hover"
            onClick={() => {
              onQueryChange("");
              onResetView();
            }}
          >
            <X className="size-3.5" />
          </button>
        ) : null}
      </div>
      <Select
        value={filter}
        disabled={busy}
        onValueChange={(value) => {
          onFilterChange(value as ProjectManagementFilter);
          onResetView();
        }}
      >
        <SelectTrigger
          data-testid="project-management-filter"
          size="lg"
          className="h-9 w-full min-w-0"
          aria-label={msg("filterLabel")}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all" data-testid="project-management-filter-all">
            {msg("filter.all")}
          </SelectItem>
          <SelectItem value="unused" data-testid="project-management-filter-unused">
            {msg("filter.unused", { count: unusedCount })}
          </SelectItem>
        </SelectContent>
      </Select>
      <div className="flex min-w-0 items-center gap-2">
        <label htmlFor={sortId} className="shrink-0 text-ui-base text-foreground-subtle">
          {msg("sortLabel")}
        </label>
        <Select
          value={sort}
          onValueChange={(value) => onSortChange(value as ProjectManagementSort)}
        >
          <SelectTrigger
            id={sortId}
            data-testid="project-management-sort"
            size="lg"
            className="h-9 min-w-0 flex-1 lg:w-36 lg:flex-none"
            aria-label={msg("sortLabel")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORTS.map((value) => (
              <SelectItem
                key={value}
                value={value}
                data-testid={`project-management-sort-${value}`}
              >
                {msg(`sort.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

export function ProjectManagementSelectionBar({
  selectedCount,
  visibleCount,
  disabled,
  onClear,
  onRemove,
}: {
  selectedCount: number;
  visibleCount: number;
  disabled: boolean;
  onClear(): void;
  onRemove(): void;
}) {
  const { msg, count } = useMessages();
  return (
    <div
      data-testid="project-management-selection-bar"
      className="sticky bottom-4 z-10 flex min-h-12 min-w-0 flex-wrap items-center gap-3 rounded-xl border border-popover-border bg-popover py-2 pl-4 pr-2 shadow-md"
    >
      <span className="shrink-0 text-ui-base font-medium">
        {msg("selected", { count: selectedCount })}
      </span>
      <span className="hidden min-w-0 truncate text-ui-sm text-foreground-subtle sm:inline">
        {msg("ofShown", { count: visibleCount })}
      </span>
      <Button variant="ghost" className="shrink-0" onClick={onClear}>
        {msg("clearSelection")}
      </Button>
      <span className="flex-1" />
      <Button
        data-testid="project-management-remove"
        size="lg"
        variant="ghost"
        disabled={disabled}
        className="shrink-0 bg-destructive-surface text-destructive-surface-foreground hover:bg-destructive-surface"
        onClick={onRemove}
      >
        <FolderMinus className="size-4" />
        {count("removeSelected", selectedCount)}
      </Button>
    </div>
  );
}
