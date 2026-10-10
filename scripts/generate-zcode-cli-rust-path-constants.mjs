// Generate pure Rust path-name constants from the shared TS source of truth.
import { readFile, writeFile } from "node:fs/promises";
import {
  LEGACY_ZCODE_USER_DATA_DIR_NAME,
  ZCODE_PLUGIN_MANIFEST_DIR_NAME,
  ZCODE_USER_DATA_DIR_NAME,
  ZCODE_WORKSPACE_CONFIG_DIR_NAME,
} from "../packages/shared/src/appDirNames.ts";

const constants = {
  ZCODE_USER_DATA_DIR_NAME,
  LEGACY_ZCODE_USER_DATA_DIR_NAME,
  ZCODE_WORKSPACE_CONFIG_DIR_NAME,
  ZCODE_PLUGIN_MANIFEST_DIR_NAME,
};
const source = `// Generated from packages/shared/src/appDirNames.ts; do not edit by hand.\n${Object.entries(
  constants,
)
  .map(([name, value]) => `pub const ${name}: &str = ${JSON.stringify(value)};`)
  .join("\n")}\n`;
const path = new URL("../apps/zcode-cli-rust/crates/domain/src/path_names.rs", import.meta.url);
if (process.argv.includes("--check")) {
  if ((await readFile(path, "utf8")) !== source)
    throw new Error("Rust path-name constants differ from TS; regenerate them");
} else await writeFile(path, source);
