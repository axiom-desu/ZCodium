# Linear plugin UI instance derivation

## Scope and product rules

Optimize `deriveLogicalUiInstances`, which the conversation timeline calls whenever
its immutable rows change. Preserve its return shape, first-seen logical-instance
order, active-call selection, superseded call IDs and recent-turn eligibility.
There is no new UI interaction, cross-call cache, persistent state or protocol.

- No plugin UI rows: return a fresh empty derivation without constructing the
  full turn directory or logical groups.
- A turn's order is its first occurrence among **all** rows, including turns with
  no plugin UI. Non-contiguous rows do not create extra turns.
- Keep `turnOrder.slice(-(autoExpandTurns ?? 3))` semantics, including existing
  zero, negative, fractional, infinite and NaN arguments; do not clamp options.
- Group identity still uses the existing logical-scope resolver and the same
  plugin/server/resource/scope JSON key. Ordinary calls remain separate;
  explicit surfaces and compatible widget permissions may share.
- Only successful non-isError rows participate in replacement. The final such
  row is active; absent success, the final row is active. Failed, cancelled,
  running and isError rows do not supersede successful results.
- Preserve superseded ID order and duplicates, row-reference comparisons and
  group-order last-write behavior for repeated toolCallIds. This optimization
  does not redefine unusual/duplicate identities or returned-record behavior.
- Internal string membership indices must not read Object.prototype entries;
  prototype-like and numeric-string turn/call IDs must not collide.

## Owner and boundaries

```text
CLI/runtime authoritative conversation rows
  ├─ desktop-continuous live frames ──────────┐
  └─ web-remote-replayable snapshot / repair ─┤
                                             v
                                  existing session projection
                                             v
                       pure per-call plugin UI instance derivation
                                             v
                     existing timeline / plugin disclosure read model
```

All indices are local arrays and null-prototype records owned by one synchronous
function invocation. They become unreachable after it returns. No Map/Set or
additional renderer owner is introduced. Existing workspace/session isolation,
sandbox lifecycle, leases, command admission and frame/recovery semantics remain
unchanged. Input rows, metadata and previously returned results are never mutated.
Public interfaces and module dependencies are unchanged.

## Complexity requirement

Replace repeated linear membership tests over full turn and superseded-call
arrays with per-invocation indices. Membership/grouping work should scale as
O(R + P + T), with O(P + T) temporary space, where R is row count, P plugin UI row
count and T distinct turn count. Existing metadata parsing/stringification costs
are separate and remain proportional to their input sizes. No-plugin input needs
only O(R) detection and allocates no turn directory.

## Acceptance and verification

1. Empty and no-plugin histories return independent fresh empty results.
2. Recent turns include non-plugin turns and use first-seen order, not numeric
   ID order, last occurrence or plugin-only order.
3. Mixed success/failure/isError, forced-inline metadata and distinct/shared
   scopes produce the same results as the pre-optimization reference.
4. Duplicate call IDs, repeated row objects, non-contiguous turns and arbitrary
   option values retain reference semantics.
5. Internal indices handle prototype-like IDs. Do not bundle a separate change
   to the returned `byToolCallId` record's prototype/assignment behavior.
6. Frozen input and previous output remain unchanged across subsequent calls;
   streamed row replacements and replay/snapshot replacements remain equal to
   the reference after every step.
7. Add focused Vitest coverage to Desktop CI using the existing UI configuration.
8. Run a synthetic derivation-only benchmark with no-plugin, sparse-plugin and
   shared-surface histories at 300/1,500/6,000/12,000 rows. Schema-validate fixtures
   outside timing. Optionally compare an older prepared checkout through its
   public entry, alternating implementations on the same inputs with periodic
   equality assertions outside timing. Report Node/CPU, warmup, sample count and
   p50/p95. Do not use noisy wall-clock assertions as correctness tests or claim
   Electron/VS Code whole-window results.
9. Run root typecheck/lint, architecture checks and formatting. Preserve unrelated
   local files, including untracked logs. This iteration is independent of the
   earlier turn-render cache PR and does not require merging or modifying it.

## Benchmark commands

```sh
node scripts/benchmarks/plugin-ui-instance-derivation.mjs
node scripts/benchmarks/plugin-ui-instance-derivation.mjs --baseline-root /path/to/prepared-old-checkout
```

The optional baseline must be a Git checkout with no tracked changes under
`packages/ui/src/plugin-ui`, contain the original `turnOrder.includes` policy and
have its workspace dependencies available (root and package-level node_modules).
The script records the baseline revision and checks for the legacy source marker
to catch accidentally loading the current implementation twice; this sanity check
is not a substitute for reviewing the recorded baseline revision. Both modes use 15 warmup iterations and 100
samples per case. Fixture construction, schema checks and output assertions are
not included in the measured interval. No actual user conversation is loaded.
