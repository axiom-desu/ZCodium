import { Crop, FileDown, Image, Scan } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

// 设计入口工具条。只在 human browser 且宿主明确启用时渲染；Agent tab、Web、手机不出现。
// 截图/导出按钮只反映公共平台端口（captureBrowserGuestPage / printBrowserGuestPage / saveFile）
// 的真实能力，不可用时保持可见但禁用并说明原因。

export function BrowserDesignToolbar({
  canExportElement,
  canExportPdf,
  canExportPng,
  isExporting,
  isInspecting,
  onExportElement,
  onExportPage,
  onInspect,
}: {
  canExportElement: boolean;
  canExportPdf: boolean;
  canExportPng: boolean;
  isExporting: boolean;
  isInspecting: boolean;
  onExportElement: () => void;
  onExportPage: (kind: "pdf" | "png") => void;
  onInspect: () => void;
}): React.JSX.Element {
  const { intl } = useZCodeIntl();
  const unavailable = intl.formatMessage({ id: "browser.design.exportUnavailable" });
  const elementDisabledReason = canExportPng
    ? intl.formatMessage({ id: "browser.design.exportElementHint" })
    : unavailable;
  return (
    <div
      aria-label={intl.formatMessage({ id: "browser.design.toolbar" })}
      className="flex min-h-9 shrink-0 flex-wrap items-center gap-1 border-b border-border bg-background px-2"
      data-testid="browser-design-toolbar"
      role="toolbar"
    >
      <Button
        aria-pressed={isInspecting}
        data-testid="browser-design-inspect"
        size="sm"
        type="button"
        variant={isInspecting ? "secondary" : "ghost"}
        onClick={onInspect}
      >
        <Scan className="size-4" />
        {intl.formatMessage({
          id: isInspecting ? "browser.design.inspecting" : "browser.design.inspect",
        })}
      </Button>
      <Button
        data-testid="browser-design-export-element"
        disabled={!canExportElement || isExporting}
        size="sm"
        title={canExportElement ? undefined : elementDisabledReason}
        type="button"
        variant="ghost"
        onClick={onExportElement}
      >
        <Crop className="size-4" />
        {intl.formatMessage({ id: "browser.design.exportElement" })}
      </Button>
      <Button
        data-testid="browser-design-export-png"
        disabled={!canExportPng || isExporting}
        size="sm"
        title={canExportPng ? undefined : unavailable}
        type="button"
        variant="ghost"
        onClick={() => onExportPage("png")}
      >
        <Image className="size-4" />
        {intl.formatMessage({ id: "browser.design.exportPng" })}
      </Button>
      <Button
        data-testid="browser-design-export-pdf"
        disabled={!canExportPdf || isExporting}
        size="sm"
        title={canExportPdf ? undefined : unavailable}
        type="button"
        variant="ghost"
        onClick={() => onExportPage("pdf")}
      >
        <FileDown className="size-4" />
        {intl.formatMessage({ id: "browser.design.exportPdf" })}
      </Button>
      {!canExportPng && !canExportPdf ? (
        <span
          className="text-ui-xs text-muted-foreground"
          data-testid="browser-design-export-state"
        >
          {unavailable}
        </span>
      ) : null}
    </div>
  );
}
