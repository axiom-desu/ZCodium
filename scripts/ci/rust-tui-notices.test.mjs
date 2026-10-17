// CI runs scripts/ci/*.test.mjs; import the focused Node test so this gate is included there too.
import "../tests/rust-tui-notices.test.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readRustTuiNotices } from "../third-party-notices.mjs";

test("checked-in Rust TUI provenance matches the current lockfile and original snapshots", async () => {
  const { inventory } = await readRustTuiNotices(undefined, { verify: true });
  assert.ok(inventory.crates.length > 0);
  assert.ok(inventory.crates.some(({ name }) => name === "ratatui"));
  assert.ok(inventory.crates.some(({ name }) => name === "crossterm"));
  assert.ok(
    inventory.crates
      .find(({ name }) => name === "r-efi")
      .notices.some(({ member }) => member.endsWith("/AUTHORS")),
  );
  for (const name of [
    "jni",
    "jni-macros",
    "jni-sys-macros",
    "rmcp",
    "rustls-platform-verifier-android",
    "winapi-i686-pc-windows-gnu",
    "winapi-x86_64-pc-windows-gnu",
  ]) {
    const crate = inventory.crates.find((item) => item.name === name);
    assert.ok(crate.upstreamNotices.length > 0);
    assert.equal(crate.reviewRequired, undefined);
  }
});
