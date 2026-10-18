# Bounded conversation navigator previews

## Scope and invariants

Optimize only the question navigator's text derivation. Preserve item order, keys,
query row IDs, unit indices, running indicator, localized fallbacks, hover text,
keyboard/mouse navigation, virtual scrolling, and existing responsive visibility.
Do not change history hydration, transport batching, projection ownership, Markdown
rendering, find indexing, or plugin notifications. Independent of PRs #75 and #76.

The prior preview rule is the semantic reference:

1. Join source texts with two LF characters.
2. Trim, split on `/\n\s*\n/u`, collapse each paragraph's JS whitespace to one ASCII
   space, trim, remove empty paragraphs, and retain `slice(0, Math.max(1, limit))`.
3. Join retained paragraphs with LF; use the localized fallback if none remain.
4. If longer than `Math.max(8, maxChars)`, retain its UTF-16 slice through
   `maxChars - 3`, trimEnd, then append `...`.

Preserve CRLF, Unicode whitespace, single LF versus blank-line boundaries, emoji
UTF-16 slicing, whitespace at text-entry boundaries, and existing NaN/fraction/
Infinity numeric-option semantics. These rules apply equally to user and assistant
previews. Only real-user rows produce navigator items; multiple queries in a turn
share the turn's assistant preview, and only the final query inherits running.

## Bounded derivation

Consume the logical text stream lazily, including the inserted LF separators.
Defer whitespace until the next non-whitespace character determines whether it is
an intra-paragraph space or a paragraph boundary. Stop once the retained paragraph
limit is known, or enough normalized UTF-16 units prove truncation. Do not join or
normalize the full assistant body before taking a short preview.

This bounds normalized-output work for normal finite preview limits, not all raw
input scanning: arbitrarily long whitespace or empty sources may require scanning
through to the next non-whitespace character. Explicitly unbounded numeric options
also retain their original full-output behavior.

## Derived cache owner and lifecycle

```text
CLI authoritative rows
  ├─ desktop-continuous frames ─────────┐
  └─ web-remote-replayable / repair ────┤
                                       v
                          existing projection / render units
                                       v
                 Navigator-instance preview cache (sessionKey scoped)
                                       v
                  existing virtual rail / hover / query navigation
```

- Navigator owns one discardable derived preview cache, recreated on sessionKey
  change. It is not a second conversation store or accepted-input queue.
- Cache by immutable user row reference, and by assistant row reference sequence
  plus isRunning for each unit key. Unit object identity alone is insufficient:
  the uncached turn builder can recreate every unit on each frame.
- Localized fallback strings and numeric preview options invalidate cached values.
- Rebuild item metadata from current units; insertion, removal, reordering and
  filtering must immediately produce current indices/row IDs even on cache hits.
- Strong assistant entries retain only units used in the latest build. User-row
  entries are weakly keyed and do not keep removed rows alive. Unmount/session
  replacement releases the cache. Input rows and published outputs are immutable.
- React retried/aborted renders may reduce cache hit rate, never alter output.
- No new cross-module dependencies, persistence, lease, timers or async work.

## Acceptance

1. Differential tests against the prior join/regex algorithm cover whitespace,
   paragraph/truncation boundaries, empty text, multiple sources, CJK/emoji,
   arbitrary numeric options and seeded text streams.
2. A long early source produces the same preview without reading later sources;
   a deterministic read-count assertion proves early termination without timing.
3. Rebuilt units with unchanged row references reuse previews. Replacement of any
   assistant/user row, assistant reordering, running changes or option changes
   invalidates the relevant result. A clock-only rebuild does not read old bodies.
4. Prepending/deleting/reordering units preserves current unitIndex and navigation
   targets; filtered/non-real-user turns remain absent. Removed assistant entries
   are pruned and different cache instances do not share values.
5. Browser smoke exercises the real Navigator: hover/focus text, click/keyboard
   targets before/after prepend, immutable text replacement, locale and session
   switching, an abandoned Suspense transition, and bounded virtual DOM. Use synthetic data and isolated Chromium;
   no real application, credentials or user data. Fixture layout is not a claim
   of production-CSS pixel equivalence or complete Electron E2E coverage.
6. A repeatable pure benchmark compares an unchanged Git baseline with cold,
   tail-update and timer-update derivation at 100/500/2,000 turns, 4 KiB assistant
   text per turn. Use the same schema-valid input per pair, alternate order,
   record Node/CPU/revision, exclude fixture/render-unit construction and equality
   assertions from timing, and report p50/p95. No noisy time thresholds in tests.
7. Run focused tests and wire them plus browser smoke into Desktop CI. Run root
   typecheck/lint, formatting and architecture checks. Preserve unrelated logs.

Performance evidence is navigator-only, not whole-window FPS/input latency or a
VS Code comparison. Remaining per-build metadata work still scales with current
units/query rows; this iteration does not promise an O(changed rows) whole UI.
