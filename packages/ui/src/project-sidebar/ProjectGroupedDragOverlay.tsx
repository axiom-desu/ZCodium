import { cn } from "@/components/lib/utils.js";
import type { ProjectGroupedRow } from "./grouped.js";
import { GROUP_COLOR_CLASS } from "./grouped-colors.js";
import type { ProjectGroupedDragSource } from "./grouped-drag.js";

/** 拖拽浮层只复制当前行视觉，不挂原行交互，也不写任何事实。 */
export function ProjectGroupedDragOverlay({
  source,
  x,
  y,
  rows,
}: {
  source: ProjectGroupedDragSource;
  x: number;
  y: number;
  rows: readonly ProjectGroupedRow[];
}) {
  const row = rows.find((candidate) => candidate.key === source.rowKey);
  if (!row || row.type === "empty") return null;
  return (
    <div
      data-testid="project-grouped-drag-overlay"
      className="pointer-events-none fixed z-50 max-w-[280px] rounded-lg border border-border bg-background px-2.5 py-1.5 text-ui-base text-foreground shadow-lg"
      style={{ left: x, top: y }}
    >
      {row.type === "group" ? (
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn("size-2 shrink-0 rounded-full", GROUP_COLOR_CLASS[row.group.color])}
          />
          <span className="truncate">{row.group.title}</span>
        </div>
      ) : (
        <div className="min-w-0 truncate">{row.task.title}</div>
      )}
    </div>
  );
}
