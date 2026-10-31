import * as pdfjs from "pdfjs-dist";
import type { PDFPageProxy } from "pdfjs-dist";
import { normalizeCjkCompat } from "#office/domain/cjk.ts";
import { readBinary, readText } from "#ui/assets.ts";
import type { FitMode } from "#ui/viewers/types.ts";

// pdf.js would fetch cMaps, fonts and wasm over the network; the sandbox has none, so read them
// through the plugin's MCP resources instead.
export class AssetCMapFactory {
  constructor(private readonly options: { baseUrl: string | null; isCompressed: boolean }) {}
  async fetch({ name }: { name: string }) {
    return {
      cMapData: await readBinary(`${this.options.baseUrl}${name}.bcmap`),
      isCompressed: true,
    };
  }
}
export class AssetBinaryFactory {
  constructor(private readonly options: { baseUrl: string | null }) {}
  async fetch({ filename }: { filename: string }) {
    return readBinary(`${this.options.baseUrl}${filename}`);
  }
}

let sharedWorker: Promise<pdfjs.PDFWorker> | undefined;
/**
 * One pdf.js worker for the page's lifetime. Passed explicitly, so destroying a document (reload,
 * switching files) never tears down the worker the next document is about to use.
 */
export function worker(): Promise<pdfjs.PDFWorker> {
  return (sharedWorker ??= readText("pdf-worker.js").then((source) => {
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    return pdfjs.PDFWorker.create({ port: new Worker(url, { type: "module" }) });
  }));
}

type TextContent = Awaited<ReturnType<PDFPageProxy["getTextContent"]>>;

/** Page text with CJK radicals mapped back to ideographs (see src/domain/cjk.ts). */
export async function pageTextContent(page: PDFPageProxy): Promise<TextContent> {
  const content = await page.getTextContent();
  return {
    ...content,
    items: content.items.map((item) =>
      "str" in item ? { ...item, str: normalizeCjkCompat(item.str) } : item,
    ),
  };
}

export interface PageSlot {
  element: HTMLDivElement;
  /** Resolves when the canvas and text layer of the current scale are in place. */
  done?: Promise<void>;
  task?: { cancel(): void };
  textLayer?: HTMLDivElement;
}

/** Canvas padding and the gap between pages (CSS keeps these in step). */
export const PADDING = 16;
/** pdf.js scale 1 is 72 dpi; "100%" means actual size at 96 CSS px per inch. */
export const CSS_UNITS = 96 / 72;

export interface Zoom {
  mode: FitMode | null;
  /** Percent of actual size when mode is null. */
  percent: number;
}

export interface RevealItem {
  page: number;
  to: number;
  quote?: string;
}
