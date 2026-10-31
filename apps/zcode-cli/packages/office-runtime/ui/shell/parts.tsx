import {
  useEffect,
  useRef,
  type ReactNode,
  type RefObject,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { describeAt, type Strings } from "#ui/i18n.ts";
import { Icon } from "#ui/icons.tsx";
import { useFloating } from "#ui/shell/float.ts";
import type { Locate } from "#ui/viewers/types.ts";

/* ---------------------------------------------------------------- Menu */

/** ZCode dropdown: closes on Escape and on any pointer press outside it. */
export function Menu({
  className,
  onClose,
  children,
  label,
}: {
  className: string;
  onClose(): void;
  children: ReactNode;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element;
      if (!ref.current?.contains(target) && !target.closest?.("[data-menu-trigger]")) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    ref.current?.querySelector<HTMLElement>("[role^=menuitem]")?.focus();
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);
  const move = (event: ReactKeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [...(ref.current?.querySelectorAll<HTMLElement>("[role^=menuitem]") ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  };
  return (
    <div ref={ref} className={`menu ${className}`} role="menu" aria-label={label} onKeyDown={move}>
      {children}
    </div>
  );
}

export function MenuItem({
  icon,
  checked,
  children,
  hint,
  onSelect,
}: {
  icon?: ReactNode;
  checked?: boolean;
  children: ReactNode;
  hint?: ReactNode;
  onSelect(): void;
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={checked}
      className="mi"
      onClick={onSelect}
    >
      <span className="mi-icon">{checked ? <Icon name="check" size={16} /> : icon}</span>
      <span className="mi-label">{children}</span>
      {hint ? <span className="mi-hint">{hint}</span> : null}
    </button>
  );
}

/* ---------------------------------------------------------------- Find */

export function FindBar({
  t,
  query,
  total,
  index,
  onQuery,
  onStep,
  onClose,
}: {
  t: Strings;
  query: string;
  total: number | null;
  index: number;
  onQuery(query: string): void;
  onStep(direction: 1 | -1): void;
  onClose(): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const count =
    !query.trim() || total === null ? "" : total ? t.findCount(index + 1, total) : t.noResults;
  return (
    <div className="docbar findbar" role="search">
      <label className="findfield">
        <Icon name="search" className="muted" />
        <input
          ref={input}
          className="find-input"
          type="text"
          aria-label={t.find}
          placeholder={t.findPlaceholder}
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onStep(event.shiftKey ? -1 : 1);
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }
          }}
        />
        <span className="count" aria-live="polite">
          {count}
        </span>
      </label>
      <button
        type="button"
        className="btn icon dim"
        title={t.previousMatch}
        aria-label={t.previousMatch}
        disabled={!total}
        onClick={() => onStep(-1)}
      >
        <Icon name="chevron-up" />
      </button>
      <button
        type="button"
        className="btn icon dim"
        title={t.nextMatch}
        aria-label={t.nextMatch}
        disabled={!total}
        onClick={() => onStep(1)}
      >
        <Icon name="chevron-down" />
      </button>
      <button
        type="button"
        className="btn icon dim"
        title={t.closeFind}
        aria-label={t.closeFind}
        onClick={onClose}
      >
        <Icon name="x" />
      </button>
    </div>
  );
}

/* ---------------------------------------------------------------- Page / zoom pill */

export { PagePill, SelectionBar } from "#ui/shell/controls.tsx";
export function AgentCallout({
  t,
  frame,
  locate,
  note,
  index,
  total,
  onNext,
  onClose,
}: {
  t: Strings;
  frame: RefObject<HTMLElement | null>;
  locate: Locate | null;
  note: string | null;
  index: number;
  total: number;
  onNext(): void;
  onClose(): void;
}) {
  const ref = useFloating<HTMLDivElement>(frame, locate, { side: "bottom", offset: 6, dock: true });
  return (
    <div ref={ref} className="callout" role="note">
      <div className="body">
        <div className="who">
          <span className="dot" />
          {total > 1 ? t.agentOf(index + 1, total) : t.agent}
        </div>
        {note ? <div className="text">{note}</div> : null}
      </div>
      {total > 1 ? (
        <button
          type="button"
          className="btn icon sm dim"
          title={t.nextTarget}
          aria-label={t.nextTarget}
          onClick={onNext}
        >
          <Icon name="chevron-down" />
        </button>
      ) : null}
      <button
        type="button"
        className="btn icon sm dim"
        title={t.close}
        aria-label={t.close}
        onClick={onClose}
      >
        <Icon name="x" />
      </button>
    </div>
  );
}

export function OffscreenChip({
  text,
  down,
  raised,
  onClick,
}: {
  text: string;
  down: boolean;
  raised: boolean;
  onClick(): void;
}) {
  return (
    <button type="button" className={`chip offscreen${raised ? " raised" : ""}`} onClick={onClick}>
      <span className="dot" />
      {text}
      <Icon name={down ? "arrow-down" : "arrow-up"} size={12} />
    </button>
  );
}

/** "1 more on page 4" for targets outside the view. */
export function offscreenText(t: Strings, ats: string[]): string {
  return t.moreOn(ats.length, describeAt(ats[0], t, true));
}
