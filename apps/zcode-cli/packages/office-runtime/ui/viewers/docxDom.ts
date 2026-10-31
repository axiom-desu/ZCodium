import { parseLocator } from "#office/domain/anchor.ts";

/** Block element for a locator: `p:N` / `t:N` map to rendered elements, `t:N/rRcC` to a cell. */
export function elementsFor(root: HTMLElement, at: string): HTMLElement[] {
  const locator = parseLocator("docx", at);
  if (locator.kind !== "docx") return [];
  if (locator.type === "paragraph") {
    const out: HTMLElement[] = [];
    for (let n = locator.from; n <= locator.to; n++)
      out.push(...root.querySelectorAll<HTMLElement>(`[data-at="p:${n}"]`));
    return out;
  }
  const tables = [...root.querySelectorAll<HTMLElement>(`[data-at="t:${locator.table}"]`)];
  if (!locator.cell) return tables;
  for (const table of tables) {
    const cell = rowsOf(table)[locator.cell.row - 1]?.cells[locator.cell.col - 1];
    if (cell) return [cell as HTMLElement];
  }
  return tables;
}

/**
 * Word list bullets use private-use glyphs of the Symbol / Wingdings fonts, which the sandbox does
 * not have; map the common ones to Unicode bullets in docx-preview's generated numbering CSS.
 */
const SYMBOL_BULLETS: Record<number, string> = {
  0xf0b7: "\u2022",
  0xf0a7: "\u25aa",
  0xf06f: "\u25e6",
  0xf0a8: "\u25cb",
  0xf0d8: "\u27a2",
  0xf0e0: "\u27a2",
  0xf0fc: "\u2713",
  0xf076: "\u2756",
};
export function fixSymbolBullets(styles: HTMLElement) {
  for (const style of styles.querySelectorAll("style")) {
    const text = style.textContent ?? "";
    const next = text.replace(
      /[\uf020-\uf0ff]/g,
      (char) => SYMBOL_BULLETS[char.charCodeAt(0)] ?? "\u2022",
    );
    if (next !== text) style.textContent = next;
  }
}

export function rowsOf(table: HTMLElement): HTMLTableRowElement[] {
  return [...(table as HTMLTableElement).rows].filter((row) => row.closest("table") === table);
}

/** Canvas padding (CSS keeps .docx-scroll in step). */
export const PADDING = 16;
