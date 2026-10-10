# Rust CLI checkpoint review status

This checkpoint records current source, test, interop, and CI evidence only. It is not a claim that M2–M8 or exhaustive product parity is complete. The CI handoff contract is in [cli-rust-ci](cli-rust-ci.md).

## Confirmed completed work

- 当前工作树包含从 `MBearo/ZCode-rs` commit `06ba9781486cffd395d586ec16138c2eeb5edd58` 迁入的 Rust 源码快照，并保留本地 M1 protocol implementation；这些 source migration changes 尚未提交。
- Schema validator is pure shared code; unsafe API uses have been replaced with safe APIs. Transformation inventory: 63 paths, 70 leaf branches × 5 cases = 350 leaf cases; 29 complete Command cases and 1 ACK case pass through `parse_command` + serde and validate full outputs. The 350 leaf cases validate publicNode normalization projection, not a complete DTO oracle. These controlled cases are not exhaustive product parity or proof of every possible DTO drift.
- Latest fresh Rust test evidence after schema fix: 426 passed, 1 ignored (`/tmp/zcode-cli-rust-test.log`). The earlier 423 count predates three schema tests and is stale. Rust fmt/clippy/boundaries have passed; current fresh fmt/lint evidence is separately recorded below.
- Current Node driver entry `pnpm test:zcode-cli-rust-drivers`: 15 cases (local log `/tmp/cli-rust-main-node-tests.log`). Separately, `node --test --test-isolation=none scripts/ci/*.test.mjs` is the CI script regression suite with 256 cases; it is not the scripts/tests driver suite.
- Hardened Linux Node/Rust interop: alternate 1/1, crash recovery 4/4 across both kill/resume directions, concurrent different-workspace sessions 2/2; each reported session/read/equal counters match and source hashes remain unchanged using isolated DB copies (`/tmp/cli-rust-hardened-interop.log`).

## Remaining boundaries (not claims of current-case failure)

- Controlled protocol transformations and interop cases are accepted for the tested inputs; this is not exhaustive DTO coverage or product parity. Do not repeat stale claims that protocol strip/trim or `baseRevision` remains unaligned, or that interop has not been migrated/run.
- Mixed-runtime owner coordination for the same workspace is not verified. Interop concurrent case covers different workspaces/sessions only; alternate is sequential on one workspace/session.
- M8 blocker is not a missing Rust `prepare-storage` command: Rust already has the command and frames. Desktop resolver does not declare its capability, so it rejects `prepareSessionStorage` as `unsupported_runtime` before launching Rust. Native process transport is also not connected to the Worker branch. Do not add a fallback or broaden UI/platform interfaces to bypass this gate.
- Native Windows/macOS runtime execution has not been performed. Native CI jobs check compilation only; remote compile results do not establish native runtime success. The local Linux Windows cross-check is blocked by missing native MSVC `lib.exe`; do not infer native Windows runner outcome from that.
- Storage path ownership remains distinct: Rust effective config target matches TS `DefaultRuntimeConfig.storage` (`~/.zcodium`); shared standalone SQLite fallback is `~/.zcodium-exp`. No home migration is performed or authorized.
- Product acceptance remains pending for capabilities including browser/CUA, Node REPL, memory, MCP OAuth and other non-exhaustively tested behavior. Do not mark M2–M8 or overall parity complete.

## CI and verification record

- Protocol/schema job installs workspace dependencies and checks current protocol schema, contract assets and domain fixtures.
- Driver entry `pnpm test:zcode-cli-rust-drivers` currently has 15 cases. The distinct CI script regression suite command is `node --test --test-isolation=none scripts/ci/*.test.mjs` and has 256 cases.
- Linux interop builds the current Node CLI bundle and Rust binary/reader, then invokes the script with explicit debug artifact paths. Native Windows/macOS jobs run cargo check only.
- Root `pnpm lint` has 51 TypeScript warnings. Full-workspace Rust lint passed with no warnings: `cargo clippy --locked --manifest-path apps/zcode-cli-rust/Cargo.toml --workspace --all-targets -- -D warnings` (`/tmp/cli-rust-main-workspace-clippy.log`); this covers all workspace crates and targets, not only root-package targets. `cargo fmt --all --check` passed. Root `pnpm fmt:check` (oxfmt) latest result is 79 failures; the scoped task files have zero formatting issues. `/tmp/cli-rust-main-format.log` is a local evidence log, not the verification command.
- `pnpm typecheck`, changed architecture, crate boundaries, clippy and Rust tests have passed in the recorded evidence. Final command outputs take precedence over this record.

For current detailed criteria and M8 interpretation see [runtime spec](cli-rust-runtime.md) and [CI spec](cli-rust-ci.md).
