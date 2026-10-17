import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink, cp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { verifyRustSourceMatch } from "../rust-tui-upstream-notices.mjs";
import {
  readRustTuiNotices,
  readVerifiedNotices,
  repositoryRoot,
} from "../third-party-notices.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
test("source-match evidence binds the exact published archive, revision and file set", () => {
  const record = {
    name: "winapi",
    version: "0.4.0",
    archiveSha256: "a".repeat(64),
    revision: "b".repeat(40),
    pathInVcs: "i686",
    mismatches: [],
    matches: [{ sourcePath: "i686/build.rs", gitBlobSha1: "c".repeat(40), sha256: "d".repeat(64) }],
  };
  const bytes = Buffer.from(JSON.stringify({ packages: [record] }));
  const registration = {
    ...record,
    evidence: { sourceMatch: { sha256: hash(bytes), matchedFiles: 1 } },
  };
  assert.doesNotThrow(() => verifyRustSourceMatch(registration, bytes));
  assert.throws(
    () => verifyRustSourceMatch({ ...registration, revision: "0".repeat(40) }, bytes),
    /version\/revision proof/,
  );
  assert.throws(
    () => verifyRustSourceMatch(registration, Buffer.from("changed")),
    /evidence changed/,
  );
  assert.throws(
    () =>
      verifyRustSourceMatch(
        { ...registration, evidence: { sourceMatch: { sha256: hash(bytes), matchedFiles: 2 } } },
        bytes,
      ),
    /version\/revision proof/,
  );
});

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

test("Rust upstream originals are bound to locked crate version, archive, and pinned revision evidence", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "rust-tui-upstream-"));
  try {
    await cp(
      resolve(repositoryRoot, "third-party/rust-tui"),
      resolve(root, "third-party/rust-tui"),
      { recursive: true },
    );
    await mkdir(resolve(root, "apps/zcode-cli-rust"), { recursive: true });
    await cp(
      resolve(repositoryRoot, "apps/zcode-cli-rust/Cargo.lock"),
      resolve(root, "apps/zcode-cli-rust/Cargo.lock"),
    );
    const inventoryPath = resolve(root, "third-party/rust-tui/sources.json");
    const pristine = JSON.parse(await readFile(inventoryPath, "utf8"));
    await readRustTuiNotices(root, { verify: true });

    const jni = pristine.crates.find((crate) => crate.name === "jni");
    jni.version = "0.22.3";
    await writeFile(inventoryPath, JSON.stringify(pristine));
    await assert.rejects(
      readRustTuiNotices(root, { verify: true }),
      /Missing locked Rust TUI crate: jni@0.22.4/,
    );

    const restored = JSON.parse(
      await readFile(resolve(repositoryRoot, "third-party/rust-tui/sources.json"), "utf8"),
    );
    const restoredJni = restored.crates.find((crate) => crate.name === "jni");
    restoredJni.upstreamEvidence.revision = "0".repeat(40);
    await writeFile(inventoryPath, JSON.stringify(restored));
    await assert.rejects(
      readRustTuiNotices(root, { verify: true }),
      /revision\/evidence mismatch: jni@0.22.4/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
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
