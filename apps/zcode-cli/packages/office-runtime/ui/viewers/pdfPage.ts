import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import * as pdfjs from "pdfjs-dist";
import { safeExternalUrl } from "#ui/dom.ts";
import { pageTextContent, type PageSlot } from "#ui/viewers/pdfAssets.ts";
import type { ViewerProps } from "#ui/viewers/types.ts";

/** Refs and callbacks the page renderer shares with the viewer component. */
interface PdfPageContext {
  docRef: { current: PDFDocumentProxy | null };
  scaleRef: { current: number };
  generation: { current: number };
  slots: { current: PageSlot[] };
  pageTexts: { current: Promise<string>[] };
  callbacks: { current: ViewerProps };
  scrollToPage(page: number): void;
  decorate(page: number): void;
}

export function createPageRenderer(ctx: PdfPageContext) {
  function renderPage(index: number): Promise<void> {
    const slot = ctx.slots.current[index];
    if (!slot) return Promise.resolve();
    return (slot.done ??= draw(index, slot));
  }

  async function draw(index: number, slot: PageSlot) {
    const doc = ctx.docRef.current;
    if (!doc) return;
    const currentScale = ctx.scaleRef.current;
    const mine = ctx.generation.current;
    const page = await doc.getPage(index + 1);
    // The pane was resized while the page loaded: a newer render owns this slot now.
    if (ctx.generation.current !== mine) return;
    const viewport = page.getViewport({ scale: currentScale });
    const ratio = window.devicePixelRatio || 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const textLayer = document.createElement("div");
    textLayer.className = "textLayer";
    const links = document.createElement("div");
    links.className = "pdf-links";
    slot.element.style.setProperty("--scale-factor", String(currentScale));
    slot.element.style.setProperty("--user-unit", "1");
    slot.element.style.setProperty("--total-scale-factor", String(currentScale));
    slot.element.replaceChildren(canvas, textLayer, links);
    const task = page.render({
      canvas,
      canvasContext: canvas.getContext("2d")!,
      viewport,
      transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
    });
    slot.task = task;
    try {
      await task.promise;
      if (ctx.generation.current !== mine) return;
      // 文字层用归一后的文字：复制、选区引用、查找与 Agent 引文定位都要看到“文”而不是“⽂”。
      const content = await pageTextContent(page);
      if (ctx.generation.current !== mine) return;
      const text = new pdfjs.TextLayer({
        textContentSource: content,
        container: textLayer,
        viewport,
      });
      await text.render();
      if (ctx.generation.current !== mine || !textLayer.isConnected) return;
      slot.textLayer = textLayer;
      await addLinks(page, viewport, links);
      ctx.decorate(index + 1);
    } catch (error) {
      if ((error as Error)?.name !== "RenderingCancelledException")
        console.warn("pdf render", error);
    }
  }

  async function addLinks(
    page: PDFPageProxy,
    viewport: ReturnType<PDFPageProxy["getViewport"]>,
    layer: HTMLDivElement,
  ) {
    const annotations = await page.getAnnotations({ intent: "display" });
    for (const annotation of annotations) {
      if (annotation.subtype !== "Link") continue;
      const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(annotation.rect);
      const link = document.createElement("a");
      link.className = "pdf-link";
      link.style.left = `${Math.min(x1, x2)}px`;
      link.style.top = `${Math.min(y1, y2)}px`;
      link.style.width = `${Math.abs(x2 - x1)}px`;
      link.style.height = `${Math.abs(y2 - y1)}px`;
      const url = safeExternalUrl(annotation.url ?? annotation.unsafeUrl);
      if (url) {
        link.title = url;
        link.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          ctx.callbacks.current.onLink(url);
        });
      } else if (annotation.dest) {
        link.addEventListener("click", async (event) => {
          event.preventDefault();
          event.stopPropagation();
          const target = await resolveDest(annotation.dest);
          if (target) ctx.scrollToPage(target);
        });
      } else continue;
      layer.append(link);
    }
  }

  async function resolveDest(dest: unknown): Promise<number | null> {
    const doc = ctx.docRef.current;
    if (!doc) return null;
    const explicit = typeof dest === "string" ? await doc.getDestination(dest) : dest;
    const target = Array.isArray(explicit) ? explicit[0] : null;
    if (target && typeof target === "object") return (await doc.getPageIndex(target)) + 1;
    return typeof target === "number" ? target + 1 : null;
  }

  function pageText(n: number): Promise<string> {
    const doc = ctx.docRef.current;
    if (!doc) return Promise.resolve("");
    return (ctx.pageTexts.current[n - 1] ??= doc
      .getPage(n)
      .then(pageTextContent)
      .then((content) => content.items.map((item) => ("str" in item ? item.str : "")).join(" "))
      .catch(() => ""));
  }

  return { renderPage, pageText };
}
