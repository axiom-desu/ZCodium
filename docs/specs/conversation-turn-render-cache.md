# Conversation turn render cache

## Scope and product rules

Optimize renderer-side turn derivation without changing conversation order, folding,
plugin placement, durations, scrolling, input admission, or history loading. This
iteration does not change Markdown rendering, navigation-directory hydration, or
transport batching. It is not a claim of VS Code-equivalent whole-window performance.

The uncached `buildConversationTurnRenderUnits` remains the semantic reference.
Cached and uncached builds must be deeply equal for every input and option sequence.
Rows are immutable protocol projections: an append/upsert/delta replaces the affected
row object. A recovered snapshot may replace all row references and safely miss.

## Owner and boundaries

- CLI/runtime remains the authoritative conversation owner.
- The existing projection store remains the renderer's sole session projection.
- Each `ConversationTimeline` owns one disposable derived render cache, recreated
  on session-key change. No global cache or additional accepted-input state.
- Cache entries retain only turns in the latest build's retained result; removed
  turns and their row references must be released. Unmount releases the instance.
- Cache loss/eviction only costs computation, never changes output.

```text
CLI authoritative rows
  ├─ desktop-continuous: existing live frames / sequence guards ─┐
  └─ web-remote-replayable: existing snapshot + repair ──────────┤
                                                              v
                                              session projection store
                                                              v
                                   Timeline-owned derived turn render cache
                                                              v
                                       existing virtual list / live tail
```

No protocol, lease, stale-frame, recovery, transport profile, or persistence changes.
Both delivery modes use the same renderer derivation and invalidation rules.

## Cache contract

- The optional cache is an acceleration of the existing builder, not another
  implementation of turn materialization.
- Match by turnId, header reference, ordered row references, sessionPhase, and
  effective plugin-inline eligibility for each row. Resolver function identity is
  not a dependency: global supersession, recent-turn eligibility and manual pins
  are represented by the effective result of `isPluginUiPinnedToolRow`.
- Include nowMs for running turns; completed turns must survive clock ticks.
- Every call still groups/scans the current rows and normalizes final retained-turn
  positions. This first iteration avoids expensive repeated materialization; it
  does not promise O(changed rows) for the entire builder.
- Normalize the retained position after filtering. Cache the normalized result so
  unchanged historical units preserve object identity. Appending/removing turns
  must still update isLastTurn and last-segment folding correctly.
- Do not mutate input rows or already-published render units. Concurrent/retried
  React renders may reduce cache hit rate but must not change semantic output.

## Acceptance scenarios

1. An assistant text delta replaces only its turn's derived unit; unchanged
   historical units retain reference identity and equal the uncached result.
2. A clock tick recomputes running durations but preserves completed units.
3. Append, prepend, replacement, removal, reordering, non-contiguous turn rows,
   filtered empty turns, and restored headers equal uncached output.
4. Headerless snapshots respect sessionPhase changes; terminal headers remain
   authoritative. Interrupted/failed turns retain their expansion behavior.
5. Guided work segments, fixed durations, background work and action anchors
   remain equal to the reference implementation.
6. Recreating a plugin resolver with unchanged effective pin results is a hit;
   manual pin, supersession, recent-turn eligibility, error/cancelled/isError
   transitions invalidate the affected turn.
7. Removed turns are not reused if later reintroduced. Different cache instances
   cannot share results, including matching session/turn IDs.
8. Seeded multi-step desktop-like deltas and replayable snapshot replacements
   remain equal after every step.

## Validation

- Vitest regression suite with semantic equality and reference-identity assertions;
  wire its explicit UI-alias configuration into Desktop CI.
- A repeatable synthetic builder-only benchmark for 300/1,500/6,000/12,000 rows,
  comparing uncached and warm-cache tail updates and clock ticks. Use the same
  immutable row update schedule, report p50/p95, runtime and CPU environment.
  Do not use noisy wall-clock thresholds as correctness gates.
- Run `pnpm typecheck`, `pnpm lint`, formatting on changed files, and
  `pnpm architecture:check --changed`.
- No user-facing interaction change is intended. Unit equivalence and existing
  UI regressions are required; real Electron input/scroll/frame-time profiling
  remains necessary before claiming whole-application responsiveness gains.
