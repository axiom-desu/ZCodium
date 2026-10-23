// Run with node --import tsx. Regenerates the Rust state fixtures by executing
// the current TS session-store/runtime behavior on fixed scenarios; the Rust
// replay tests must reproduce every row and decoded read.
import { readFile, writeFile } from "node:fs/promises";
import { format } from "oxfmt";
import { nodeDbFixtures } from "./zcode-cli-rust-node-db-fixtures.mjs";
import { nodeColdFixtures } from "./zcode-cli-rust-node-cold-fixtures.mjs";
import { nodeSessionFixtures } from "./zcode-cli-rust-node-session-fixtures.mjs";

async function emit(relative, data) {
  const path = new URL(relative, import.meta.url);
  const formatted = await format(path.pathname, `${JSON.stringify(data, null, 2)}\n`);
  if (formatted.errors.length) throw new Error(`Cannot format ${relative}`);
  if (process.argv.includes("--check")) {
    if ((await readFile(path, "utf8")) !== formatted.code)
      throw new Error(`${relative} differs from current TS oracle`);
  } else await writeFile(path, formatted.code);
}

await emit("../apps/zcode-cli-rust/crates/state/fixtures/node-db.json", await nodeDbFixtures());
await emit("../apps/zcode-cli-rust/crates/state/fixtures/node-cold.json", await nodeColdFixtures());
await emit(
  "../apps/zcode-cli-rust/crates/state/fixtures/node-sessions.json",
  await nodeSessionFixtures(),
);
