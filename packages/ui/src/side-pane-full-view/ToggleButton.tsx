import { Maximize2Icon, Minimize2Icon } from "lucide-react";
import { TID_SIDE_PANE_FULL_VIEW_TOGGLE } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * Side Pane 右上角「进入 / 退出完整视图」按钮（spec：docs/specs/side-pane-full-view.md）。
 * 多 pane 等不能共存的场景由 disabledReason 显式禁用，不静默改分屏布局。
 */
export function SidePaneFullViewToggleButton({
  active,
  onToggle,
  shortcutLabel,
  disabledReason,
}: {
  active: boolean;
  onToggle: () => void;
  shortcutLabel?: string;
  disabledReason?: string;
}) {
  const { intl } = useZCodeIntl();
  const label =
    disabledReason ??
    intl.formatMessage({ id: active ? "sidePane.fullView.exit" : "sidePane.fullView.enter" });
  const Icon = active ? Minimize2Icon : Maximize2Icon;
  const disabled = Boolean(disabledReason);
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="icon-md"
      data-testid={TID_SIDE_PANE_FULL_VIEW_TOGGLE}
      data-active={active ? "true" : "false"}
      aria-label={label}
      aria-pressed={active}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      className={cn("text-foreground hover:bg-hover hover:text-foreground [app-region:no-drag]")}
      onClick={onToggle}
    >
      <Icon className="size-4" />
    </Button>
  );
  return (
    <ControlHintTooltip title={label} side="bottom" align="end" shortcut={shortcutLabel}>
      {/* 禁用按钮自身不接指针事件，套一层 span 让 tooltip 仍能说明禁用原因。 */}
      {disabled ? <span className="inline-flex">{button}</span> : button}
    </ControlHintTooltip>
  );
}
