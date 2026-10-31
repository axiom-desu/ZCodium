import {
  useEffect,
  useRef,
  useState,
  type RefObject,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { Strings } from "#ui/i18n.ts";
import { Icon } from "#ui/icons.tsx";
import { useFloating } from "#ui/shell/float.ts";
import type { Locate, PageState, ZoomState } from "#ui/viewers/types.ts";

const IDLE_MS = 1500;

/**
 * Floating page and zoom control. Shown while scrolling, while the pointer is near the bottom edge,
 * while focused or hovered; fades out after 1.5 s of stillness.
 */
export function PagePill({
  t,
  frame,
  page,
  zoom,
  onPage,
  onZoom,
  onFit,
}: {
  t: Strings;
  frame: RefObject<HTMLElement | null>;
  page: PageState;
  zoom: ZoomState | null;
  onPage(page: number): void;
  onZoom(direction: 1 | -1): void;
  onFit(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  const [draft, setDraft] = useState<string | null>(null);
  const hold = useRef(false);
  useEffect(() => {
    const container = frame.current;
    if (!container) return;
    let timer = 0;
    const idle = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!hold.current && !ref.current?.contains(document.activeElement)) setVisible(false);
      }, IDLE_MS);
    };
    const wake = () => {
      setVisible(true);
      idle();
    };
    const near = (event: PointerEvent) => {
      const bounds = container.getBoundingClientRect();
      if (event.clientY > bounds.bottom - 80) wake();
    };
    container.addEventListener("scroll", wake, { capture: true, passive: true });
    container.addEventListener("pointermove", near, { passive: true });
    idle();
    return () => {
      clearTimeout(timer);
      container.removeEventListener("scroll", wake, { capture: true });
      container.removeEventListener("pointermove", near);
    };
  }, [frame]);
  const go = () => {
    const value = Number(draft);
    setDraft(null);
    if (Number.isInteger(value) && value >= 1) onPage(Math.min(value, page.count));
  };
  return (
    <div
      ref={ref}
      className={`pill${visible ? "" : " faded"}`}
      onPointerEnter={() => {
        hold.current = true;
        setVisible(true);
      }}
      onPointerLeave={() => {
        hold.current = false;
      }}
      onFocus={() => setVisible(true)}
    >
      <button
        type="button"
        className="btn icon sm dim"
        title={t.previousPage}
        aria-label={t.previousPage}
        disabled={page.current <= 1}
        onClick={() => onPage(page.current - 1)}
      >
        <Icon name="chevron-up" />
      </button>
      <span className="pg">
        <input
          className="pgin"
          aria-label={t.pageNumber}
          inputMode="numeric"
          style={{ width: `${Math.max(2, String(page.count).length) + 1.6}ch` }}
          value={draft ?? String(page.current)}
          onFocus={(event) => {
            setDraft(String(page.current));
            event.target.select();
          }}
          onChange={(event) => setDraft(event.target.value.replace(/\D/g, ""))}
          onBlur={() => setDraft(null)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              go();
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              event.stopPropagation();
              setDraft(null);
              event.currentTarget.blur();
            }
          }}
        />
        <span>{t.ofPages(page.count)}</span>
      </span>
      <button
        type="button"
        className="btn icon sm dim"
        title={t.nextPage}
        aria-label={t.nextPage}
        disabled={page.current >= page.count}
        onClick={() => onPage(page.current + 1)}
      >
        <Icon name="chevron-down" />
      </button>
      {zoom ? (
        <>
          <span className="vsep" />
          <button
            type="button"
            className="btn icon sm dim"
            title={t.zoomOut}
            aria-label={t.zoomOut}
            disabled={zoom.mode !== "width" && zoom.percent <= 25}
            onClick={() => onZoom(-1)}
          >
            <Icon name="minus" />
          </button>
          <button type="button" className="zoom" title={t.fitWidth} onClick={onFit}>
            {zoom.mode === "width" ? t.fit : `${zoom.percent}%`}
          </button>
          <button
            type="button"
            className="btn icon sm dim"
            title={t.zoomIn}
            aria-label={t.zoomIn}
            disabled={zoom.mode !== "width" && zoom.percent >= 400}
            onClick={() => onZoom(1)}
          >
            <Icon name="plus" />
          </button>
        </>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- Selection bar and Ask */

export type BarMode = "bar" | "ask" | "added";

/** Keep the document's text selection when a press lands on the bar. */
const keepSelection = (event: ReactMouseEvent) => {
  if (!(event.target as Element).closest("textarea")) event.preventDefault();
};

export function SelectionBar({
  t,
  frame,
  locate,
  text,
  label,
  quote,
  short,
  mode,
  canAsk,
  copied,
  onAdd,
  onAsk,
  onCopy,
  onCancelAsk,
  onSend,
}: {
  t: Strings;
  frame: RefObject<HTMLElement | null>;
  locate: Locate;
  /** A text selection (offers Copy) rather than a block, page or cell range (shows its label). */
  text: boolean;
  label: string;
  quote: string;
  /** Use the short "Add" label (spreadsheets, where the range label takes the room). */
  short: boolean;
  mode: BarMode;
  canAsk: boolean;
  copied: boolean;
  onAdd(): void;
  onAsk(): void;
  onCopy(): void;
  onCancelAsk(): void;
  onSend(question: string): Promise<boolean>;
}) {
  const asking = mode === "ask";
  const ref = useFloating<HTMLDivElement>(frame, locate, {
    side: asking ? "bottom" : "top",
    dock: true,
  });
  const [question, setQuestion] = useState("");
  const [sending, setSending] = useState(false);
  const send = async () => {
    if (!question.trim() || sending) return;
    setSending(true);
    const ok = await onSend(question.trim());
    setSending(false);
    if (ok) setQuestion("");
  };
  if (asking)
    return (
      <div
        ref={ref}
        className="pop ask"
        role="dialog"
        aria-label={t.ask}
        onMouseDown={keepSelection}
      >
        <div className="ctx">
          <span className="where">{label}</span>
          {quote ? <span className="q">“{quote}”</span> : null}
        </div>
        <textarea
          autoFocus
          className="textarea"
          rows={2}
          aria-label={t.askPlaceholder}
          placeholder={t.askPlaceholder}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onCancelAsk();
            }
          }}
        />
        <div className="row">
          <span className="hint">
            <kbd>↵</kbd> {t.sendKey}
          </span>
          <button type="button" className="btn sm" onClick={onCancelAsk}>
            {t.cancel}
          </button>
          <button
            type="button"
            className="btn sm primary"
            disabled={!question.trim() || sending}
            onClick={() => void send()}
          >
            {t.send}
          </button>
        </div>
      </div>
    );
  return (
    <div
      ref={ref}
      className="pop bar"
      role="toolbar"
      aria-label={label}
      onMouseDown={keepSelection}
    >
      {!text ? (
        <>
          <span className="where">{label}</span>
          <span className="vsep" />
        </>
      ) : null}
      <button
        type="button"
        className="btn lg"
        title={t.addToChatHint}
        onClick={onAdd}
        disabled={mode === "added"}
      >
        {mode === "added" ? (
          <>
            <Icon name="check" size={16} className="ok" />
            {t.added}
          </>
        ) : (
          <>
            <Icon name="message-square-plus" size={16} />
            {short ? t.addShort : t.addToChat}
          </>
        )}
      </button>
      {canAsk ? (
        <button type="button" className="btn lg" onClick={onAsk}>
          <Icon name="message-circle-question" size={16} />
          {t.ask}
        </button>
      ) : null}
      {text ? (
        <>
          <span className="vsep" />
          <button
            type="button"
            className="btn icon lg dim"
            title={copied ? t.copied : t.copy}
            aria-label={copied ? t.copied : t.copy}
            onClick={onCopy}
          >
            <Icon name={copied ? "check" : "copy"} />
          </button>
        </>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- Agent callout */

