import { useCallback, useEffect, useRef, useState } from "react";
import type { IFileService } from "@zcode/services";
import {
  applyDesignStyleEdits,
  designSourcePathFromUrl,
  getDesignStyleChanges,
  sanitizeDesignStyleValue,
  type DesignSourcePreview,
  type DesignStyleDraft,
  type DesignStyleProperty,
} from "@/browser-use/browserDesignSource.js";
import {
  buildBrowserDesignDisposeScript,
  buildBrowserDesignInspectScript,
  buildBrowserDesignPreviewScript,
  buildBrowserDesignReadStyleScript,
  parseBrowserDesignInspectResult,
  type DesignInspectSelection,
} from "@/browser-use/browserDesignInspectScript.js";
import { logger } from "@/logger.js";

// 一个已选元素的设计会话。唯一 owner：每个挂载的浏览器 tab 一份；页面只是预览执行者。
// 页面切换 / tab 切换 / 工作区切换 / 取消都会让 generation 失效，迟到的异步结果不再更新新页面。

export type BrowserDesignError =
  | "blocked"
  | "changed"
  | "inspectFailed"
  | "invalidValue"
  | "notMatched"
  | "readFailed"
  | "sourceUnavailable"
  | "writeFailed";

export type BrowserDesignStatus = "applying" | "error" | "idle" | "inspecting" | "selected";

interface DesignSession {
  selection: DesignInspectSelection;
  sourcePath: string | null;
  fileName: string | null;
  sourceState: "ready" | "unavailable";
}

interface DesignPreview {
  expectedContent: string;
  content: string;
  changes: DesignSourcePreview["changes"];
}

interface BrowserDesignInspectController {
  status: BrowserDesignStatus;
  selection: DesignInspectSelection | null;
  draft: DesignStyleDraft;
  changes: DesignSourcePreview["changes"];
  error: BrowserDesignError | null;
  fileName: string | null;
  canApply: boolean;
  applied: boolean;
  sourceWritable: boolean;
  inspect(): void;
  cancel(): void;
  setDraftValue(property: DesignStyleProperty, value: string): void;
  apply(): void;
}

export function useBrowserDesignInspect({
  browserKey,
  enabled,
  executeJs,
  fileService,
  pageUrl,
  workspacePath,
  workspaceIdentity,
}: {
  browserKey: string;
  enabled: boolean;
  executeJs: (script: string) => Promise<unknown>;
  fileService: Pick<IFileService, "readDesignSourceFile" | "writeDesignSourceFile"> | undefined;
  pageUrl: string;
  workspacePath: string;
  workspaceIdentity?: string;
}): BrowserDesignInspectController {
  const [status, setStatus] = useState<BrowserDesignStatus>("idle");
  const [session, setSession] = useState<DesignSession | null>(null);
  const [draft, setDraft] = useState<DesignStyleDraft>({});
  const [preview, setPreview] = useState<DesignPreview | null>(null);
  const [error, setError] = useState<BrowserDesignError | null>(null);
  const [applied, setApplied] = useState(false);
  const [sourceWritable, setSourceWritable] = useState(false);
  const generationRef = useRef(0);
  const sessionRef = useRef<DesignSession | null>(null);
  const draftRef = useRef<DesignStyleDraft>({});
  const executeJsRef = useRef(executeJs);
  executeJsRef.current = executeJs;
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;

  const restorePage = useCallback((target: DesignSession | null) => {
    if (!target) return;
    void executeJsRef
      .current(
        buildBrowserDesignDisposeScript(target.selection.selector, target.selection.styleAttribute),
      )
      .catch((restoreError: unknown) => {
        logger.debug("[browser-design] 恢复页面样式失败", {
          error: restoreError instanceof Error ? restoreError.message : String(restoreError),
        });
      });
  }, []);

  const clearSession = useCallback(
    (target: DesignSession | null) => {
      generationRef.current += 1;
      restorePage(target);
      sessionRef.current = null;
      draftRef.current = {};
      setSession(null);
      setDraft({});
      setPreview(null);
      setError(null);
      setStatus("idle");
      setApplied(false);
      setSourceWritable(false);
    },
    [restorePage],
  );

  // 页面 / tab / 工作区变化或能力关闭：旧会话作废，不把旧页面的结果写进新页面。
  useEffect(() => {
    const previous = sessionRef.current;
    generationRef.current += 1;
    restorePage(previous);
    sessionRef.current = null;
    draftRef.current = {};
    setSession(null);
    setDraft({});
    setPreview(null);
    setError(null);
    setStatus("idle");
    setApplied(false);
    setSourceWritable(false);
  }, [browserKey, enabled, pageUrl, restorePage, workspaceKey]);

  useEffect(
    () => () => {
      const pending = sessionRef.current;
      generationRef.current += 1;
      if (pending) {
        void executeJsRef
          .current(
            buildBrowserDesignDisposeScript(
              pending.selection.selector,
              pending.selection.styleAttribute,
            ),
          )
          .catch(() => undefined);
      }
    },
    [],
  );

  const refreshPreview = useCallback(
    async (
      target: DesignSession,
      nextDraft: DesignStyleDraft,
      generation: number,
    ): Promise<void> => {
      if (!fileService || !workspacePath.trim() || !target.sourcePath) {
        setPreview(null);
        setSourceWritable(false);
        setError("sourceUnavailable");
        return;
      }
      let source: string;
      try {
        source = (
          await fileService.readDesignSourceFile({
            rootPath: workspacePath,
            path: target.sourcePath,
          })
        ).content;
      } catch (readError) {
        if (generationRef.current !== generation) return;
        logger.debug("[browser-design] 读取设计源码失败", {
          error: readError instanceof Error ? readError.message : String(readError),
        });
        setPreview(null);
        setSourceWritable(false);
        setError("readFailed");
        return;
      }
      if (generationRef.current !== generation) return;
      // 只把相对选中时真实变化的属性交给源码改写；否则会把 computed 值全量写成内联样式。
      const changedStyles: DesignStyleDraft = {};
      for (const change of getDesignStyleChanges(target.selection.editable, nextDraft)) {
        changedStyles[change.property] = change.after;
      }
      const result = applyDesignStyleEdits(source, target.selection.sourcePath, changedStyles);
      if (!result) {
        setPreview(null);
        setSourceWritable(false);
        setError("notMatched");
        return;
      }
      setPreview({ expectedContent: source, ...result });
      setSourceWritable(true);
      setError(null);
    },
    [fileService, workspacePath],
  );

  const inspect = useCallback(() => {
    if (!enabled || status === "inspecting" || status === "applying") return;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    restorePage(sessionRef.current);
    sessionRef.current = null;
    draftRef.current = {};
    setSession(null);
    setDraft({});
    setPreview(null);
    setError(null);
    setStatus("inspecting");
    setApplied(false);

    void executeJsRef
      .current(buildBrowserDesignInspectScript())
      .then((value) => {
        if (generationRef.current !== generation) return;
        const result = parseBrowserDesignInspectResult(value);
        if (result.status === "cancelled") {
          setStatus("idle");
          return;
        }
        if (result.status === "blocked") {
          setStatus("error");
          setError("blocked");
          return;
        }
        const sourcePath = designSourcePathFromUrl(pageUrl);
        const target: DesignSession = {
          selection: result.selection,
          sourcePath,
          fileName: sourcePath?.split(/[\\/]/u).pop() ?? null,
          sourceState: sourcePath ? "ready" : "unavailable",
        };
        sessionRef.current = target;
        draftRef.current = result.selection.editable;
        setSession(target);
        setDraft(result.selection.editable);
        setStatus("selected");
        setApplied(false);
        if (!sourcePath) {
          setSourceWritable(false);
          setError("sourceUnavailable");
          return;
        }
        void refreshPreview(target, result.selection.editable, generation);
      })
      .catch((inspectError: unknown) => {
        if (generationRef.current !== generation) return;
        logger.warn("[browser-design] 点选元素失败", {
          error: inspectError instanceof Error ? inspectError.message : String(inspectError),
        });
        setStatus("error");
        setError("inspectFailed");
      });
  }, [enabled, pageUrl, refreshPreview, restorePage, status]);

  const cancel = useCallback(() => {
    if (status === "inspecting") {
      generationRef.current += 1;
      void executeJsRef
        .current(
          "(() => { const dispose = window.__zcodeDesignInspectDispose; if (typeof dispose === 'function') dispose(); return true; })()",
        )
        .catch(() => undefined);
      sessionRef.current = null;
      setStatus("idle");
      return;
    }
    clearSession(sessionRef.current);
  }, [clearSession, status]);

  const setDraftValue = useCallback(
    (property: DesignStyleProperty, value: string) => {
      const target = sessionRef.current;
      if (!target || status === "applying" || status === "inspecting") return;
      const sanitized = sanitizeDesignStyleValue(property, value);
      if (!sanitized) {
        setError("invalidValue");
        return;
      }
      const nextDraft = { ...draftRef.current, [property]: sanitized };
      draftRef.current = nextDraft;
      setDraft(nextDraft);
      setApplied(false);
      setError(null);
      const styles: Record<string, string> = {};
      for (const change of getDesignStyleChanges(target.selection.editable, nextDraft)) {
        styles[change.cssProperty] = change.after;
      }
      void executeJsRef
        .current(
          buildBrowserDesignPreviewScript({
            selector: target.selection.selector,
            styleAttribute: target.selection.styleAttribute,
            styles,
          }),
        )
        .catch(() => undefined);
      void refreshPreview(target, nextDraft, generationRef.current);
    },
    [refreshPreview, status],
  );

  const apply = useCallback(() => {
    const target = sessionRef.current;
    const pending = preview;
    if (
      !target ||
      !pending ||
      pending.changes.length === 0 ||
      !fileService ||
      !workspacePath.trim() ||
      !target.sourcePath ||
      status === "applying" ||
      status === "inspecting"
    ) {
      return;
    }
    const generation = generationRef.current;
    setStatus("applying");
    setError(null);
    void fileService
      .writeDesignSourceFile({
        rootPath: workspacePath,
        path: target.sourcePath,
        expectedContent: pending.expectedContent,
        content: pending.content,
      })
      .then((result) => {
        // 文件可能已经写进去了，但当前页面/会话已经换了：不把结果应用到新页面。
        if (generationRef.current !== generation) return;
        if (result.written) {
          setPreview({ expectedContent: pending.content, content: pending.content, changes: [] });
          setStatus("selected");
          setApplied(true);
          // 写回成功后把页面的 style 基线换成当前值；之后取消/关闭不会把已写进源码的样式再撤掉。
          void executeJsRef
            .current(buildBrowserDesignReadStyleScript(target.selection.selector))
            .then((styleAttribute) => {
              if (generationRef.current !== generation) return;
              if (typeof styleAttribute === "string" || styleAttribute === null) {
                target.selection.styleAttribute = styleAttribute;
              }
            })
            .catch(() => undefined);
          return;
        }
        restorePage(target);
        setPreview(null);
        setError(result.reason === "changed" ? "changed" : "writeFailed");
        setStatus("selected");
      })
      .catch((writeError: unknown) => {
        if (generationRef.current !== generation) return;
        logger.warn("[browser-design] 写回设计源码失败", {
          error: writeError instanceof Error ? writeError.message : String(writeError),
        });
        restorePage(target);
        setPreview(null);
        setError("writeFailed");
        setStatus("selected");
      });
  }, [fileService, preview, restorePage, status, workspacePath]);

  return {
    status,
    selection: session?.selection ?? null,
    draft,
    changes: preview?.changes ?? [],
    error,
    fileName: session?.fileName ?? null,
    canApply: Boolean(
      preview &&
      preview.changes.length > 0 &&
      session?.sourcePath &&
      fileService &&
      workspacePath.trim() &&
      status !== "applying" &&
      status !== "inspecting",
    ),
    applied,
    sourceWritable,
    inspect,
    cancel,
    setDraftValue,
    apply,
  };
}
