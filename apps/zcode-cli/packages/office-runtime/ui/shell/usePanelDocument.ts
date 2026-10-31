import { useCallback } from "react";
import { readFileBytes } from "#ui/assets.ts";
import { VIEWERS } from "#ui/viewers/registry.ts";
import { call } from "#ui/rpc.ts";
import { CLOSED_FIND } from "#ui/shell/useFind.ts";
import { describeFailure, writeRecent } from "#ui/shell/state.ts";
import type {
  DocumentInfo,
  DocxBlockKey,
  FileHandle,
  ShowTarget,
  ViewerSnapshot,
} from "#office/contract.ts";
import type { PanelDocumentContext } from "#ui/shell/panelContext.ts";
import type { RevealedTarget } from "#ui/viewers/types.ts";

/** Load / reveal / snapshot pipeline of the panel; owns the load generation and pending reveal. */
export function usePanelDocument(ctx: PanelDocumentContext) {
  const {
    t,
    host,
    viewer,
    viewerReady,
    docRef,
    loadSeq,
    loadingPath,
    loadKey,
    pendingReveal,
    lastRevealSeq,
    dismissedRevision,
    pinned,
    setDoc,
    setPending,
    setReady,
    setFailure,
    setPicked,
    setBarMode,
    setAgent,
    setOffscreen,
    setLocation,
    setPage,
    setZoom,
    setChanged,
    setNotice,
    setRecent,
    setFind,
  } = ctx;
  const showNotice = useCallback((text: string) => {
    setNotice(text);
    setTimeout(() => setNotice((current) => (current === text ? null : current)), 2500);
  }, []);

  const resetDocumentState = useCallback(() => {
    viewerReady.current = false;
    setReady(false);
    setPicked(null);
    setBarMode("bar");
    setAgent(null);
    setOffscreen(null);
    setLocation(null);
    setPage(null);
    setZoom(null);
    setChanged(null);
    setFind(CLOSED_FIND);
  }, []);

  const load = useCallback(
    async (target: string, reveal?: { targets: ShowTarget[]; note: string | null } | null) => {
      const mine = ++loadSeq.current;
      if (reveal) pendingReveal.current = reveal;
      else if (loadingPath.current !== target) pendingReveal.current = null;
      loadingPath.current = target;
      setPending(target);
      setFailure(null);
      try {
        const loaded = await call<{
          info: DocumentInfo;
          file: FileHandle;
          blocks?: DocxBlockKey[];
        }>("load_document", { path: target });
        const [bytes] = await Promise.all([
          readFileBytes(loaded.file),
          VIEWERS[loaded.info.kind]?.prepare?.(),
        ]);
        if (mine !== loadSeq.current) return;
        resetDocumentState();
        dismissedRevision.current = null;
        setDoc({ info: loaded.info, bytes, blocks: loaded.blocks, key: ++loadKey.current });
        host.saveDocument(loaded.info.path);
        setRecent((items) => {
          const next = [
            { path: loaded.info.path, kind: loaded.info.kind },
            ...items.filter((item) => item.path !== loaded.info.path),
          ].slice(0, 5);
          writeRecent(next);
          return next;
        });
      } catch (error) {
        if (mine !== loadSeq.current) return;
        setDoc(null);
        resetDocumentState();
        setFailure(describeFailure(t, error, target));
      } finally {
        if (mine === loadSeq.current) {
          setPending(null);
          loadingPath.current = null;
        }
      }
    },
    [resetDocumentState, t],
  );

  const runReveal = useCallback(async (targets: ShowTarget[], note: string | null) => {
    const handle = viewer.current;
    if (!handle) return;
    // The agent's marks and find highlights are never shown together.
    handle.clearFind();
    setFind(CLOSED_FIND);
    const results = await handle.reveal(targets).catch(() => [] as RevealedTarget[]);
    pinned.current = results.length > 0;
    setAgent(
      results.length
        ? { note, targets: results, index: 0, visible: Boolean(note) || results.length > 1 }
        : null,
    );
  }, []);

  const applyReveal = useCallback(
    (targets: ShowTarget[], note: string | null) => {
      if (viewer.current && viewerReady.current) void runReveal(targets, note);
      else pendingReveal.current = { targets, note };
    },
    [runReveal],
  );

  /** Bring the viewer in line with a snapshot from the server (tool result or get_viewer). */
  const applySnapshot = useCallback(
    (snapshot: ViewerSnapshot | undefined) => {
      if (!snapshot?.document) return;
      const reveal =
        snapshot.reveal && snapshot.reveal.seq > lastRevealSeq.current ? snapshot.reveal : null;
      if (reveal) lastRevealSeq.current = reveal.seq;
      const current = docRef.current?.info;
      const pointer = reveal ? { targets: reveal.targets, note: reveal.note ?? null } : null;
      if (
        !current ||
        current.path !== snapshot.document.path ||
        current.revision !== snapshot.document.revision
      ) {
        void load(snapshot.document.path, pointer);
      } else if (pointer) applyReveal(pointer.targets, pointer.note);
    },
    [load, applyReveal],
  );

  const onReady = useCallback(() => {
    viewerReady.current = true;
    setReady(true);
    const reveal = pendingReveal.current;
    pendingReveal.current = null;
    if (reveal?.targets.length) setTimeout(() => void runReveal(reveal.targets, reveal.note), 50);
  }, [runReveal, viewerReady, pendingReveal, setReady]);

  return { showNotice, resetDocumentState, load, runReveal, applyReveal, applySnapshot, onReady };
}
