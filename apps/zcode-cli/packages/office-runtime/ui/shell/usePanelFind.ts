import { useCallback } from "react";
import { useFind } from "#ui/shell/useFind.ts";
import type { PanelState } from "#ui/shell/usePanelState.ts";

/** Find opens after clearing the mutually exclusive selection, agent marks and menus. */
export function usePanelFind(state: PanelState) {
  const { viewer, docRef, ready, setPicked, setAgent, setMenu } = state;
  const onOpenFind = useCallback(() => {
    viewer.current?.clearReveal();
    viewer.current?.clearSelection();
    setPicked(null);
    setAgent(null);
    setMenu(null);
  }, [setPicked, setAgent, setMenu, viewer]);
  return { onOpenFind, ...useFind({ viewer, docRef, ready, onOpen: onOpenFind }) };
}
