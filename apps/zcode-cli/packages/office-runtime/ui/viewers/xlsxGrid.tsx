import type { CSSProperties } from "react";
import {
  type XlsxCellRange,
  type XlsxViewerController,
} from "@extend-ai/react-xlsx";
import { formatLocator } from "#office/domain/anchor.ts";
import { boxOf } from "#ui/dom.ts";

/** 0-based viewer range → 1-based anchor locator. */
export function anchorOf(sheet: string, range: XlsxCellRange): string {
  return formatLocator({
    kind: "xlsx",
    sheet,
    range: {
      start: {
        row: Math.min(range.start.row, range.end.row) + 1,
        col: Math.min(range.start.col, range.end.col) + 1,
      },
      end: {
        row: Math.max(range.start.row, range.end.row) + 1,
        col: Math.max(range.start.col, range.end.col) + 1,
      },
    },
  });
}

/** Display value and formula of a cell; worker-backed workbooks only answer asynchronously. */
export async function cellSnapshot(controller: XlsxViewerController, row: number, col: number) {
  const sheet = controller.activeSheet;
  if (controller.getCellSnapshotAsync && sheet && controller.isWorkerBacked)
    return controller
      .getCellSnapshotAsync(sheet.workbookSheetIndex, row, col)
      .catch(() => ({ displayValue: "", formula: "" }));
  return {
    displayValue: controller.getCellDisplayValue({ row, col }),
    formula: controller.getCellFormula({ row, col }),
  };
}

/** Values of a range as tab-separated text (capped at 50 rows × 20 columns). */
export async function rangeText(controller: XlsxViewerController, range: XlsxCellRange): Promise<string> {
  const top = Math.min(range.start.row, range.end.row);
  const bottom = Math.min(Math.max(range.start.row, range.end.row), top + 49);
  const left = Math.min(range.start.col, range.end.col);
  const right = Math.min(Math.max(range.start.col, range.end.col), left + 19);
  const single = top === bottom && left === right;
  const rows: Promise<string>[] = [];
  for (let row = top; row <= bottom; row++) {
    const cells: Promise<string>[] = [];
    for (let col = left; col <= right; col++)
      cells.push(
        cellSnapshot(controller, row, col).then(({ displayValue, formula }) =>
          formula && single ? `${displayValue} (=${formula.replace(/^=/, "")})` : displayValue,
        ),
      );
    rows.push(Promise.all(cells).then((values) => values.join("\t")));
  }
  return (await Promise.all(rows)).join("\n").trim();
}

export interface Highlight {
  sheet: string;
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export const REVEAL_STYLE: CSSProperties = {
  backgroundColor: "rgba(255, 179, 0, 0.38)",
  boxShadow: "inset 0 -2px 0 #e59a00",
};
export const FIND_STYLE: CSSProperties = { backgroundColor: "rgba(255, 213, 0, 0.45)" };
export const FIND_CURRENT_STYLE: CSSProperties = {
  backgroundColor: "rgba(255, 140, 0, 0.6)",
  boxShadow: "inset 0 0 0 1px #e07b00",
};

export const inside = (item: Highlight, sheet: string, row: number, col: number) =>
  item.sheet === sheet &&
  row >= item.top &&
  row <= item.bottom &&
  col >= item.left &&
  col <= item.right;

/** The grid's drawing surface (the largest canvas); it moves as the sheet scrolls. */
export function gridCanvas(root: HTMLElement | null): HTMLCanvasElement | null {
  let best: HTMLCanvasElement | null = null;
  let area = 0;
  for (const canvas of root?.querySelectorAll<HTMLCanvasElement>(".xlsx-grid canvas") ?? []) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width * rect.height > area) {
      area = rect.width * rect.height;
      best = canvas;
    }
  }
  return best;
}

export interface Press {
  start: { x: number; y: number };
  end: { x: number; y: number };
  /** Grid surface position when pressed, to follow later scrolling. */
  surface: DOMRect | null;
}

/**
 * The grid is drawn on canvas, so cells have no boxes; the selection bar anchors to where the
 * user pressed (or dragged), shifted by however far the sheet has scrolled since.
 */
export function pressBox(root: HTMLElement | null, press: Press): DOMRect | null {
  const now = boxOf(gridCanvas(root));
  const dx = press.surface && now ? now.left - press.surface.left : 0;
  const dy = press.surface && now ? now.top - press.surface.top : 0;
  const left = Math.min(press.start.x, press.end.x) + dx;
  const top = Math.min(press.start.y, press.end.y) + dy;
  return new DOMRect(
    left,
    top - 8,
    Math.max(2, Math.abs(press.end.x - press.start.x)),
    Math.max(16, Math.abs(press.end.y - press.start.y) + 16),
  );
}

export function SheetTabs({ controller }: { controller: XlsxViewerController }) {
  if (controller.tabs.length <= 1) return null;
  return (
    <div className="sheet-tabs" role="tablist">
      {controller.tabs.map((tab, index) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={index === controller.activeTabIndex}
          className={index === controller.activeTabIndex ? "active" : ""}
          onClick={() => controller.setActiveTabIndex(index)}
          title={tab.name}
        >
          {tab.name}
        </button>
      ))}
    </div>
  );
}

