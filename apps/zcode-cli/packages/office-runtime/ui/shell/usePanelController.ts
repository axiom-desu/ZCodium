import { useEffect, useMemo } from "react";
import { getHost } from "#ui/host.ts";
import { applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import { strings, describeAt } from "#ui/i18n.ts";
import { describeFailure, useHostContext } from "#ui/shell/state.ts";
import { VIEWERS } from "#ui/viewers/registry.ts";
import { kindOf } from "#office/contract.ts";
import { useCaptureView } from "#ui/shell/useCaptureView.ts";
import { useShellKeys } from "#ui/shell/useShellKeys.ts";
import { DOCK_WIDTH, INLINE_HEIGHT, PAGED, ZOOMABLE } from "#ui/shell/panelConstants.ts";
import { usePanelState } from "#ui/shell/usePanelState.ts";
import { usePanelFind } from "#ui/shell/usePanelFind.ts";
import { usePanelDocument } from "#ui/shell/usePanelDocument.ts";
import { usePanelSelection } from "#ui/shell/usePanelSelection.ts";
import { usePanelEffects } from "#ui/shell/usePanelEffects.ts";

/** Composes the panel's state, data pipeline, actions and effects into one object for the view. */
export function usePanelController() {
  const state = usePanelState();
  const context = useHostContext();
  const t = strings(context?.locale ?? navigator.language);
  const dark = context?.theme === "dark";
  const inline = context?.displayMode === "inline";
  const host = getHost();

  const find = usePanelFind(state);
  const docs = usePanelDocument({ ...state, t, host, setFind: find.setFind });
  const selection = usePanelSelection({
    ...state,
    t,
    host,
    resetDocumentState: docs.resetDocumentState,
    applySnapshot: docs.applySnapshot,
    showNotice: docs.showNotice,
  });
  const effects = usePanelEffects({
    ...state,
    t,
    host,
    inline,
    applySnapshot: docs.applySnapshot,
    load: docs.load,
  });

  useEffect(() => {
    globalThis.document.documentElement.dataset.theme = dark ? "dark" : "light";
    const variables = context?.styles?.variables;
    if (variables) applyHostStyleVariables(variables);
  }, [dark, context?.styles?.variables]);

  useEffect(() => {
    if (inline) void host.app.sendSizeChanged({ height: INLINE_HEIGHT }).catch(() => undefined);
  }, [inline, host]);

  useEffect(() => {
    const app = state.appRef.current!;
    const resize = new ResizeObserver(() => state.setWide(app.clientWidth >= DOCK_WIDTH));
    resize.observe(app);
    return () => resize.disconnect();
  }, [state]);

  useCaptureView(state.docRef, state.viewer);

  const kind = state.doc?.info.kind ?? (state.pending ? kindOf(state.pending) : null);
  const path = state.pending ?? state.failure?.path ?? state.doc?.info.path ?? null;
  const docked = state.wide && !inline;
  const paged = Boolean(kind && PAGED.includes(kind));
  const drawerAvailable =
    Boolean(state.doc && state.ready && kind !== "xlsx") &&
    Boolean(state.viewer.current?.thumbnail || state.doc?.info.outline.length);

  useShellKeys({
    docRef: state.docRef,
    viewer: state.viewer,
    picked: state.picked,
    addReference: selection.addReference,
    openFind: find.openFind,
    closeFind: find.closeFind,
    clearSelection: selection.clearSelection,
    paged,
    page: state.page,
    goToPage: selection.goToPage,
    drawer: state.drawer,
    setDrawer: state.setDrawer,
    docked,
    find: find.find,
    agent: state.agent,
    setAgent: state.setAgent,
  });

  const Viewer = state.doc ? (VIEWERS[state.doc.info.kind]?.view ?? null) : null;
  const viewerProps = useMemo(
    () =>
      state.doc
        ? {
            bytes: state.doc.bytes,
            info: state.doc.info,
            blocks: state.doc.blocks,
            dark,
            glance: inline,
            onLocation: state.setLocation,
            onSelect: selection.onSelect,
            onRevealHit: selection.onRevealHit,
            onPage: state.setPage,
            onZoom: state.setZoom,
            onLink: (url: string) => void host.app.openLink({ url }).catch(() => undefined),
            onReady: docs.onReady,
            onError: (error: Error) =>
              state.setFailure(describeFailure(t, error, state.docRef.current?.info.path ?? null)),
          }
        : null,
    // `t` only words errors; a locale change does not need a new viewer.
    [state.doc, dark, inline, docs.onReady, selection.onSelect, selection.onRevealHit],
  );

  return {
    ...state,
    ...find,
    ...docs,
    ...selection,
    ...effects,
    context,
    t,
    dark,
    inline,
    host,
    kind,
    path,
    docked,
    paged,
    drawerAvailable,
    Viewer,
    viewerProps,
    ZOOMABLE,
    showSkeleton: !state.failure && (Boolean(state.pending) || Boolean(state.doc && !state.ready)),
    nothing: !state.doc && !state.pending && !state.failure,
    label: state.picked ? describeAt(state.picked.selection.at, t) : "",
  };
}

export type PanelController = ReturnType<typeof usePanelController>;
