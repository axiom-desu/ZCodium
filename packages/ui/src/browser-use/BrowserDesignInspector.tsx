import { useRef, useState } from "react";
import { X } from "lucide-react";
import {
  DESIGN_STYLE_PROPERTIES,
  type DesignStyleChange,
  type DesignStyleDraft,
  type DesignStyleProperty,
} from "@/browser-use/browserDesignSource.js";
import type {
  BrowserDesignError,
  BrowserDesignStatus,
} from "@/browser-use/useBrowserDesignInspect.js";
import type { DesignInspectSelection } from "@/browser-use/browserDesignInspectScript.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

// 设计检查面板：只展示宿主已经校验过的选中与源码 diff；写回由 useBrowserDesignInspect 独占。
// 页面 DOM 不能提交字段值，只有宿主输入框的提交才调用 setDraftValue。

const FIELD_LABEL_KEYS: Record<DesignStyleProperty, string> = {
  fontSize: "browser.design.field.fontSize",
  color: "browser.design.field.color",
  backgroundColor: "browser.design.field.backgroundColor",
  borderRadius: "browser.design.field.borderRadius",
  padding: "browser.design.field.padding",
  opacity: "browser.design.field.opacity",
  fontWeight: "browser.design.field.fontWeight",
  textAlign: "browser.design.field.textAlign",
};

function DesignField({
  disabled,
  label,
  onCommit,
  property,
  value,
}: {
  disabled: boolean;
  label: string;
  onCommit: (value: string) => void;
  property: DesignStyleProperty;
  value: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const commit = () => {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    if (draft === null) return;
    setDraft(null);
    if (draft !== value) onCommit(draft);
  };
  return (
    <label className="flex items-center justify-between gap-2 text-ui-xs">
      <span className="min-w-0 truncate text-muted-foreground">{label}</span>
      <input
        aria-label={label}
        className="h-7 w-36 min-w-0 rounded-md border border-input-border bg-input px-2 text-ui-sm outline-none hover:border-input-border-hover focus:border-input-border-focused disabled:opacity-60"
        data-design-field={property}
        disabled={disabled}
        spellCheck={false}
        value={draft ?? value}
        onBlur={commit}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) commit();
          if (event.key === "Escape") {
            cancelledRef.current = true;
            setDraft(null);
            event.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

function errorMessage(error: BrowserDesignError | null, t: (id: string) => string): string | null {
  switch (error) {
    case "blocked":
      return t("browser.design.error.blocked");
    case "changed":
      return t("browser.design.error.changed");
    case "inspectFailed":
      return t("browser.design.error.inspectFailed");
    case "invalidValue":
      return t("browser.design.error.invalidValue");
    case "notMatched":
      return t("browser.design.error.notMatched");
    case "readFailed":
      return t("browser.design.error.readFailed");
    case "sourceUnavailable":
      return t("browser.design.error.sourceUnavailable");
    case "writeFailed":
      return t("browser.design.error.writeFailed");
    default:
      return null;
  }
}

export function BrowserDesignInspector({
  applied,
  canApply,
  changes,
  draft,
  error,
  fileName,
  onApply,
  onCancel,
  onDraftChange,
  selection,
  sourceWritable,
  status,
}: {
  applied: boolean;
  canApply: boolean;
  changes: DesignStyleChange[];
  draft: DesignStyleDraft;
  error: BrowserDesignError | null;
  fileName: string | null;
  onApply: () => void;
  onCancel: () => void;
  onDraftChange: (property: DesignStyleProperty, value: string) => void;
  selection: DesignInspectSelection | null;
  sourceWritable: boolean;
  status: BrowserDesignStatus;
}): React.JSX.Element | null {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  if (!selection) return null;
  const message = errorMessage(error, t);
  const writable = sourceWritable && Boolean(fileName);
  const submitting = status === "applying";
  return (
    <aside
      aria-label={t("browser.design.panel")}
      className="absolute right-3 top-3 z-20 flex max-h-[calc(100%-1.5rem)] w-80 flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg"
      data-testid="browser-design-inspector"
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-ui-sm font-semibold">
            {t("browser.design.selected")}: {selection.tagName}
          </div>
          <div className="truncate text-ui-xs text-muted-foreground">
            {fileName ?? t("browser.design.sourceUnavailable")}
          </div>
        </div>
        <Button
          aria-label={t("browser.design.cancel")}
          className="shrink-0"
          data-testid="browser-design-close"
          size="icon-sm"
          type="button"
          variant="ghost"
          onClick={onCancel}
        >
          <X className="size-4" />
        </Button>
      </header>
      <div className="flex min-h-0 flex-col gap-3 overflow-auto p-3">
        <div className="flex flex-col gap-2" data-testid="browser-design-fields">
          {DESIGN_STYLE_PROPERTIES.map((property) => (
            <DesignField
              disabled={!writable || submitting}
              key={property}
              label={t(FIELD_LABEL_KEYS[property])}
              property={property}
              value={draft[property] ?? ""}
              onCommit={(value) => onDraftChange(property, value)}
            />
          ))}
        </div>
        <section aria-label={t("browser.design.preview")} className="flex flex-col gap-1">
          <div className="text-ui-xs font-semibold">{t("browser.design.preview")}</div>
          {changes.length === 0 ? (
            <p className="text-ui-xs text-muted-foreground">
              {applied ? t("browser.design.applied") : t("browser.design.noChanges")}
            </p>
          ) : (
            <pre
              className="max-h-40 overflow-auto rounded-md border border-border bg-muted/40 p-2 text-ui-xs"
              data-testid="browser-design-diff"
            >
              {changes
                .map(
                  (change) =>
                    `- ${change.cssProperty}: ${change.before || "(none)"}\n+ ${change.cssProperty}: ${change.after}`,
                )
                .join("\n")}
            </pre>
          )}
        </section>
        {message ? (
          <p className="text-ui-xs text-warning" data-testid="browser-design-error">
            {message}
          </p>
        ) : null}
        <div className="flex items-center justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            {t("browser.design.cancel")}
          </Button>
          <Button
            data-testid="browser-design-apply"
            disabled={!canApply || submitting}
            size="sm"
            type="button"
            onClick={onApply}
          >
            {submitting ? t("browser.design.applying") : t("browser.design.apply")}
          </Button>
        </div>
      </div>
    </aside>
  );
}
