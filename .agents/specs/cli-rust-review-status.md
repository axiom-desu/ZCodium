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
- Native Windows/macOS runtime execution has not been performed. Actual CI run `38042550013` reports both Windows and macOS native compile jobs successful; this is compile evidence only, runtime remains unchecked. The local Linux Windows cross-check is blocked by missing native MSVC `lib.exe`; do not infer native Windows runner outcome from that.
- Storage path ownership remains distinct: Rust effective config target matches TS `DefaultRuntimeConfig.storage` (`~/.zcodium`); shared standalone SQLite fallback is `~/.zcodium-exp`. No home migration is performed or authorized.
- Product acceptance remains pending for capabilities including browser/CUA, Node REPL, memory, MCP OAuth and other non-exhaustively tested behavior. Do not mark M2–M8 or overall parity complete.

## CI and verification record

- A local workspace-freshness pass is not evidence of a clean checkout: ignored stale `dist` artifacts can hide missing build prerequisites. Actual CI run `38042550013` failed contract asset checking with missing `@zcode/contracts/dist/index.js` (`/tmp/cli-rust-ci-contract.log`) and failed Linux Node CLI build because contracts/adapters/core/i18n/bootstrap dist prerequisites were absent (`/tmp/cli-rust-ci-node-build.log`). Both Node jobs now require the repository's shared Turbo dependency build before checks/build; full clean-worktree verification is tracked separately from local state.
- Actual stable Rust 1.99 CI clippy rejected the one-item `properties` loop in `schema_shape.rs` as `single_element_loop` (`/tmp/cli-rust-ci-clippy.log`). Fix preserves shape rejection with a direct condition; CI toolchain and `-D warnings` remain unchanged.
- Protocol/schema job installs workspace dependencies, builds Node dependencies, then checks current protocol schema, contract assets and domain fixtures.
- Driver entry `pnpm test:zcode-cli-rust-drivers` currently has 15 cases. The distinct CI script regression suite command is `node --test --test-isolation=none scripts/ci/*.test.mjs` and has 256 cases.
- Linux interop builds Node workspace prerequisites, then the current Node CLI bundle and Rust binary/reader, then invokes the script with explicit debug artifact paths. Native Windows/macOS jobs run cargo check only; run 38042550013 passed both native compile jobs, not runtime.
- Root `pnpm lint` has 51 TypeScript warnings. Full-workspace Rust lint previously passed locally under Rust 1.98 (`/tmp/cli-rust-main-workspace-clippy.log`), but the actual stable Rust 1.99 CI lint found the `single_element_loop` error described above; CI is not downgraded and the source is corrected. `cargo fmt --all --check` passed previously. Root `pnpm fmt:check` (oxfmt) latest result is 79 failures; scoped task files are checked separately. `/tmp/cli-rust-main-format.log` is a local evidence log, not the verification command. Root CI uses Node 24.14.0; local Node is 24.19.0.
- Migration SQL content/whitespace is checksum-sensitive. `node --import tsx scripts/sync-zcode-cli-rust-node-migrations.mjs --check` must verify all 22 historical SQL files. An earlier broad diff-check claim was misleading because SQL files were untracked and omitted; this change must not alter SQL or global whitespace rules.
- `pnpm typecheck`, changed architecture, crate boundaries, clippy and Rust tests have passed in the recorded evidence. Final command outputs take precedence over this record.

For current detailed criteria and M8 interpretation see [runtime spec](cli-rust-runtime.md) and [CI spec](cli-rust-ci.md).
