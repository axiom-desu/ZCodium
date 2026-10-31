import { useRef, useState } from "react";
import { useOffscreenTargets } from "#ui/shell/useOffscreenTargets.ts";
import {
  readRecent,
  type AgentPointer,
  type Failure,
  type LoadedDoc,
  type Picked,
  type Reference,
} from "#ui/shell/state.ts";
import type { BarMode } from "#ui/shell/controls.tsx";
import type { DrawerTab } from "#ui/shell/panes.tsx";
import type { PageState, ViewerHandle, ZoomState } from "#ui/viewers/types.ts";
import type { ShowTarget } from "#office/contract.ts";

/** All mutable viewer state and refs owned by the panel component. */
export function usePanelState() {
  const [doc, setDoc] = useState<LoadedDoc | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [menu, setMenu] = useState<"switch" | "more" | null>(null);
  const [drawer, setDrawer] = useState<{ open: boolean; tab: DrawerTab }>({
    open: false,
    tab: "pages",
  });
  const [location, setLocation] = useState<string | null>(null);
  const [page, setPage] = useState<PageState | null>(null);
  const [zoom, setZoom] = useState<ZoomState | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const [barMode, setBarMode] = useState<BarMode>("bar");
  const [copied, setCopied] = useState(false);
  const [agent, setAgent] = useState<AgentPointer | null>(null);
  const [changed, setChanged] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [recent, setRecent] = useState(readRecent);
  const [wide, setWide] = useState(false);

  const appRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [offscreen, setOffscreen] = useOffscreenTargets(canvasRef, agent);
  const viewer = useRef<ViewerHandle | null>(null);
  const viewerReady = useRef(false);
  const pendingReveal = useRef<{ targets: ShowTarget[]; note: string | null } | null>(null);
  const lastRevealSeq = useRef(0);
  const docRef = useRef<LoadedDoc | null>(null);
  docRef.current = doc;
  const loadSeq = useRef(0);
  /** Path being loaded; a second load of it without a reveal must not drop the pending one. */
  const loadingPath = useRef<string | null>(null);
  const loadKey = useRef(0);
  const references = useRef<Reference[]>([]);
  const dismissedRevision = useRef<string | null>(null);
  const pinned = useRef(false);

  return {
    doc,
    setDoc,
    pending,
    setPending,
    ready,
    setReady,
    failure,
    setFailure,
    menu,
    setMenu,
    drawer,
    setDrawer,
    location,
    setLocation,
    page,
    setPage,
    zoom,
    setZoom,
    picked,
    setPicked,
    pickedRef,
    barMode,
    setBarMode,
    copied,
    setCopied,
    agent,
    setAgent,
    changed,
    setChanged,
    notice,
    setNotice,
    recent,
    setRecent,
    wide,
    setWide,
    appRef,
    canvasRef,
    offscreen,
    setOffscreen,
    viewer,
    viewerReady,
    pendingReveal,
    lastRevealSeq,
    docRef,
    loadSeq,
    loadingPath,
    loadKey,
    references,
    dismissedRevision,
    pinned,
  };
}

export type PanelState = ReturnType<typeof usePanelState>;
