# N1 Rust native parity: hooks, search, automation, control and MCP grants

This Rust-only follow-up supersedes the R3 exclusions only where a real owner and authenticated port exist. D3 owns state/session-data migrations; N1 must not edit `crates/state/**/session_data*`, migration SQL, manifests or locks. The engine remains the only accepted-input queue owner (`EngineCommandInbox`); native session-control tools may not accept into another queue.

## Rules / owners

- Hook `onError: allow|deny` is a per-hook registration property read from real user/plugin config and workspace policy provider; default `allow`. Only a foreground failed `PreToolUse` hook with `deny` denies; cancellation and all other event failures retain prior behavior. It is not a HookEvent.
- Workspace hooks: the declared `onError` participates in the canonical entry and declaration/bundle digest, so adding or changing it invalidates the old grant (`stale_digest`) and requires a review. Rust `workspace::registrations` does not forward it (same as TS `workspaceEntryToHookConfig`), so project-hook execution keeps the default `allow`; no `OnError` event is introduced.
- `LocalToolSearch` is a model-visible spelling only in local mode, normalized to `ToolSearch` for lookup, permission and history. Native mode retains `ToolSearch`.
- WebSearch ask budget can be charged only by an actual native workflow/ask owner and before network/model work; never infer a budget or ask boundary from arbitrary turns.
- `CronPauseSelf` requires automation ID admitted by Host/reverse RPC and uses the existing automation pause authority. Empty tool input cannot select an ID. No model-selected ID or fake success.
- The eight native session-control tools and plugin discovery require real root/session/host ports; reuse existing Engine admission, permission and inbox. No secondary accepted queue or fake unsupported tool. New protocol methods require public contract + schema and, if TS-shared, manifest ownership.
- Workspace MCP grant can only be accepted with the TS hardened provenance, canonical digest and persistence lock authority. Rust must not invent another trust database; if that owner cannot be reached, typed unavailable remains an explicit gap.

## Acceptance

Test real Rust Engine/protocol, prompt/tool visibility, permission and cold resume for each landed capability. Run workspace `cargo fmt --all -- --check`, `cargo clippy --locked --workspace --all-targets -- -D warnings`, and `cargo test --locked --workspace`. Report each blocked capability explicitly; do not label it N/A.
