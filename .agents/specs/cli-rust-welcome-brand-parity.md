# Rust Native TUI: Welcome Brand Parity

## Behavior

The Rust terminal frontend is a native implementation, but its welcome presentation must read as the same product as the TypeScript TUI. While the transcript is empty:

- The ZCODIUM mark is centered in the transcript frame, both horizontally and in the available vertical space, instead of being the first left-aligned body rows. Narrow frames that cannot fit the mark keep the compact `ZCODIUM · Rust` fallback, still centered.
- The mark carries the same shimmer sweep as the TypeScript welcome art: an accent-to-foreground highlight band travels across the mark, driven by UI time only.
- One dimmed subtitle line sits centered below the mark. Operational hints (`/help`, Ctrl-C) stay in the composer hint line rather than being injected into the transcript as scroll content.

The composer follows the TypeScript title/placeholder contract: when a permission mode is known the frame title is that mode (for example `Build`), otherwise the neutral input title; an empty composer shows the `Type a prompt` placeholder and a busy composer shows the queue placeholder.

Sidebar semantics stay distinct. The Rust sidebar keeps its `Context` panel built from real actor state; it must not invent Git, MCP, token or subagent numbers that the runtime did not report.

## State ownership and interfaces

`View` remains a disposable terminal projection. The animation clock is a new UI-only field (`frame_ms`) written by the transport loop from a monotonic `Instant`; it is never persisted, sent over the protocol, or used to derive runtime facts. Welcome visibility is derived from the same projection (`rows` empty and no alerts), so no new business state owner appears. Permission-mode titles reuse `View::mode()`, which already derives plan/build from actor config.

```text
transport tick (80 ms bucket) → View.frame_ms (UI only)
        ↓
draw → welcome mark spans (shimmer color per cell) / composer title + placeholder
        ↑
rows / notices / state.config.mode → presentation facts (unchanged owners)
```

No core, protocol, admission, or session semantics change.

## Acceptance scenarios

- At 150x40 with an empty transcript, the six mark rows are horizontally centered within the transcript frame and start below the top border, with the subtitle centered underneath.
- Frames rendered with different `frame_ms` values color the same mark cell differently, proving the sweep is animated rather than static; `NO_COLOR` still resets all cells.
- Narrow frames keep the compact fallback centered and never overflow the frame.
- An empty composer renders the mode title and the `Type a prompt` placeholder; typing removes the placeholder while the title remains.
- Unit coverage runs through `TestBackend` rendering in `presentation_tests.rs`, and the real PTY smoke still passes (welcome text, pickers, resize, cancel, quit, signals).

## Boundaries

- Not full TypeScript parity: sidebar sections, status bar, and composer status line stay native unless their runtime facts exist in the actor state.
- The shimmer only runs while the welcome screen is visible; the transport keeps a bounded redraw cadence and stops animating as soon as transcript rows exist.
