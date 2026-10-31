import type { DocKind } from "#office/contract.ts";

export const PAGED: DocKind[] = ["pdf", "docx", "pptx"];
/** Viewers with fit modes and zoom in the page control. */
export const ZOOMABLE: DocKind[] = ["pdf", "docx"];
/** Below this panel width the drawer floats over the pages; at or above it, it docks. */
export const DOCK_WIDTH = 720;
export const INLINE_HEIGHT = 380;
