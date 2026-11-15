import { useCallback, useMemo, useRef, useState } from "react";
import {
  canExportBrowserDesignElement,
  canExportBrowserDesignPage,
  exportBrowserDesignPage,
  isSameBrowserDesignExportSnapshot,
  readBrowserDesignViewport,
  resolveBrowserDesignPlatformPort,
  type BrowserDesignExportGuest,
  type BrowserDesignExportKind,
  type BrowserDesignExportResult,
  type BrowserDesignExportScope,
  type BrowserDesignExportSnapshot,
} from "@/browser-use/browserDesignExport.js";
import type { DesignElementRect } from "@/browser-use/browserDesignInspectScript.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

/**
 * 页面像素 / 元素截图 / PDF 导出接线。
 *
 * 唯一 owner 是这个 hook 实例（每个挂载的浏览器 tab 一份）：它持有「本次导出属于哪个
 * owner/session/tab/generation」的快照，并在每个 await 之后与实时 props 比对；页面换代、
 * tab 关闭、地址变化都会让迟到结果变成 stale，不落盘。平台能力只来自 BN5/B6 的公开端口，
 * 缺失即按钮不可用。
 */
export function useBrowserDesignExport({
  elementRect,
  enabled,
  executeJs,
  guest,
  scope,
}: {
  /** human Desktop browser 且宿主明确开启设计入口；Agent tab / Web / 手机为 false。 */
  enabled: boolean;
  elementRect: DesignElementRect | null;
  executeJs: (script: string) => Promise<unknown>;
  guest: BrowserDesignExportGuest;
  scope: BrowserDesignExportScope;
}): {
  canExportElement: boolean;
  canExportPdf: boolean;
  canExportPng: boolean;
  isExporting: boolean;
  exportElement(): void;
  exportPage(kind: BrowserDesignExportKind): void;
} {
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const port = useMemo(() => resolveBrowserDesignPlatformPort(platform), [platform]);
  const [isExporting, setIsExporting] = useState(false);
  const inFlightRef = useRef(false);
  // 每次渲染同步实时快照：点击时取一份，await 之后用它判断页面是否还是同一代。
  const liveSnapshotRef = useRef<BrowserDesignExportSnapshot>({ guest, scope });
  liveSnapshotRef.current = { guest, scope };
  const executeJsRef = useRef(executeJs);
  executeJsRef.current = executeJs;

  const canExportPng = enabled && canExportBrowserDesignPage({ guest, kind: "png", port });
  const canExportPdf = enabled && canExportBrowserDesignPage({ guest, kind: "pdf", port });
  const canExportElement = enabled && canExportBrowserDesignElement({ elementRect, guest, port });

  const report = useCallback(
    (result: BrowserDesignExportResult, kind: BrowserDesignExportKind) => {
      if (result.status === "saved") {
        toast(intl.formatMessage({ id: "browser.design.exported" }, { path: result.path }));
        return;
      }
      if (result.status === "canceled") return;
      if (result.status === "stale") {
        logger.debug("[browser-design] 页面已换代，丢弃迟到的导出结果", {
          browserKey: scope.browserKey,
          kind,
          webContentsId: guest.webContentsId,
        });
        toast(intl.formatMessage({ id: "browser.design.exportStale" }), { variant: "warning" });
        return;
      }
      if (result.status === "unavailable") {
        toast(intl.formatMessage({ id: "browser.design.exportUnavailable" }), {
          variant: "warning",
        });
        return;
      }
      logger.warn("[browser-design] 导出页面失败", { error: result.error, kind });
      toast(intl.formatMessage({ id: "browser.design.exportFailed" }), { variant: "warning" });
    },
    [guest.webContentsId, intl, scope.browserKey],
  );

  const run = useCallback(
    (kind: BrowserDesignExportKind, rect: DesignElementRect | null) => {
      if (!enabled || inFlightRef.current) return;
      const snapshot = liveSnapshotRef.current;
      inFlightRef.current = true;
      setIsExporting(true);
      void exportBrowserDesignPage({
        elementRect: rect,
        isCurrent: () => isSameBrowserDesignExportSnapshot(liveSnapshotRef.current, snapshot),
        kind,
        port,
        readViewport: () => readBrowserDesignViewport((script) => executeJsRef.current(script)),
        snapshot,
      })
        .then((result) => report(result, kind))
        .finally(() => {
          inFlightRef.current = false;
          setIsExporting(false);
        });
    },
    [enabled, port, report],
  );

  const exportPage = useCallback(
    (kind: BrowserDesignExportKind) => {
      run(kind, null);
    },
    [run],
  );

  const exportElement = useCallback(() => {
    // 取当前渲染中的 rect；已选中但越界的 rect 由 main 按实际帧拒绝（clip_out_of_view）。
    run("png", elementRect);
  }, [elementRect, run]);

  return { canExportElement, canExportPdf, canExportPng, isExporting, exportElement, exportPage };
}
