import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../../.github/workflows/cli-rust.yml", import.meta.url),
  "utf8",
);
const driverJob = workflow.split("  protocol-schema:")[1]?.split("  linux-node-interop:")[0];

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

test("Rust driver prerequisite does not replace current TS build or contract checks", () => {
  for (const command of [
    "pnpm build:zcode-cli-rust-oracle-deps",
    "pnpm check:zcode-cli-rust-protocol-schema",
    "pnpm check:zcode-cli-rust-contract-assets",
    "pnpm check:zcode-cli-rust-domain-fixtures",
  ])
    assert.ok(driverJob.includes(`run: ${command}`));
});
