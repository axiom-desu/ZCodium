# zcode-cli-rust source landing

## Interactive terminal and Desktop entry

The native Rust frontend now supports an interactive terminal (ratatui/crossterm),
not a TS TUI wrapper. Run from the repository:

```bash
cargo build --locked --manifest-path apps/zcode-cli-rust/Cargo.toml --bin zcode-cli-rust
apps/zcode-cli-rust/target/debug/zcode-cli-rust --cwd /path/to/workspace
apps/zcode-cli-rust/target/debug/zcode-cli-rust --continue
apps/zcode-cli-rust/target/debug/zcode-cli-rust -p "one prompt"
```

Interactive default mode is `build`; explicit `--mode` is preserved. Enter sends,
Alt/Shift+Enter inserts a newline, bracketed paste accepts multiple lines, and
Ctrl+C cancels a running turn or exits when idle. `/help`, `/new`, `/sessions`,
`/resume <id>`, `/mode <mode>`, `/model [provider model [reasoning]]`, and `/quit`
use the same Rust actor and persisted session store. `/compact [instructions]`
(alias `/compress`) uses the actor's existing compaction admission; `/effort [list|level]`
(alias `/variant`) reads and changes the current model's supported reasoning levels.
`/queue [list|pause|resume|edit|delete|send|up|down <id>]` projects and mutates only
the actor's accepted queue. `/mcp` refreshes the read-only MCP status shown in the
sidebar without reconnecting, and `/usage` reads the actor's real usage totals.
Slash suggestions support Tab completion and Enter confirmation; model/mode/session
pickers support text filtering, Ctrl-U clearing, and Escape draft restoration.
The composer shows the committed model, provider, and reasoning level, and compaction
markers render actual actor status. `@` opens bounded workspace path suggestions:
Tab/Enter on a directory keeps completing, on a file inserts `@path ` and adds a draft
attachment; deleting the inline placeholder drops that attachment. Up/Down recalls
persisted input history as an editable draft with its attachments. Input history is
scoped to the new Rust session store and does not mix legacy TS `proj_*` rows. Local
file attachments are supported; an entry whose artifact or inline content cannot be
safely restored keeps the current draft, reports the error explicitly, and the next Up
skips that entry. Startup `--attach` items stay pinned until the first prompt is accepted.
Busy plain prompts are accepted into the actor queue; when a paused queue holds items, a
new prompt is rejected with a clear `/queue resume to continue` notice, and `sendNow`
promotes one item without draining the rest. `/usage` cumulative values are
`queryTaskUsage` growth relative to the source baseline, not a mechanical sum of every
turn's billed input; the context badge is read separately from `contextWindow`.
This incremental scope is documented in [TUI parity](../../.agents/specs/cli-rust-tui-parity.md)
and the [workbench batch](../../.agents/specs/cli-rust-tui-workbench.md), not full TS frontend parity.
Permission choices require
explicit input (`y`/`n` or an offered option ID); questions accept one answer per
line. Non-TTY users should use `-p`; `app-server --stdio` is unchanged.

Packaged desktop executables expose `zcodium-exp --cli …` (TS) and
`zcodium-rust --cli …` (Rust); without `--cli` they still open the GUI. This does
not install a global CLI alias automatically or change the GUI runtime defaults.
See [entry contract](../../.agents/specs/desktop-cli-entry.md) and
[terminal contract](../../.agents/specs/cli-rust-terminal-ui.md).

Linux real-PTY validation is available with
`node scripts/zcode-cli-rust-tui-smoke.mjs`. It uses a disposable profile and local
model fixture to exercise multiple turns, Read/Write, permission allow/deny,
questions, cancellation, continue/history, exit and terminal restoration. The separate
workbench acceptance, `node scripts/zcode-cli-rust-workbench-smoke.mjs`, passed 35 local
PTY checks (attachments 9, queue 13, usage 10, shutdown 3); the existing 20-request
baseline and its provider-discovery mode also pass. Final local verification reports
714 Rust workspace tests passed (1 ignored), including 222 TUI tests; Node drivers
59 passed and CI scripts 429 passed. These are local results pending exact PR HEAD CI;
no merge or CI pass is claimed. This is not full
TS TUI parity: the visible transcript is a bounded snapshot window, and advanced terminal
plugin/marketplace, memory/CUA and rich terminal widgets are not claimed. Native
Windows/macOS interactive execution is separate from compile acceptance.

Latest M8 wiring and pending user-run testing: [desktop handoff report](../../docs/reports/cli-rust-m8-desktop-handoff.md). The 470/50 counts below predate M8; full desktop recovery is not yet accepted.

Earlier scoped M2–M6 work, verification and remaining tasks: [handoff](../../.agents/specs/cli-rust-handoff.md). These are scoped results, not a claim of milestone completion.

This directory contains the mechanically migrated source from `MBearo/ZCode-rs` at commit `06ba9781486cffd395d586ec16138c2eeb5edd58`, with the local M1 protocol implementation retained; the upstream npm launcher is excluded. At the migration baseline, controlled Rust tests reported 470 passed and 1 ignored; Linux Node/Rust interop has passed its current alternate, crash-recovery, and different-workspace concurrency cases. The transformation inventory has 70 leaf branches × 5 = 350 leaf cases validating publicNode normalization projection, plus 29 complete Command cases and 1 ACK case validated through `parse_command` + serde outputs. These scoped results are not exhaustive product parity or completion of M2–M8.

At that migration checkpoint, the Node driver entry `pnpm test:zcode-cli-rust-drivers` reported 50 cases; the separate CI script regression suite `node --test --test-isolation=none scripts/ci/*.test.mjs` reported 264 cases. Root `pnpm lint` had 50 TypeScript warnings and no errors; root `pnpm fmt:check` (oxfmt) was blocked only by 5 unrelated untracked JSON files in `logs/`. These are historical checkpoint values, not current totals. CI run `38042550013` reports native Windows and macOS compile jobs passed; native runtime remains unchecked. The same clean-checkout run exposed missing Node workspace build prerequisites in protocol contract checks and Linux CLI build; workspace freshness in a local checkout is not a clean-checkout proof. Stable Rust 1.99 also surfaced a `single_element_loop` clippy error fixed in schema shape validation without weakening CI. CI uses Node 24.14.0; local validation uses Node 24.19.0. See [CI acceptance contract](../../.agents/specs/cli-rust-ci.md) for evidence and required clean-worktree verification.

Packaged `ZCodium Rust` (preview flavor) now defaults to Rust; `ZCodium Exp` and unpackaged development default to TS. Explicit `ZCODE_AGENT_SERVER_RUNTIME=ts|zcode-cli-rust` overrides the product default; missing Rust fails closed. See [default policy](../../.agents/specs/cli-rust-preview-default.md). The effective config default must match the current TS CLI storage default (`~/.zcodium`); the shared standalone SQLite session-store fallback uses `.zcodium-exp`, a separate fallback whose mismatch with TS CLI defaults remains an independent decision. Do not migrate user data or claim that Rust defaults universally use `.zcodium-exp`.

Mixed-runtime owner coordination for the same workspace remains unverified. The former M8 storage-preparation blocker now has explicit runtime selection and a native preparation transport implementation; TS→Rust historical-session takeover acceptance remains pending. Rust is intended to replace TS; reverse Rust→TS recovery is not a product gate. Do not add fallback behavior or expand UI/platform interfaces as a workaround. Native Windows/macOS runtime execution has not been performed; native CI compile checks are not runtime evidence. Product acceptance remains pending for browser/CUA, Node REPL, memory, MCP OAuth and other unverified behavior. See [migration spec](../../.agents/specs/cli-rust-runtime.md), [review status](../../.agents/specs/cli-rust-review-status.md), and [CI acceptance contract](../../.agents/specs/cli-rust-ci.md).
