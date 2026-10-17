#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, writeFile, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, join } from "node:path";
import { readRustTuiRegistryClosure, rustTuiLockFile } from "./rust-tui-notice-graph.mjs";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const lockPath = rustTuiLockFile;
const outDir = "third-party/rust-tui";
const sha = (data) => createHash("sha256").update(data).digest("hex");
const lock = await readFile(join(root, lockPath), "utf8");
const crates = readRustTuiRegistryClosure(lock);
const cargoHome =
  process.env.CARGO_HOME || join(process.env.HOME || process.env.USERPROFILE, ".cargo");
const cacheRoot = join(cargoHome, "registry/cache");
let caches = [];
try {
  caches = await readdir(cacheRoot);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await mkdir(join(root, outDir, "snapshots"), { recursive: true });
const archives = [];
for (const crate of crates) {
  if (
    ![crate.name, crate.version, crate.source, crate.checksum].every(
      (value) => typeof value === "string" && value.length,
    )
  )
    throw new Error(`Invalid locked crate fields: ${JSON.stringify(crate)}`);
  if (!/^[a-f0-9]{64}$/u.test(crate.checksum))
    throw new Error(`Invalid Cargo.lock checksum: ${crate.name}@${crate.version}`);
  const archiveName = `${crate.name}-${crate.version}.crate`;
  let archive;
  for (const cache of caches) {
    try {
      archive = await readFile(join(cacheRoot, cache, archiveName));
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const archiveUrl = `https://static.crates.io/crates/${crate.name}/${archiveName}`;
  if (!archive) {
    const response = await fetch(archiveUrl);
    if (!response.ok) throw new Error(`Download failed ${archiveUrl}: ${response.status}`);
    archive = Buffer.from(await response.arrayBuffer());
  }
  const archiveSha256 = sha(archive);
  if (archiveSha256 !== crate.checksum)
    throw new Error(`Cargo.lock checksum mismatch: ${archiveName}`);
  const tmp = join(root, outDir, `.${archiveName}.tmp`);
  try {
    await writeFile(tmp, archive);
    const { stdout: listing } = await exec("tar", ["-tzf", tmp]);
    const members = listing
      .split("\n")
      .filter((line) => /(^|\/)(LICENSE|LICENCE|COPYING|NOTICE)([-_.][^/]*)?$/i.test(line));
    const notices = [];
    for (const member of members) {
      const { stdout: content } = await exec("tar", ["-xOzf", tmp, member], {
        encoding: "buffer",
        maxBuffer: 10 * 1024 * 1024,
      });
      if (!content.length) continue;
      const file = `${outDir}/snapshots/${crate.name}-${crate.version}-${sha(member).slice(0, 8)}.txt`;
      await writeFile(join(root, file), content);
      notices.push({ member, file, sha256: sha(content) });
    }
    archives.push({
      name: crate.name,
      version: crate.version,
      source: crate.source,
      checksum: crate.checksum,
      archiveSha256,
      archiveUrl,
      notices,
      ...(!notices.length
        ? {
            reviewRequired:
              "Crate archive contains no root or nested LICENSE/COPYING/NOTICE text snapshot.",
          }
        : {}),
    });
  } finally {
    await unlink(tmp).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
const inventory = {
  schemaVersion: 1,
  scope:
    "All registry crates in the transitive Cargo.lock closure of zcode-cli-tui (including target-specific dependencies); not the complete Rust CLI lockfile.",
  lockFile: lockPath,
  lockSha256: sha(Buffer.from(lock.replaceAll("\r\n", "\n"))),
  crates: archives,
};
if (
  inventory.crates.some(
    (crate) =>
      !crate.name ||
      !crate.version ||
      !crate.source ||
      !crate.archiveUrl ||
      !/^[a-f0-9]{64}$/u.test(crate.archiveSha256),
  )
)
  throw new Error("Generated Rust TUI notice inventory failed schema validation");
await writeFile(join(root, outDir, "sources.json"), `${JSON.stringify(inventory, null, 2)}\n`);
console.log(`Rust TUI license snapshots: ${crates.length} registry crates`);
