import { useCallback, useEffect, useRef } from "react";
import { formatAnchor } from "#office/domain/anchor.ts";
import { PROFILE } from "#office/profile.ts";
import { wellFormed, wellFormedDeep } from "#office/domain/text.ts";
import type { Selection, ViewerSnapshot } from "#office/contract.ts";
import { call } from "#ui/rpc.ts";
import { useNativeFileInput } from "#ui/shell/panes.tsx";
import { clip, describeFailure, type PanelSelectionContext } from "#ui/shell/panelContext.ts";
import type { SelectionDetail } from "#ui/viewers/types.ts";

/** Selection bar, Add/Ask/copy, agent pointer navigation and the file picker. */
export function usePanelSelection(
  ctx: PanelSelectionContext & {
    showNotice(text: string): void;
    resetDocumentState(): void;
    applySnapshot(snapshot: ViewerSnapshot | undefined): void;
  },
) {
  const {
    doc,
    setPicked,
    picked,
    pickedRef,
    setBarMode,
    setCopied,
    setAgent,
    agent,
    canvasRef,
    viewer,
    references,
    pinned,
    docRef,
    setFailure,
    host,
    t,
    showNotice,
    resetDocumentState,
    applySnapshot,
    setMenu,
    loadSeq,
    setDoc,
  } = ctx;
  const onSelect = useCallback((next: Selection | null, detail?: SelectionDetail) => {
    setBarMode("bar");
    setCopied(false);
    setPicked(next && detail ? { selection: next, detail } : null);
    // Acting on the page dismisses the agent's note (its marks stay).
    if (next && detail?.user) setAgent((current) => current && { ...current, visible: false });
  }, []);

  const agentRef = useRef(agent);
  agentRef.current = agent;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let timer = 0;
    const resize = new ResizeObserver(() => {
      if (!pinned.current) return;
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        const current = agentRef.current;
        if (pinned.current && current) current.targets[current.index]?.scrollTo();
      }, 200);
    });
    resize.observe(canvas);
    const unpin = () => {
      pinned.current = false;
    };
    canvas.addEventListener("wheel", unpin, { passive: true });
    canvas.addEventListener("pointerdown", unpin, true);
    canvas.addEventListener("keydown", unpin, true);
    return () => {
      clearTimeout(timer);
      resize.disconnect();
      canvas.removeEventListener("wheel", unpin);
      canvas.removeEventListener("pointerdown", unpin, true);
      canvas.removeEventListener("keydown", unpin, true);
    };
  }, [doc]);
  // Clicking one of the agent's marks brings its note back, when there is one to show.
  const onRevealHit = useCallback((index: number) => {
    const current = agentRef.current;
    if (!current?.targets[index] || !(current.note || current.targets.length > 1)) return false;
    setAgent({ ...current, index, visible: true });
    return true;
  }, []);

  const clearSelection = useCallback(() => {
    viewer.current?.clearSelection();
    setPicked(null);
    setBarMode("bar");
  }, []);

  const addReference = useCallback(async () => {
    const current = docRef.current;
    if (!current || !picked) return;
    const anchor = formatAnchor(current.info.path, picked.selection.at);
    const text = picked.selection.text;
    const next = [
      ...references.current.filter((item) => item.anchor !== anchor || item.text !== text),
      { anchor, text },
    ].slice(-10);
    const lines = next.map(
      (item) => `- ${item.anchor}${item.text ? `: "${clip(item.text, 600)}"` : ""}`,
    );
    try {
      await host.ready();
      await host.app.updateModelContext({
        content: [
          {
            type: "text",
            text: wellFormed(
              `The user referenced these locations in the ${PROFILE.title.en} viewer (use read_document / show_in_viewer with the anchors):\n${lines.join("\n")}`,
            ),
          },
        ],
        structuredContent: wellFormedDeep({ references: next }),
      });
      references.current = next;
      setBarMode("added");
      const added = picked;
      setTimeout(() => {
        if (pickedRef.current === added) clearSelection();
      }, 1500);
    } catch {
      showNotice(t.contextFailed);
    }
  }, [picked, clearSelection, showNotice, t]);

  const ask = useCallback(
    async (question: string) => {
      const current = docRef.current;
      if (!current || !picked) return false;
      const anchor = formatAnchor(current.info.path, picked.selection.at);
      const text = picked.selection.text;
      const quote = text ? `\n> ${clip(text, 800).replace(/\n/g, "\n> ")}` : "";
      try {
        const result = await host.app.sendMessage({
          role: "user",
          content: [
            {
              type: "text",
              text: wellFormed(
                `${question}\n\n(About ${anchor} in the ${PROFILE.title.en} viewer${quote ? ":" : "."})${quote}`,
              ),
            },
          ],
        });
        if (result.isError) throw new Error();
        clearSelection();
        return true;
      } catch {
        showNotice(t.sendFailed);
        return false;
      }
    },
    [picked, clearSelection, showNotice, t],
  );

  const copy = useCallback(async () => {
    const text = picked?.selection.text;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // The sandbox may deny the async clipboard; the live selection still copies.
      document.execCommand("copy");
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }, [picked]);

  const goToPage = useCallback((n: number) => viewer.current?.goToPage?.(n), []);

  const stepAgent = useCallback((index?: number) => {
    setAgent((current) => {
      if (!current) return current;
      const next = index ?? (current.index + 1) % current.targets.length;
      current.targets[next]?.scrollTo();
      pinned.current = true;
      return { ...current, index: next, visible: true };
    });
  }, []);

  // Pressing on the page (outside the callout) dismisses the agent's note.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onDown = (event: PointerEvent) => {
      if ((event.target as Element).closest(".callout, .chip, .pop, .pill")) return;
      setAgent((current) => (current?.visible ? { ...current, visible: false } : current));
    };
    canvas.addEventListener("pointerdown", onDown, true);
    return () => canvas.removeEventListener("pointerdown", onDown, true);
  }, [doc]);

  const openPath = useCallback(
    (target: string) => {
      setMenu(null);
      void call<ViewerSnapshot>("open_document", { path: target }).then(applySnapshot, (error) => {
        // The user asked for another file: close this one and say why that one did not open.
        loadSeq.current++;
        setDoc(null);
        resetDocumentState();
        setFailure(describeFailure(t, error, target));
      });
    },
    [applySnapshot, resetDocumentState, t],
  );

  const filePicker = useNativeFileInput(t, openPath, (error, name) =>
    setFailure(describeFailure(t, error, name)),
  );

  return {
    onSelect,
    onRevealHit,
    clearSelection,
    addReference,
    ask,
    copy,
    goToPage,
    stepAgent,
    openPath,
    filePicker,
  };
}
