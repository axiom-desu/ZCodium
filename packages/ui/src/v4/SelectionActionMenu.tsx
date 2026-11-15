import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { CONVERSATION_SELECTION_MAX_COMMENT_LENGTH } from "@/lib/conversationSelectionReference.js";

// 问题原因：Markdown 曾复制一份固定宽度的竖排菜单，与对话流逐渐分叉。
// 两处只传选区位置与动作，共用展示和尺寸测量，避免再次出现样式差异。
//
// 批注（comment）在这里完成：菜单是“选中 → 引用”的确认步骤，输入框只持本地草稿。
// 取消（Esc/关闭/失焦）不产生任何引用，因此不会进入 Composer 草稿，也就不会进入 accepted 输入。
export function SelectionActionMenu({
  center,
  top,
  bottom,
  singleLimit,
  sideActionDisabled,
  sideDisabledTitle,
  onAddToCurrentTask,
  onAnnotate,
  onAnnotationOpenChange,
  onAskInSideChat,
}: {
  center: number;
  top: number;
  bottom: number;
  singleLimit?: boolean;
  sideActionDisabled?: boolean;
  sideDisabledTitle?: string;
  onAddToCurrentTask: () => void;
  /** 批注确认：comment 非空，交给同一 composer 草稿 owner。缺省不提供批注入口。 */
  onAnnotate?: (comment: string) => void;
  /** 批注输入框打开期间冻结选区快照，避免窗口选区脉缩关闭菜单。 */
  onAnnotationOpenChange?: (open: boolean) => void;
  onAskInSideChat: () => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const ref = useRef<HTMLDivElement>(null);
  const [annotating, setAnnotating] = useState(false);
  const [comment, setComment] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const position = () => {
      const rect = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(12, Math.min(window.innerWidth - rect.width - 12, center - rect.width / 2))}px`;
      const preferredTop = top - rect.height - 8 >= 12 ? top - rect.height - 8 : bottom + 8;
      menu.style.top = `${Math.max(12, Math.min(window.innerHeight - rect.height - 12, preferredTop))}px`;
    };
    position();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(position);
    observer?.observe(menu);
    return () => observer?.disconnect();
  }, [center, top, bottom, singleLimit, locale, annotating]);
  useEffect(() => {
    onAnnotationOpenChange?.(annotating);
    if (annotating) inputRef.current?.focus();
  }, [annotating, onAnnotationOpenChange]);
  useEffect(() => () => onAnnotationOpenChange?.(false), [onAnnotationOpenChange]);
  const trimmed = comment.trim();
  const submitAnnotation = () => {
    if (trimmed.length === 0 || !onAnnotate) return;
    onAnnotate(trimmed);
  };
  return createPortal(
    <div
      ref={ref}
      data-conversation-selection-tooltip="true"
      style={{
        width: "max-content",
        maxWidth: Math.min(576, window.innerWidth - 24),
        left: 12,
        top: 12,
      }}
      className={cn(
        "fixed z-50 flex overflow-hidden rounded-lg border border-popover-border bg-menu text-ui-sm text-foreground shadow-md",
        annotating ? "flex-col gap-1 p-1.5" : "",
      )}
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
    >
      {singleLimit ? (
        <div className="px-2.5 py-1.5 text-[var(--color-warning)]">
          {intl.formatMessage({ id: "chat.selections.limit.single" })}
        </div>
      ) : annotating ? (
        <div className="flex w-[min(420px,80vw)] flex-col gap-1">
          <textarea
            ref={inputRef}
            data-conversation-selection-annotation="true"
            value={comment}
            maxLength={CONVERSATION_SELECTION_MAX_COMMENT_LENGTH}
            rows={2}
            placeholder={intl.formatMessage({ id: "chat.selections.annotation.placeholder" })}
            className="resize-none rounded border border-popover-border bg-transparent px-2 py-1 text-ui-sm outline-none"
            onChange={(event) => setComment(event.target.value)}
            onKeyDown={(event) => {
              // 阻止冒泡：面板里的 Esc 只取消批注，不关闭整个选区菜单。
              if (event.key === "Escape") {
                event.stopPropagation();
                setAnnotating(false);
                setComment("");
              }
            }}
          />
          <div className="flex justify-end gap-1">
            <button
              type="button"
              data-conversation-selection-action="cancel-annotation"
              className="rounded px-2 py-1 hover:bg-menu-hover"
              onClick={() => {
                // 取消 = 什么都不提交：批注草稿只活在这个局部状态里。
                setAnnotating(false);
                setComment("");
              }}
            >
              {intl.formatMessage({ id: "common.cancel" })}
            </button>
            <button
              type="button"
              data-conversation-selection-action="submit-annotation"
              disabled={trimmed.length === 0}
              className={cn(
                "rounded px-2 py-1 hover:bg-menu-hover",
                trimmed.length === 0 && "cursor-not-allowed opacity-50 hover:bg-transparent",
              )}
              onClick={submitAnnotation}
            >
              {intl.formatMessage({ id: "chat.selections.annotation.submit" })}
            </button>
          </div>
        </div>
      ) : (
        <>
          <button
            type="button"
            data-conversation-selection-action="add-to-task"
            className="min-w-0 px-2.5 py-1.5 hover:bg-menu-hover"
            onClick={onAddToCurrentTask}
          >
            {intl.formatMessage({ id: "chat.selections.addToTask" })}
          </button>
          {onAnnotate ? (
            <>
              <div className="w-px shrink-0 bg-border" />
              <button
                type="button"
                data-conversation-selection-action="annotate"
                className="min-w-0 px-2.5 py-1.5 hover:bg-menu-hover"
                onClick={() => {
                  // 先同步冻结选区快照（父级 ref），再打开输入框。
                  onAnnotationOpenChange?.(true);
                  setAnnotating(true);
                }}
              >
                {intl.formatMessage({ id: "chat.selections.annotate" })}
              </button>
            </>
          ) : null}
          <div className="w-px shrink-0 bg-border" />
          <button
            type="button"
            data-conversation-selection-action="ask-in-side-chat"
            disabled={sideActionDisabled}
            title={sideActionDisabled ? sideDisabledTitle : undefined}
            className={cn(
              "min-w-0 px-2.5 py-1.5 hover:bg-menu-hover",
              sideActionDisabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
            )}
            onClick={() => {
              if (!sideActionDisabled) onAskInSideChat();
            }}
          >
            {intl.formatMessage({ id: "chat.selections.askInSideChat" })}
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}
