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
use the same Rust actor and persisted session store. Permission choices require
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
questions, cancellation, continue/history, exit and terminal restoration. This is
not full TS TUI parity: the visible history is a bounded snapshot window, and
advanced terminal plugin/marketplace, attachment picker, memory/CUA and rich
terminal widgets are not claimed. Native Windows/macOS interactive execution is
separate from compile acceptance.

Latest M8 wiring and pending user-run testing: [desktop handoff report](../../docs/reports/cli-rust-m8-desktop-handoff.md). The 470/50 counts below predate M8; full desktop recovery is not yet accepted.

Earlier scoped M2–M6 work, verification and remaining tasks: [handoff](../../.agents/specs/cli-rust-handoff.md). These are scoped results, not a claim of milestone completion.

This directory contains the mechanically migrated source from `MBearo/ZCode-rs` at commit `06ba9781486cffd395d586ec16138c2eeb5edd58`, with the local M1 protocol implementation retained; the upstream npm launcher is excluded. Current controlled Rust tests report 470 passed and 1 ignored; Linux Node/Rust interop has passed its current alternate, crash-recovery, and different-workspace concurrency cases. The transformation inventory has 70 leaf branches × 5 = 350 leaf cases validating publicNode normalization projection, plus 29 complete Command cases and 1 ACK case validated through `parse_command` + serde outputs. These scoped results are not exhaustive product parity or completion of M2–M8.

The Node driver entry `pnpm test:zcode-cli-rust-drivers` currently has 50 cases; the separate CI script regression suite `node --test --test-isolation=none scripts/ci/*.test.mjs` has 264 cases. Root `pnpm lint` has 50 TypeScript warnings and no errors; root `pnpm fmt:check` (oxfmt) is blocked only by 5 unrelated untracked JSON files in `logs/`. CI run `38042550013` reports native Windows and macOS compile jobs passed; native runtime remains unchecked. The same clean-checkout run exposed missing Node workspace build prerequisites in protocol contract checks and Linux CLI build; workspace freshness in a local checkout is not a clean-checkout proof. Stable Rust 1.99 also surfaced a `single_element_loop` clippy error fixed in schema shape validation without weakening CI. CI uses Node 24.14.0; local validation uses Node 24.19.0. See [CI acceptance contract](../../.agents/specs/cli-rust-ci.md) for evidence and required clean-worktree verification.

Packaged `ZCodium Rust` (preview flavor) now defaults to Rust; `ZCodium Exp` and unpackaged development default to TS. Explicit `ZCODE_AGENT_SERVER_RUNTIME=ts|zcode-cli-rust` overrides the product default; missing Rust fails closed. See [default policy](../../.agents/specs/cli-rust-preview-default.md). The effective config default must match the current TS CLI storage default (`~/.zcodium`); the shared standalone SQLite session-store fallback uses `.zcodium-exp`, a separate fallback whose mismatch with TS CLI defaults remains an independent decision. Do not migrate user data or claim that Rust defaults universally use `.zcodium-exp`.

Mixed-runtime owner coordination for the same workspace remains unverified. The former M8 storage-preparation blocker now has explicit runtime selection and a native preparation transport implementation; TS→Rust historical-session takeover acceptance remains pending. Rust is intended to replace TS; reverse Rust→TS recovery is not a product gate. Do not add fallback behavior or expand UI/platform interfaces as a workaround. Native Windows/macOS runtime execution has not been performed; native CI compile checks are not runtime evidence. Product acceptance remains pending for browser/CUA, Node REPL, memory, MCP OAuth and other unverified behavior. See [migration spec](../../.agents/specs/cli-rust-runtime.md), [review status](../../.agents/specs/cli-rust-review-status.md), and [CI acceptance contract](../../.agents/specs/cli-rust-ci.md).
