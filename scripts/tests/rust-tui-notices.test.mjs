import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { readRustTuiNotices, readVerifiedNotices } from "../third-party-notices.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const registrySource = "registry+https://github.com/rust-lang/crates.io-index";
const lockPackage = (name, version, checksum, dependencies = [], source = registrySource) =>
  `[[package]]\nname = "${name}"\nversion = "${version}"\n${source ? `source = "${source}"\n` : ""}${dependencies.length ? `dependencies = [\n${dependencies.map((dep) => ` "${dep}",\n`).join("")}]\n` : ""}${source ? `checksum = "${checksum}"\n` : ""}`;
const lockText = () =>
  `version = 4\n\n${lockPackage("zcode-cli-tui", "0.1.0", "", ["ratatui"], null)}\n${lockPackage("ratatui", "0.29.0", "a".repeat(64), ["crossterm"])}\n${lockPackage("crossterm", "0.27.0", "b".repeat(64))}`;
async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "rust-tui-notices-"));
  const snapshotDir = resolve(root, "third-party/rust-tui/snapshots");
  await mkdir(snapshotDir, { recursive: true });
  const lock = Buffer.from(lockText().replaceAll("\n", "\r\n"));
  const lockPath = resolve(root, "apps/zcode-cli-rust/Cargo.lock");
  await mkdir(resolve(root, "apps/zcode-cli-rust"), { recursive: true });
  await writeFile(lockPath, lock);
  const text = Buffer.from("Original upstream LICENSE\n");
  await writeFile(resolve(snapshotDir, "license.txt"), text);
  const crates = [
    { name: "ratatui", version: "0.29.0", source: registrySource, checksum: "a".repeat(64) },
    { name: "crossterm", version: "0.27.0", source: registrySource, checksum: "b".repeat(64) },
  ].map((crate) => ({
    ...crate,
    archiveSha256: crate.checksum,
    notices: [
      {
        member: `${crate.name}-${crate.version}/LICENSE`,
        file: "third-party/rust-tui/snapshots/license.txt",
        sha256: hash(text),
      },
    ],
  }));
  const inventory = {
    schemaVersion: 1,
    scope: "fixture",
    lockFile: "apps/zcode-cli-rust/Cargo.lock",
    lockSha256: hash(Buffer.from(lock.toString("utf8").replaceAll("\r\n", "\n"))),
    crates,
  };
  const inventoryPath = resolve(root, "third-party/rust-tui/sources.json");
  const save = () => writeFile(inventoryPath, JSON.stringify(inventory));
  await save();
  return { root, inventory, inventoryPath, lockPath, save, snapshotDir };
}

test("Rust notice verifier rejects Cargo.lock drift and snapshot tampering", async () => {
  const f = await fixture();
  try {
    await readRustTuiNotices(f.root, { verify: true });
    await writeFile(f.lockPath, "new crate dependency\n");
    await assert.rejects(readRustTuiNotices(f.root, { verify: true }), /Cargo.lock changed/);
    await writeFile(f.lockPath, lockText());
    await writeFile(resolve(f.snapshotDir, "license.txt"), "tampered\n");
    await assert.rejects(readRustTuiNotices(f.root, { verify: true }), /Changed Rust crate notice/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Rust notice verifier rejects omitted crates and incorrect lock checksums", async () => {
  const f = await fixture();
  try {
    f.inventory.crates.pop();
    await f.save();
    await assert.rejects(
      readRustTuiNotices(f.root, { verify: true }),
      /Missing locked Rust TUI crate/,
    );
    f.inventory.crates.push({
      name: "crossterm",
      version: "0.27.0",
      source: registrySource,
      checksum: "c".repeat(64),
      archiveSha256: "c".repeat(64),
      notices: [],
      reviewRequired: "Fixture review",
    });
    await f.save();
    await assert.rejects(readRustTuiNotices(f.root, { verify: true }), /provenance mismatch/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Rust notice verifier rejects extra registry closure nodes absent from inventory", async () => {
  const f = await fixture();
  try {
    const updated = `${lockText()}\n${lockPackage("extra-crate", "1.0.0", "d".repeat(64))}`;
    // Extra registry node becomes expected only when reachable from a lock dependency edge.
    await writeFile(
      f.lockPath,
      updated.replace(' "crossterm",\n', ' "crossterm",\n "extra-crate",\n'),
    );
    const reachable = await (await import("node:fs/promises")).readFile(f.lockPath, "utf8");
    f.inventory.lockSha256 = hash(Buffer.from(reachable.replaceAll("\r\n", "\n")));
    await f.save();
    await assert.rejects(
      readRustTuiNotices(f.root, { verify: true }),
      /Missing locked Rust TUI crate: extra-crate/,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Rust notice verifier rejects escaping snapshot paths and symlinks", async () => {
  const f = await fixture();
  try {
    f.inventory.crates[0].notices[0].file = "third-party/rust-tui/snapshots/../../escape.txt";
    await f.save();
    await assert.rejects(
      readRustTuiNotices(f.root, { verify: true }),
      /Invalid Rust crate snapshot path/,
    );
    await symlink(resolve(f.root, "outside.txt"), resolve(f.snapshotDir, "outside-link.txt"));
    await writeFile(resolve(f.root, "outside.txt"), "outside\n");
    f.inventory.crates[0].notices[0].file = "third-party/rust-tui/snapshots/outside-link.txt";
    await f.save();
    await assert.rejects(readRustTuiNotices(f.root, { verify: true }), /symlink escapes/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("strict verified notices rejects Rust reviewRequired independent of aggregate inventory", async () => {
  const f = await fixture();
  try {
    f.inventory.crates[0].notices = [];
    f.inventory.crates[0].reviewRequired = "Missing license text requires manual review.";
    await f.save();
    const notices = Buffer.from("existing notices\n");
    await writeFile(resolve(f.root, "THIRD-PARTY-NOTICES.md"), notices);
    await mkdir(resolve(f.root, "third-party"), { recursive: true });
    await writeFile(
      resolve(f.root, "third-party/inventory.json"),
      JSON.stringify({
        schemaVersion: 1,
        noticesSha256: hash(notices),
        inputs: {},
        reviewRequired: [],
      }),
    );
    await assert.rejects(
      readVerifiedNotices(f.root, { requireComplete: true }),
      /Unresolved Rust TUI material obligations/,
    );
    delete f.inventory.crates[0].reviewRequired;
    await f.save();
    await assert.rejects(readRustTuiNotices(f.root, { verify: true }), /Missing reviewRequired/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
