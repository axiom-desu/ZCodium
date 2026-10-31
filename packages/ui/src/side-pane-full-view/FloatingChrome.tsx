import type { PointerEvent as ReactPointerEvent } from "react";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  GripVerticalIcon,
  LoaderIcon,
  Maximize2Icon,
  MessageCircleIcon,
  MinusIcon,
} from "lucide-react";
import {
  TID_SIDE_PANE_FULL_VIEW_BUBBLE,
  TID_SIDE_PANE_FULL_VIEW_DRAWER,
  TID_SIDE_PANE_FULL_VIEW_EXPAND,
  TID_SIDE_PANE_FULL_VIEW_HANDLE,
  TID_SIDE_PANE_FULL_VIEW_HEADER,
  TID_SIDE_PANE_FULL_VIEW_MENU_MINIMIZE,
  TID_SIDE_PANE_FULL_VIEW_MENU_OPEN_CONVERSATION,
  TID_SIDE_PANE_FULL_VIEW_MINIMIZE,
  TID_SIDE_PANE_FULL_VIEW_RUNNING,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { SidePaneFullViewFloating } from "@/side-pane-full-view/contract.js";

/**
 * 浮窗外壳：抽屉（操作栏）与最小化圆钮（spec：docs/specs/side-pane-full-view.md）。
 * 输入区本身是宿主 children 的一部分，本组件只画外层装饰，不复制对话 DOM。
 */
export function SidePaneFullViewFloatingChrome({
  floating,
  running,
  headerVisible,
  menuOpen,
  onMenuOpenChange,
  onToggleExpanded,
  onMinimize,
  onRestore,
  onOpenConversation,
  onBeginDrag,
  onMoveDrag,
  onEndDrag,
  onCancelDrag,
}: {
  floating: SidePaneFullViewFloating;
  running: boolean;
  headerVisible: boolean;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  onToggleExpanded: () => void;
  onMinimize: () => void;
  onRestore: () => void;
  onOpenConversation: () => void;
  onBeginDrag: (event: ReactPointerEvent<HTMLElement>) => void;
  onMoveDrag: (event: ReactPointerEvent<HTMLElement>) => void;
  onEndDrag: (event: ReactPointerEvent<HTMLElement>, onClick: () => void) => void;
  onCancelDrag: () => void;
}) {
  const { intl } = useZCodeIntl();
  const isMinimized = floating === "minimized";
  const isExpanded = floating === "expanded";
  const expandLabel = intl.formatMessage({
    id: isExpanded ? "sidePane.fullView.collapseMessages" : "sidePane.fullView.expandMessages",
  });
  const minimizeLabel = intl.formatMessage({ id: "sidePane.fullView.minimize" });
  const handleLabel = intl.formatMessage({ id: "sidePane.fullView.handle" });
  const statusLabel = intl.formatMessage({
    id: running ? "sidePane.fullView.statusRunning" : "sidePane.fullView.statusIdle",
  });
  const ExpandIcon = isExpanded ? ChevronDownIcon : ChevronUpIcon;

  return (
    <>
      {isMinimized ? (
        <button
          type="button"
          data-testid={TID_SIDE_PANE_FULL_VIEW_BUBBLE}
          aria-label={intl.formatMessage({ id: "sidePane.fullView.restore" })}
          title={statusLabel}
          className="absolute inset-0 z-10 flex cursor-grab touch-none items-center justify-center rounded-full border border-border bg-background shadow-lg hover:bg-hover [app-region:no-drag]"
          onPointerDown={onBeginDrag}
          onPointerMove={onMoveDrag}
          onPointerUp={(event) => onEndDrag(event, onRestore)}
          onPointerCancel={onCancelDrag}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onRestore();
            }
          }}
        >
          {running ? (
            <LoaderIcon className="size-4 animate-spin text-foreground-subtle" aria-hidden="true" />
          ) : (
            <MessageCircleIcon className="size-4 text-foreground-subtle" aria-hidden="true" />
          )}
        </button>
      ) : null}
      {!isMinimized ? (
        // 抽屉层：在输入框后面，聚焦时随浮窗变高从输入框后面向上滑出；展开时铺满浮窗。
        <div
          data-testid={TID_SIDE_PANE_FULL_VIEW_DRAWER}
          data-open={headerVisible ? "true" : "false"}
          className={cn(
            "absolute inset-x-0 top-0 h-[var(--side-pane-full-view-drawer-height)] overflow-hidden rounded-2xl border border-border bg-background shadow-lg transition-[height,opacity] duration-150 ease-out",
            headerVisible ? "opacity-100" : "pointer-events-none opacity-0",
          )}
        >
          {headerVisible ? (
            <div
              data-testid={TID_SIDE_PANE_FULL_VIEW_HEADER}
              data-expanded={isExpanded ? "true" : "false"}
              className="flex h-10 items-center gap-1 px-2"
              // 菜单内容虽 portal 到 body，React 合成事件仍沿组件树冒泡；操作栏容器
              // 不挂点击行为，只阻止 mousedown 抢走输入框焦点，避免操作栏在点击前因失焦消失。
              onMouseDown={(event) => event.preventDefault()}
            >
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                data-testid={TID_SIDE_PANE_FULL_VIEW_MINIMIZE}
                aria-label={minimizeLabel}
                onClick={onMinimize}
              >
                <MinusIcon className="size-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                data-testid={TID_SIDE_PANE_FULL_VIEW_EXPAND}
                aria-label={expandLabel}
                aria-expanded={isExpanded}
                title={expandLabel}
                onClick={onToggleExpanded}
              >
                <ExpandIcon className="size-4" />
              </Button>
              {running ? (
                <span
                  role="status"
                  data-testid={TID_SIDE_PANE_FULL_VIEW_RUNNING}
                  aria-label={statusLabel}
                  title={statusLabel}
                  className="flex size-6 items-center justify-center"
                >
                  <LoaderIcon
                    className="size-4 animate-spin text-foreground-subtle"
                    aria-hidden="true"
                  />
                </span>
              ) : null}
              <div className="min-w-0 flex-1" />
              <DropdownMenu open={menuOpen} onOpenChange={onMenuOpenChange} modal={false}>
                <ControlHintTooltip title={handleLabel} side="top" align="end">
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      data-testid={TID_SIDE_PANE_FULL_VIEW_HANDLE}
                      aria-label={handleLabel}
                      className="cursor-grab touch-none data-[state=open]:bg-selected"
                      onPointerDown={onBeginDrag}
                      onPointerMove={onMoveDrag}
                      onPointerUp={(event) => onEndDrag(event, () => onMenuOpenChange(true))}
                      onPointerCancel={onCancelDrag}
                    >
                      <GripVerticalIcon className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                </ControlHintTooltip>
                <DropdownMenuContent align="end" side="top" className="w-52">
                  <DropdownMenuItem
                    data-testid={TID_SIDE_PANE_FULL_VIEW_MENU_OPEN_CONVERSATION}
                    onSelect={onOpenConversation}
                  >
                    <Maximize2Icon className="size-4" />
                    {intl.formatMessage({ id: "sidePane.fullView.openConversation" })}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    data-testid={TID_SIDE_PANE_FULL_VIEW_MENU_MINIMIZE}
                    onSelect={onMinimize}
                  >
                    <MinusIcon className="size-4" />
                    {minimizeLabel}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
