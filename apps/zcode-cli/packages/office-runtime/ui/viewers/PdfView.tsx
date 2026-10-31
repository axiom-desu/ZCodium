import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { createPageRenderer } from "#ui/viewers/pdfPage.ts";
import { createViewerHandle } from "#ui/viewers/pdfHandle.ts";
import {
  boxOf,
  pointOn,
  findAllRanges,
  findTextRange,
  paintRanges,
  scrollToElement,
  selectionIn,
  trackTopmost,
} from "#ui/dom.ts";
import {
  nextZoom,
  type ViewerHandle,
  type ViewerProps,
} from "#ui/viewers/types.ts";

import {
  AssetBinaryFactory,
  AssetCMapFactory,
  CSS_UNITS,
  PADDING,
  worker,
  type PageSlot,
  type RevealItem,
  type Zoom,
} from "#ui/viewers/pdfAssets.ts";
export const PdfView = forwardRef<ViewerHandle, ViewerProps>(function PdfView(props, ref) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const slots = useRef<PageSlot[]>([]);
  const sizes = useRef<{ width: number; height: number }[]>([]);
  const [zoom, setZoom] = useState<Zoom>({ mode: "width", percent: 100 });
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [loaded, setLoaded] = useState(0);
  const callbacks = useRef(props);
  callbacks.current = props;
  const glance = Boolean(props.glance);

  const scale = (() => {
    if (!loaded || !box.width || !sizes.current.length) return 0;
    const maxWidth = Math.max(...sizes.current.map((size) => size.width));
    const maxHeight = Math.max(...sizes.current.map((size) => size.height));
    const columns = glance && box.width >= 520 ? 2 : 1;
    const fitWidth = Math.min(4, (box.width - PADDING * (columns + 1)) / columns / maxWidth);
    if (zoom.mode === "width" || glance) return fitWidth;
    if (zoom.mode === "page") return Math.min(fitWidth, (box.height - PADDING * 2) / maxHeight);
    if (zoom.mode === "actual") return CSS_UNITS;
    return (zoom.percent / 100) * CSS_UNITS;
  })();
  const scaleRef = useRef(scale);
  const previousScale = useRef(0);
  scaleRef.current = scale;
  /** Point (in container coordinates) that should stay put across the next zoom change. */
  const zoomAnchor = useRef<{ x: number; y: number } | null>(null);
  const observer = useRef<IntersectionObserver | null>(null);
  /** Bumped whenever pages are resized; a render from an older generation must not land. */
  const generation = useRef(0);

  // Decorations that must survive re-rendering a page (zoom replaces the text layers).
  const revealItems = useRef<RevealItem[]>([]);
  const revealRanges = useRef(new Map<number, Range>());
  const find = useRef<{
    query: string;
    matches: { page: number; k: number }[];
    current: number;
    ranges: Map<number, Range[]>;
  } | null>(null);
  const pageTexts = useRef<Promise<string>[]>([]);
  const { renderPage, pageText } = createPageRenderer({
    docRef,
    scaleRef,
    generation,
    slots,
    pageTexts,
    callbacks,
    scrollToPage,
    decorate,
  });


  // Load the document.
  useEffect(() => {
    let cancelled = false;
    let loadedDoc: PDFDocumentProxy | null = null;
    (async () => {
      const task = pdfjs.getDocument({
        worker: await worker(),
        data: new Uint8Array(props.bytes.slice(0)),
        cMapUrl: "pdfjs/cmaps/",
        cMapPacked: true,
        standardFontDataUrl: "pdfjs/standard_fonts/",
        wasmUrl: "pdfjs/wasm/",
        CMapReaderFactory: AssetCMapFactory,
        StandardFontDataFactory: AssetBinaryFactory,
        WasmFactory: AssetBinaryFactory,
        useWorkerFetch: false,
        isEvalSupported: false,
        enableXfa: false,
      });
      loadedDoc = await task.promise;
      if (cancelled) return void loadedDoc.destroy();
      docRef.current = loadedDoc;
      const pageSizes: { width: number; height: number }[] = [];
      const count = glance ? Math.min(4, loadedDoc.numPages) : loadedDoc.numPages;
      for (let n = 1; n <= count; n++) {
        const page = await loadedDoc.getPage(n);
        const viewport = page.getViewport({ scale: 1 });
        pageSizes.push({ width: viewport.width, height: viewport.height });
      }
      if (cancelled) return;
      sizes.current = pageSizes;
      const container = scrollRef.current!;
      container.replaceChildren();
      slots.current = pageSizes.map((_, i) => {
        const element = document.createElement("div");
        element.className = "pdf-page";
        element.dataset.at = `page:${i + 1}`;
        container.append(element);
        return { element };
      });
      setBox({ width: container.clientWidth, height: container.clientHeight });
      setLoaded((value) => value + 1);
      callbacks.current.onPage?.({ current: 1, count: loadedDoc.numPages });
      callbacks.current.onReady();
    })().catch((error) => !cancelled && callbacks.current.onError(error));
    return () => {
      cancelled = true;
      observer.current?.disconnect();
      void loadedDoc?.destroy();
      docRef.current = null;
      pageTexts.current = [];
    };
  }, [props.bytes, glance]);

  // Follow the pane size.
  useEffect(() => {
    const container = scrollRef.current!;
    const resize = new ResizeObserver(() =>
      setBox((previous) =>
        Math.abs(previous.width - container.clientWidth) > 1 ||
        Math.abs(previous.height - container.clientHeight) > 1
          ? { width: container.clientWidth, height: container.clientHeight }
          : previous,
      ),
    );
    resize.observe(container);
    return () => resize.disconnect();
  }, []);

  // Report the zoom the control shows.
  useEffect(() => {
    if (!scale) return;
    callbacks.current.onZoom?.({
      mode: zoom.mode,
      percent: Math.round((scale / CSS_UNITS) * 100),
    });
  }, [scale, zoom.mode]);

  // Size page placeholders, keep the anchor point in place, render what is visible.
  useLayoutEffect(() => {
    const doc = docRef.current;
    const container = scrollRef.current;
    if (!doc || !scale || !container) return;
    const before = previousScale.current;
    previousScale.current = scale;
    const anchor = zoomAnchor.current ?? {
      x: container.clientWidth / 2,
      y: container.clientHeight / 2,
    };
    zoomAnchor.current = null;
    const fraction = {
      x: container.scrollLeft + anchor.x,
      y: container.scrollTop + anchor.y,
    };
    observer.current?.disconnect();
    generation.current++;
    for (const [i, slot] of slots.current.entries()) {
      slot.task?.cancel();
      slot.done = undefined;
      slot.textLayer = undefined;
      slot.element.replaceChildren();
      slot.element.style.width = `${sizes.current[i].width * scale}px`;
      slot.element.style.height = `${sizes.current[i].height * scale}px`;
    }
    revealRanges.current.clear();
    find.current?.ranges.clear();
    paint();
    if (before && before !== scale) {
      const ratio = scale / before;
      container.scrollTo({
        left: Math.max(0, (fraction.x - PADDING) * ratio + PADDING - anchor.x),
        top: Math.max(0, (fraction.y - PADDING) * ratio + PADDING - anchor.y),
      });
    }
    observer.current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const index = slots.current.findIndex((slot) => slot.element === entry.target);
          if (index >= 0) void renderPage(index);
        }
      },
      { root: container, rootMargin: "600px 0px" },
    );
    for (const slot of slots.current) observer.current.observe(slot.element);
  }, [scale]);

  function scrollToPage(page: number) {
    const slot = slots.current[page - 1];
    if (slot) scrollToElement(slot.element, "start");
  }

  /** Page `n` with its text layer for the current scale (null if it does not exist). */
  async function rendered(n: number): Promise<PageSlot | null> {
    const slot = slots.current[n - 1];
    if (!slot) return null;
    // A resize while waiting starts a fresh render; wait for that one too.
    for (let attempt = 0; attempt < 5; attempt++) {
      await renderPage(n - 1);
      if (slot.textLayer?.isConnected) return slot;
    }
    return null;
  }

  /** Re-attach reveal and find highlights to a freshly rendered page. */
  function decorate(page: number) {
    const slot = slots.current[page - 1];
    if (!slot?.textLayer) return;
    revealItems.current.forEach((item, i) => {
      if (!item.quote || item.page !== page) return;
      // Always re-find on the live layer: a range on a replaced layer would paint nothing.
      const current = revealRanges.current.get(i);
      if (current && slot.textLayer!.contains(current.startContainer)) return;
      const range = findTextRange(slot.textLayer!, item.quote);
      if (range) revealRanges.current.set(i, range);
      else revealRanges.current.delete(i);
    });
    if (find.current?.query)
      find.current.ranges.set(page, findAllRanges(slot.textLayer, find.current.query));
    paint();
  }

  function currentFindRange(): Range | null {
    const state = find.current;
    const match = state?.matches[state.current];
    if (!state || !match) return null;
    const ranges = state.ranges.get(match.page) ?? [];
    return ranges[Math.min(match.k, ranges.length - 1)] ?? null;
  }

  function paint() {
    paintRanges("office-reveal", [...revealRanges.current.values()]);
    const current = currentFindRange();
    paintRanges(
      "office-find",
      [...(find.current?.ranges.values() ?? [])].flat().filter((range) => range !== current),
    );
    paintRanges("office-find-current", current ? [current] : []);
  }

  // Visible page tracking.
  useEffect(() => {
    const container = scrollRef.current!;
    return trackTopmost(
      container,
      () => slots.current.map((slot) => slot.element),
      (element) => element.dataset.at ?? null,
      (at) => {
        callbacks.current.onLocation(at);
        callbacks.current.onPage?.({
          current: Number(at.slice(5)),
          count: docRef.current?.numPages ?? slots.current.length,
        });
      },
      1 / 3,
    );
  }, []);

  // ⌘/Ctrl + wheel zooms around the pointer, like ZCode's PDF preview.
  useEffect(() => {
    const container = scrollRef.current!;
    let accumulated = 0;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      accumulated += event.deltaY;
      if (Math.abs(accumulated) < 40) return;
      const direction = accumulated < 0 ? 1 : -1;
      accumulated = 0;
      const rect = container.getBoundingClientRect();
      zoomAnchor.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      stepZoom(direction);
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, []);

  function stepZoom(direction: 1 | -1) {
    const percent = Math.round((scaleRef.current / CSS_UNITS) * 100);
    setZoom({ mode: null, percent: nextZoom(percent, direction) });
  }

  // Selection: text selection inside pages, or a click on a page outside its text.
  useEffect(() => {
    const container = scrollRef.current!;
    const pageOf = (node: Node | null) =>
      (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>(".pdf-page")
        ?.dataset.at;
    const clearPage = () =>
      container
        .querySelectorAll(".pdf-page.selected")
        .forEach((element) => element.classList.remove("selected"));
    const report = (event: Event) => {
      const selected = selectionIn(container);
      if (selected) {
        const start = pageOf(selected.range.startContainer);
        const end = pageOf(selected.range.endContainer);
        if (!start) return;
        clearPage();
        const a = Number(start.slice(5));
        const b = end ? Number(end.slice(5)) : a;
        const range = selected.range.cloneRange();
        callbacks.current.onSelect(
          { at: b > a ? `page:${a}-${b}` : start, text: selected.text },
          { text: true, locate: () => boxOf(range), user: true },
        );
        return;
      }
      if (event.type !== "mouseup") return;
      // A click on one of the agent's marks brings its note back instead of selecting.
      const { clientX, clientY } = event as MouseEvent;
      for (const [i, range] of revealRanges.current)
        if (pointOn(range, clientX, clientY) && callbacks.current.onRevealHit?.(i)) {
          clearPage();
          callbacks.current.onSelect(null);
          return;
        }
      const target = event.target as Element;
      if (target.closest(".pdf-link")) return;
      const page = target.closest<HTMLElement>(".pdf-page");
      clearPage();
      // A click on text (no drag) or outside the pages clears the selection.
      if (!page?.dataset.at || target.closest(".textLayer span")) {
        callbacks.current.onSelect(null);
        return;
      }
      page.classList.add("selected");
      callbacks.current.onSelect(
        { at: page.dataset.at, text: "" },
        { text: false, locate: () => boxOf(page), user: true },
      );
    };
    const onUp = (event: Event) => setTimeout(() => report(event), 0);
    container.addEventListener("mouseup", onUp);
    container.addEventListener("keyup", onUp);
    return () => {
      container.removeEventListener("mouseup", onUp);
      container.removeEventListener("keyup", onUp);
    };
  }, []);

  useImperativeHandle(ref, (): ViewerHandle => createViewerHandle({
    docRef,
    scrollRef,
    slots,
    find,
    revealItems,
    revealRanges,
    callbacks,
    pageText,
    paint,
    rendered,
    decorate,
    currentFindRange,
    scrollToPage,
    stepZoom,
    setZoom,
  }), []);


  return <div ref={scrollRef} className={`viewer-scroll pdf-scroll${glance ? " glance" : ""}`} />;
});
