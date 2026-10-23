import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../../.github/workflows/cli-rust.yml", import.meta.url),
  "utf8",
);
const knipConfig = JSON.parse(await readFile(new URL("../../knip.json", import.meta.url), "utf8"));
const driverJob = workflow.split("  protocol-schema:")[1]?.split("  linux-node-interop:")[0];
const interopJob = workflow.split("  linux-node-interop:")[1]?.split("  native-platform-check:")[0];
const nativeJob = workflow.split("  native-platform-check:")[1];

test("Rust TUI PTY acceptance follows a fresh Rust build in the same Linux job", () => {
  assert.ok(interopJob);
  const build = interopJob.indexOf("--bin zcode-cli-rust --example node_read");
  const smoke = interopJob.indexOf("node scripts/zcode-cli-rust-tui-smoke.mjs");
  assert.ok(build >= 0 && smoke > build);
  assert.match(interopJob, /node scripts\/zcode-cli-rust-tui-smoke\.mjs --provider-discovery/);
  assert.ok(
    interopJob.indexOf("node scripts/ci/tui-quit-pty-smoke.mjs") >
      interopJob.indexOf("Build Node CLI"),
  );
});

test("Rust TUI workbench PTY acceptance runs after the baseline smoke in the same Linux job", () => {
  assert.ok(interopJob);
  const baseline = interopJob.indexOf("node scripts/zcode-cli-rust-tui-smoke.mjs");
  const workbench = interopJob.indexOf("node scripts/zcode-cli-rust-workbench-smoke.mjs");
  assert.ok(baseline >= 0 && workbench > baseline);
});

// fixture 是被 spawn 的真实 stdio 进程，没有 import 边；不能用 ignore pattern 掩盖，
// 只能在 root entry 精确登记它（以及唯一的 driver 入口）。
test("workbench driver and its spawned MCP fixture are precise knip root entries", () => {
  const entries = knipConfig.workspaces["."].entry;
  assert.ok(entries.includes("scripts/zcode-cli-rust-workbench-smoke.mjs"));
  assert.ok(entries.includes("scripts/ci/fixtures/mcp-workbench.mjs"));
});

// M4/M5 在该 job 中用 cargo --offline 构建 examples；别的 job 的缓存不属于本 runner。
test("Rust driver job installs its own Rust toolchain before running differential tests", () => {
  assert.ok(driverJob);
  const rust = driverJob.indexOf("uses: dtolnay/rust-toolchain@stable");
  const drivers = driverJob.indexOf("run: pnpm test:zcode-cli-rust-drivers");
  assert.ok(rust >= 0 && drivers > rust);
});

test("offline Rust drivers have locked Cargo dependency preparation in the same job", () => {
  const fetch = driverJob.indexOf(
    "run: cargo fetch --locked --manifest-path apps/zcode-cli-rust/Cargo.toml",
  );
  const rust = driverJob.indexOf("uses: dtolnay/rust-toolchain@stable");
  const drivers = driverJob.indexOf("run: pnpm test:zcode-cli-rust-drivers");
  assert.ok(fetch > rust && drivers > fetch);
});

test("Windows and macOS native runners execute the non-TTY CLI entry integration test", () => {
  assert.ok(nativeJob);
  assert.match(nativeJob, /os: \[windows-latest, macos-latest\]/);
  const compile = nativeJob.indexOf("cargo check --locked --workspace --all-targets");
  const entryStep = nativeJob.indexOf("- name: Native non-TTY CLI entry tests");
  const workingDirectory = nativeJob.indexOf("working-directory: apps/zcode-cli-rust", entryStep);
  const entryTest = nativeJob.indexOf("run: cargo test --locked --test cli_entry", entryStep);
  assert.ok(compile >= 0 && entryStep > compile);
  assert.ok(workingDirectory > entryStep && entryTest > workingDirectory);
});

test("Rust driver prerequisite does not replace current TS build or contract checks", () => {
  for (const command of [
    "pnpm build:zcode-cli-rust-oracle-deps",
    "pnpm check:zcode-cli-rust-protocol-schema",
    "pnpm check:zcode-cli-rust-contract-assets",
    "pnpm check:zcode-cli-rust-domain-fixtures",
    "pnpm check:zcode-cli-rust-state-fixtures",
  ])
    assert.ok(driverJob.includes(`run: ${command}`));
});
