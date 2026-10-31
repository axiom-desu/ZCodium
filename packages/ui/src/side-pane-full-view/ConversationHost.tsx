// Side Pane 完整视图的对话宿主（spec：docs/specs/side-pane-full-view.md）。
// 它包住 conversation-column 里唯一的 SessionPane 实例，只改变定位方式，不移动 DOM、不重挂载：
// - normal：静态布局，与原三栏一致；
// - conversation：fixed 铺满面板内容区（slot），对话全宽；
// - floating：fixed 浮在 slot 内的吸附位置，收起态只露出底部输入区。
// 几何值是 DOM 布局投影，直接写到宿主 style，不进入 React state，避免每次测量重渲染对话树。
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  TID_SIDE_PANE_FULL_VIEW_ANSWER_BUBBLE,
  TID_SIDE_PANE_FULL_VIEW_ANSWER_BUBBLE_CLOSE,
  TID_SIDE_PANE_FULL_VIEW_HOST,
} from "@zcode/shared";
import { XIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  ConversationPaneFloatingStatus,
  ConversationPanePresentationValue,
  FloatingAnchor,
  FloatingAnswerBubbleState,
  SidePaneFullViewFloating,
  SidePaneFullViewHostMode,
} from "@/side-pane-full-view/contract.js";
import {
  dismissFloatingAnswerBubble,
  rebaselineFloatingAnswerBubbles,
  reduceFloatingAnswerBubbles,
  resolveFloatingAnswerPreview,
  resolveFloatingHeaderVisible,
  shouldRestoreFloatingFromMinimized,
} from "@/side-pane-full-view/model.js";
import { ConversationPanePresentationContext } from "@/side-pane-full-view/conversationPanePresentation.js";
import { SidePaneFullViewFloatingChrome } from "@/side-pane-full-view/FloatingChrome.js";
import {
  useFloatingFocusWithin,
  useFloatingGeometry,
} from "@/side-pane-full-view/useFloatingGeometry.js";

const COMPOSER_INPUT_SELECTOR = '[data-testid="v4-composer-input"]';

export function SidePaneFullViewConversationHost({
  mode,
  floating,
  anchor,
  slotElement,
  onFloatingChange,
  onAnchorChange,
  onOpenConversation,
  children,
}: {
  mode: SidePaneFullViewHostMode;
  floating: SidePaneFullViewFloating;
  anchor: FloatingAnchor;
  slotElement: HTMLElement | null;
  onFloatingChange: (floating: SidePaneFullViewFloating) => void;
  onAnchorChange: (anchor: FloatingAnchor) => void;
  onOpenConversation: () => void;
  children: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const isFloating = mode === "floating";
  const isMinimized = isFloating && floating === "minimized";
  const isExpanded = isFloating && floating === "expanded";
  const [status, setStatus] = useState<
    Pick<ConversationPaneFloatingStatus, "running" | "blockingInteractionId" | "ownerKey">
  >({
    running: false,
    blockingInteractionId: null,
    ownerKey: "",
  });
  /** 回答气泡按对话 owner 记录（只在内存里），只有点 × 或点气泡才清除。 */
  const [answerBubbles, setAnswerBubbles] = useState<
    ReadonlyMap<string, FloatingAnswerBubbleState>
  >(() => new Map());
  const [menuOpen, setMenuOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const { focusWithin, onFocusCapture, onBlurCapture } = useFloatingFocusWithin();
  const headerVisible =
    isFloating && resolveFloatingHeaderVisible({ floating, focusWithin, menuOpen, dragging });
  const { hostRef, beginDrag, moveDrag, endDrag, cancelDrag, reportComposerDockHeight } =
    useFloatingGeometry({
      mode,
      floating,
      anchor,
      headerVisible,
      slotElement,
      onAnchorChange,
      onDraggingChange: setDragging,
    });

  const reportFloatingStatus = useCallback((next: ConversationPaneFloatingStatus) => {
    setStatus((current) =>
      current.running === next.running &&
      current.blockingInteractionId === next.blockingInteractionId &&
      current.ownerKey === next.ownerKey
        ? current
        : {
            running: next.running,
            blockingInteractionId: next.blockingInteractionId,
            ownerKey: next.ownerKey,
          },
    );
    setAnswerBubbles((current) => reduceFloatingAnswerBubbles(current, next));
  }, []);
  // 离开浮窗形态（对话 tab、退出完整视图）时清空基线：在对话 tab 里看过的回答，
  // 切回浮窗不再弹出；已经弹出的气泡保留。
  useEffect(() => {
    if (!isFloating) setAnswerBubbles(rebaselineFloatingAnswerBubbles);
  }, [isFloating]);
  const answer =
    isFloating && floating === "collapsed"
      ? (answerBubbles.get(status.ownerKey)?.answer ?? null)
      : null;
  const answerPreview = useMemo(
    () => (answer ? resolveFloatingAnswerPreview(answer.text) : ""),
    [answer],
  );
  const presentationValue = useMemo<ConversationPanePresentationValue>(
    () => ({
      presentation: isFloating ? "floating" : "docked",
      reportFloatingStatus,
      // 对话侧通过自己的 dock 实测上报；useFloatingGeometry 仍保留 DOM 测量作为兜底。
      reportComposerDockHeight,
    }),
    [isFloating, reportComposerDockHeight, reportFloatingStatus],
  );

  // 最小化时出现新的阻塞交互（权限 / 问答）自动恢复为收起态，卡片替换输入框显示在浮窗内。
  // 只响应同一 owner 的新请求 id：迟到的旧请求或切 owner 不会把用户弹开。
  const seenBlockingInteractionRef = useRef({
    ownerKey: status.ownerKey,
    interactionId: status.blockingInteractionId,
  });
  useEffect(() => {
    const previous = seenBlockingInteractionRef.current;
    const next = {
      ownerKey: status.ownerKey,
      interactionId: status.blockingInteractionId,
    };
    seenBlockingInteractionRef.current = next;
    if (shouldRestoreFloatingFromMinimized({ isMinimized, previous, next })) {
      onFloatingChange("collapsed");
    }
  }, [isMinimized, onFloatingChange, status.blockingInteractionId, status.ownerKey]);

  const focusComposer = useCallback(() => {
    window.requestAnimationFrame(() => {
      hostRef.current?.querySelector<HTMLElement>(COMPOSER_INPUT_SELECTOR)?.focus();
    });
  }, [hostRef]);
  const handleToggleExpanded = useCallback(() => {
    onFloatingChange(isExpanded ? "collapsed" : "expanded");
  }, [isExpanded, onFloatingChange]);
  const handleMinimize = useCallback(() => {
    setMenuOpen(false);
    onFloatingChange("minimized");
  }, [onFloatingChange]);
  const handleRestore = useCallback(() => {
    onFloatingChange("collapsed");
    focusComposer();
  }, [focusComposer, onFloatingChange]);
  const handleOpenConversation = useCallback(() => {
    setMenuOpen(false);
    onOpenConversation();
  }, [onOpenConversation]);
  const handleDismissAnswer = useCallback(() => {
    setAnswerBubbles((current) => dismissFloatingAnswerBubble(current, status.ownerKey));
  }, [status.ownerKey]);
  const handleOpenAnswer = useCallback(() => {
    handleDismissAnswer();
    onFloatingChange("expanded");
  }, [handleDismissAnswer, onFloatingChange]);

  return (
    <div
      ref={hostRef}
      data-testid={TID_SIDE_PANE_FULL_VIEW_HOST}
      data-side-pane-full-view-host={mode}
      data-floating={isFloating ? floating : undefined}
      data-header-visible={headerVisible ? "true" : "false"}
      data-dragging={dragging ? "true" : undefined}
      onFocusCapture={isFloating ? onFocusCapture : undefined}
      onBlurCapture={isFloating ? onBlurCapture : undefined}
      className={cn(
        mode === "normal" && "relative h-full w-full",
        mode === "conversation" && "fixed z-30 flex flex-col",
        isFloating &&
          "fixed z-30 transition-[left,top,width,height] duration-150 ease-out data-[dragging=true]:transition-none",
      )}
    >
      <ConversationPanePresentationContext.Provider value={presentationValue}>
        {isFloating ? (
          <SidePaneFullViewFloatingChrome
            floating={floating}
            running={status.running}
            headerVisible={headerVisible}
            menuOpen={menuOpen}
            onMenuOpenChange={setMenuOpen}
            onToggleExpanded={handleToggleExpanded}
            onMinimize={handleMinimize}
            onRestore={handleRestore}
            onOpenConversation={handleOpenConversation}
            onBeginDrag={beginDrag}
            onMoveDrag={moveDrag}
            onEndDrag={endDrag}
            onCancelDrag={cancelDrag}
          />
        ) : null}
        {answer ? (
          // 回答气泡：只显示回答正文前两行，不显示图标与标题；顶部吸附位置时放在浮窗下方。
          <div
            data-testid={TID_SIDE_PANE_FULL_VIEW_ANSWER_BUBBLE}
            className={cn(
              "absolute inset-x-0 z-20",
              anchor.startsWith("top") ? "top-full mt-2" : "bottom-full mb-2",
            )}
          >
            <button
              type="button"
              aria-label={intl.formatMessage({ id: "sidePane.fullView.openAnswer" })}
              className="block w-full rounded-2xl border border-border bg-background px-4 py-3 text-left shadow-lg transition-colors hover:bg-hover"
              onClick={handleOpenAnswer}
            >
              <span className="line-clamp-2 text-ui-base text-foreground">{answerPreview}</span>
            </button>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              data-testid={TID_SIDE_PANE_FULL_VIEW_ANSWER_BUBBLE_CLOSE}
              aria-label={intl.formatMessage({ id: "common.close" })}
              className="absolute -top-2 -left-2 rounded-full border bg-background shadow-sm"
              // 关闭不夺走输入框焦点，避免抽屉因焦点进出闪一下。
              onMouseDown={(event) => event.preventDefault()}
              onClick={handleDismissAnswer}
            >
              <XIcon className="size-3" />
            </Button>
          </div>
        ) : null}
        <div
          data-side-pane-full-view-clip=""
          className={cn(
            "relative min-h-0",
            mode === "normal" && "h-full",
            mode === "conversation" && "flex-1",
            // 输入层：收起态外壳就是输入框（带阴影），展开态内缩 1px 露出抽屉边框。
            isFloating &&
              "absolute z-10 h-[var(--side-pane-full-view-clip-height)] overflow-hidden",
            isFloating && !isExpanded && "inset-x-0 bottom-0 rounded-2xl shadow-lg",
            isExpanded && "inset-x-px bottom-px rounded-b-2xl",
            // 最小化时输入层不可见，但保持浮窗宽度排版，不随 48px 的按钮重排。
            isMinimized && "invisible w-[var(--side-pane-full-view-frame-width)]",
          )}
        >
          <div
            className={cn(
              "h-full",
              // 收起态保持展开态的固定高度并贴底：只露出底部输入区，上方内容仍然挂载。
              isFloating &&
                "absolute inset-x-0 bottom-0 h-[var(--side-pane-full-view-pane-height)]",
            )}
          >
            {children}
          </div>
        </div>
      </ConversationPanePresentationContext.Provider>
    </div>
  );
}
