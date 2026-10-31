import {
  boxOf,
  countMatches,
  findAllRanges,
  findTextRange,
  scrollToRange,
  selectionIn,
} from "#ui/dom.ts";
import { parseLocator } from "#office/domain/anchor.ts";
import { canvasToPng } from "#ui/raster.ts";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { PageSlot, RevealItem, Zoom } from "#ui/viewers/pdfAssets.ts";
import type { RevealedTarget, ViewerHandle, ViewerProps } from "#ui/viewers/types.ts";

/** Everything the page handle reads or changes, owned by the viewer component. */
interface PdfHandleContext {
  docRef: { current: PDFDocumentProxy | null };
  scrollRef: { current: HTMLDivElement | null };
  slots: { current: PageSlot[] };
  find: { current: FindState | null };
  revealItems: { current: RevealItem[] };
  revealRanges: { current: Map<number, Range> };
  callbacks: { current: ViewerProps };
  pageText(n: number): Promise<string>;
  paint(): void;
  rendered(n: number): Promise<PageSlot | null>;
  decorate(page: number): void;
  currentFindRange(): Range | null;
  scrollToPage(page: number): void;
  stepZoom(direction: 1 | -1): void;
  setZoom(zoom: Zoom): void;
}

interface FindState {
  query: string;
  matches: { page: number; k: number }[];
  current: number;
  ranges: Map<number, Range[]>;
}

export function createViewerHandle(ctx: PdfHandleContext): ViewerHandle {
  const {
    docRef,
    scrollRef,
    slots,
    find,
    revealItems,
    revealRanges,
    pageText,
    paint,
    rendered,
    decorate,
    currentFindRange,
    scrollToPage,
    stepZoom,
    setZoom,
  } = ctx;
  return {
    async reveal(targets) {
      this.clearReveal();
      const items: RevealItem[] = [];
      for (const target of targets) {
        const locator = parseLocator("pdf", target.at);
        if (locator.kind !== "pdf" || !slots.current[locator.from - 1]) continue;
        items.push({
          page: locator.from,
          to: locator.to,
          ...(target.quote ? { quote: target.quote } : {}),
        });
      }
      revealItems.current = items;
      // Quotes may sit on any page of a range: find the page that has it.
      for (const [i, item] of items.entries()) {
        if (!item.quote) {
          for (let n = item.page; n <= item.to; n++)
            slots.current[n - 1]?.element.classList.add("revealed");
          continue;
        }
        for (let n = item.page; n <= item.to; n++) {
          const slot = await rendered(n);
          const range = slot?.textLayer && findTextRange(slot.textLayer, item.quote);
          if (range) {
            item.page = n;
            revealRanges.current.set(i, range);
            break;
          }
        }
      }
      paint();
      const results: RevealedTarget[] = items.map((item, i) => ({
        at:
          item.to > item.page && !item.quote ? `page:${item.page}-${item.to}` : `page:${item.page}`,
        locate: () =>
          boxOf(revealRanges.current.get(i)) ?? boxOf(slots.current[item.page - 1]?.element),
        scrollTo: () => {
          const range = revealRanges.current.get(i);
          if (range?.startContainer.isConnected) scrollToRange(range, "upper");
          else if (item.quote)
            void rendered(item.page).then(() => {
              decorate(item.page);
              const again = revealRanges.current.get(i);
              if (again) scrollToRange(again, "upper");
              else scrollToPage(item.page);
            });
          else scrollToPage(item.page);
        },
      }));
      results[0]?.scrollTo();
      return results;
    },
    goTo(at) {
      const locator = parseLocator("pdf", at);
      if (locator.kind === "pdf") scrollToPage(locator.from);
    },
    clearReveal() {
      revealItems.current = [];
      revealRanges.current.clear();
      scrollRef.current
        ?.querySelectorAll(".pdf-page.revealed")
        .forEach((element) => element.classList.remove("revealed"));
      paint();
    },
    async capture(at, maxWidth) {
      const doc = docRef.current;
      if (!doc) throw new Error("The PDF is still loading.");
      const page = at ? parseLocator("pdf", at) : null;
      const number =
        page?.kind === "pdf"
          ? page.from
          : Number(
              (
                slots.current.find(
                  (slot) =>
                    slot.element.getBoundingClientRect().bottom >
                    scrollRef.current!.getBoundingClientRect().top + 8,
                )?.element.dataset.at ?? "page:1"
              ).slice(5),
            );
      if (number < 1 || number > doc.numPages)
        throw new Error(`Page ${number} does not exist; the PDF has ${doc.numPages} pages.`);
      const pdfPage = await doc.getPage(number);
      const base = pdfPage.getViewport({ scale: 1 });
      const viewport = pdfPage.getViewport({ scale: Math.min(3, maxWidth / base.width) });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await pdfPage.render({ canvas, canvasContext: context, viewport }).promise;
      return { ...canvasToPng(canvas, maxWidth), at: `page:${number}` };
    },
    zoom(direction) {
      stepZoom(direction);
    },
    fit(mode) {
      setZoom({ mode, percent: 100 });
    },
    async find(query) {
      const doc = docRef.current;
      if (!doc || !query.trim()) {
        this.clearFind();
        return 0;
      }
      const state = {
        query,
        matches: [] as { page: number; k: number }[],
        current: -1,
        ranges: new Map<number, Range[]>(),
      };
      find.current = state;
      const counts = await Promise.all(
        Array.from({ length: doc.numPages }, (_, i) =>
          pageText(i + 1).then((text) => countMatches(text, query)),
        ),
      );
      if (find.current !== state) return 0;
      counts.forEach((count, i) => {
        for (let k = 0; k < count; k++) state.matches.push({ page: i + 1, k });
      });
      for (const [i, slot] of slots.current.entries())
        if (slot.textLayer) state.ranges.set(i + 1, findAllRanges(slot.textLayer, query));
      paint();
      return state.matches.length;
    },
    findGo(index) {
      const state = find.current;
      const match = state?.matches[index];
      if (!state || !match) return;
      state.current = index;
      void rendered(match.page).then(() => {
        if (find.current !== state || state.current !== index) return;
        if (!state.ranges.has(match.page)) decorate(match.page);
        paint();
        const range = currentFindRange();
        if (range) scrollToRange(range, "center");
        else scrollToPage(match.page);
      });
      paint();
    },
    clearFind() {
      find.current = null;
      paint();
    },
    clearSelection() {
      scrollRef.current
        ?.querySelectorAll(".pdf-page.selected")
        .forEach((element) => element.classList.remove("selected"));
      const selection = document.getSelection();
      if (selection && scrollRef.current && selectionIn(scrollRef.current))
        selection.removeAllRanges();
    },
    goToPage(page) {
      scrollToPage(Math.min(Math.max(1, page), slots.current.length));
    },
    async thumbnail(page, width) {
      const doc = docRef.current;
      if (!doc) throw new Error("The PDF is still loading.");
      const pdfPage = await doc.getPage(page);
      const base = pdfPage.getViewport({ scale: 1 });
      const ratio = window.devicePixelRatio || 1;
      const viewport = pdfPage.getViewport({ scale: (width / base.width) * ratio });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${(viewport.height / viewport.width) * width}px`;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await pdfPage.render({ canvas, canvasContext: context, viewport }).promise;
      return canvas;
    },
  };
}
