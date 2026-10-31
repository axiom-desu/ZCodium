import type { Dispatch, SetStateAction } from "react";
import type { getHost } from "#ui/host.ts";
import type { PanelState } from "#ui/shell/usePanelState.ts";
import type { strings } from "#ui/i18n.ts";
import type { CLOSED_FIND } from "#ui/shell/useFind.ts";
import type { ViewerSnapshot } from "#office/contract.ts";
export { clip, describeFailure } from "#ui/shell/state.ts";

export type Host = ReturnType<typeof getHost>;
export type Strings = ReturnType<typeof strings>;
export type FindState = typeof CLOSED_FIND;

/** Shared inputs of the panel hooks: all viewer state plus the host-facing wording. */
export type PanelContext = PanelState & { t: Strings; host: Host };

export type PanelDocumentContext = PanelContext & {
  setFind: Dispatch<SetStateAction<FindState>>;
};

export type PanelSelectionContext = PanelContext & {
  resetDocumentState(): void;
  applySnapshot(snapshot: ViewerSnapshot | undefined): void;
};
