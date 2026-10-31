import { useEffect } from "react";
import { call } from "#ui/rpc.ts";
import { readRecent } from "#ui/shell/state.ts";
import type { ViewerSnapshot } from "#office/contract.ts";
import type { PanelContext } from "#ui/shell/panelContext.ts";
import type { ShowTarget } from "#office/contract.ts";

/** Host -> panel tool results, debounced view reporting and on-disk change detection. */
export function usePanelEffects(
  ctx: PanelContext & {
    inline: boolean;
    applySnapshot(snapshot: ViewerSnapshot | undefined): void;
    load(path: string, reveal?: { targets: ShowTarget[]; note: string | null } | null): void;
  },
) {
  const {
    doc,
    docRef,
    picked,
    host,
    inline,
    location,
    dismissedRevision,
    setChanged,
    setRecent,
    applySnapshot,
    load,
  } = ctx;
  const selection = picked?.selection ?? null;
  // Tool results routed to this panel (open_document, show_in_viewer).
  useEffect(() => {
    const drain = () => {
      for (const result of host.takeResults()) {
        if (result.isError) continue;
        const truncated = (result._meta as Record<string, unknown> | undefined)?.[
          "zcode/truncated"
        ];
        if (truncated) void call<ViewerSnapshot>("get_viewer").then(applySnapshot, () => undefined);
        else applySnapshot(result.structuredContent as ViewerSnapshot | undefined);
      }
    };
    window.addEventListener("office:toolresult", drain);
    void host.ready().then(async () => {
      setRecent(readRecent());
      const buffered = host.takeResults();
      const path = host.readDocument();
      // 恢复本窗口的手动选择优先于历史工具结果；新窗口没有记录，保持空状态。
      if (path) void load(path);
      else
        for (const result of buffered)
          if (!result.isError)
            applySnapshot(result.structuredContent as ViewerSnapshot | undefined);
    });
    return () => window.removeEventListener("office:toolresult", drain);
  }, [applySnapshot, load]);

  // Tell the server where the user is (debounced) so get_view answers "what am I looking at".
  useEffect(() => {
    if (!doc) return;
    const timer = setTimeout(() => {
      void call("report_view", {
        viewId: host.viewId,
        path: doc.info.path,
        at: location,
        selection,
      }).catch(() => undefined);
    }, 400);
    return () => clearTimeout(timer);
  }, [doc, location, selection]);

  // Notice when the file changes on disk under the panel.
  useEffect(() => {
    if (!doc || inline) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void call<{ revision: string }>("check_document", { path: doc.info.path }).then(
        ({ revision }) => {
          if (docRef.current !== doc) return;
          if (revision !== doc.info.revision && revision !== dismissedRevision.current)
            setChanged(revision);
        },
        () => undefined,
      );
    }, 4000);
    return () => clearInterval(timer);
  }, [doc, inline]);

  return { selection };
}
