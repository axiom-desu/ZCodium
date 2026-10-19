# Rust Native TUI: Sidebar Parity

## Behavior

The Rust terminal sidebar must carry the same sections and reading order as the TypeScript sidebar so both CLIs feel like one product, while every number still comes from state the Rust runtime actually owns.

Order, from the top:

1. `ZCodium <version>` header: product name in accent, version muted.
2. `Status`: current activity line, the last stop state, and the last error when present.
3. `Subagents (n)`: running count, ended total, and up to three child session ids.
4. `Modified Files`: files touched by file-diff tool cards in the loaded window, with `+additions -deletions`, capped at six rows.
5. `Todos`: `Progress completed/total` plus up to six steps with `✔` / `▶` / `○` markers.
6. Workspace path pinned to the bottom in muted text.

Empty states are explicit (`No subagents yet.`, `No file changes yet.`, `No todos yet.`). Wide terminals show the sidebar as a 42-column panel; narrow terminals keep the existing `Ctrl-X,B` overlay and never shrink the conversation below the frame minimum.

`MCP` is intentionally absent from the Rust sidebar: the Rust runtime answers `mcp/list` only through an asynchronous auxiliary query and the sidebar contract for connection status has no state owner in the terminal projection yet. Showing a section there would mean inventing connection state, which the modernization spec forbids. This gap is documented rather than faked.

## State ownership and interfaces

The sidebar is still a pure projection of `View`; no new runtime owner appears.

```text
state.control (phase/canStop/stopState/lastError) → Status
state.subagents (running/endedTotal/childSessionIds) → Subagents
state.plan.items (content/status) → Todos
rows[].output.display (file_diff: filePath/additions/deletions) → Modified Files
view.directory → footer
view.busy() / pendingInteractions → activity line
```

`Modified Files` aggregates the tool-layer display data already present on file-diff rows (`additions`/`deletions` come from the tool adapter, not re-counted by the UI). It only reads rows already bounded by `MAX_ROWS`, aggregates by path, and never re-diffs files or touches disk.

No core, protocol, admission, session, or MCP process semantics change.

## Acceptance scenarios

- With subagents, plan items and file-diff rows present, the sidebar shows `Subagents (2)`, `Progress 1/3`, per-file `+n -n`, and the workspace footer path.
- With empty state, each section renders its explicit empty line instead of disappearing.
- Long values are truncated to the sidebar width and never wrap or overflow into the conversation pane.
- Narrow terminals keep the overlay behavior and the conversation column width.
- `NO_COLOR` still resets every cell, and the PTY smoke (sidebar toggle/resize/pickers) keeps passing.
