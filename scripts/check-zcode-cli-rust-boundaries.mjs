#!/usr/bin/env node
// zcode-cli-rust 的 crate 边界与源码约束检查。
//
// 架构规格见 .agents/specs/cli-rust-runtime.md。Cargo 能表达依赖方向，但表达不了
// 「domain 不许碰 IO」「application 不许 import adapter」这类规则，也无法限制单文件长度，
// 所以在这里用源码扫描补齐。CI 通过 pnpm check:zcode-cli-rust 调用。

import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../apps/zcode-cli-rust/crates");

/**
 * 允许的依赖方向。key 依赖 value 里的全部；未列出的 crate 之间不允许有边。
 *
 *   protocol / domain → core-api → core
 *                            ↑
 *               state / model / tools / host / net / bash / plugins
 *                            ↓
 *                 app-server / tui / headless → cli binary
 */
const ALLOWED_DEPS = {
  protocol: [],
  domain: [],
  "core-api": ["protocol", "domain"],
  core: ["protocol", "domain", "core-api"],
  net: ["protocol", "domain", "core-api"],
  host: ["protocol", "domain", "core-api"],
  state: ["protocol", "domain", "core-api", "host"],
  model: ["protocol", "domain", "core-api", "host", "net"],
  tools: ["protocol", "domain", "core-api", "host", "bash-parse", "bash", "plugins"],
  "bash-parse": [],
  bash: ["protocol", "domain", "core-api", "bash-parse"],
  plugins: ["protocol", "domain", "core-api"],
  "app-server": ["protocol", "domain", "core-api", "core", "state", "model", "tools", "host"],
  headless: ["protocol", "domain", "core-api", "core", "state", "model", "tools", "host"],
  tui: ["protocol", "domain", "core-api", "core", "state", "model", "tools", "host"],
};

/** application 层 crate：不得 import adapter，不得做文件/网络/进程 IO。 */
const APPLICATION_CRATES = ["protocol", "domain", "core-api", "core"];

/** adapter 层 crate：不得被 application 层依赖（由 ALLOWED_DEPS 保证）。 */
const ADAPTER_CRATES = ["state", "model", "tools", "host", "net", "bash", "bash-parse", "plugins"];

/** domain 是纯领域层：不依赖 tokio / reqwest / rusqlite，也不直接碰文件系统。 */
const DOMAIN_FORBIDDEN_CRATES = ["tokio", "reqwest", "rusqlite", "hyper"];

/** application 层禁用的 IO 模块。 */
const APPLICATION_FORBIDDEN_MODULES = [
  "node_fs",
  "std::fs",
  "tokio::fs",
  "tokio::net",
  "tokio::process",
  "std::net",
  "std::process",
  "reqwest",
];

const MAX_FILE_LINES = 400;

const failures = [];

function fail(message) {
  failures.push(message);
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(path)));
    } else if (entry.name.endsWith(".rs")) {
      files.push(path);
    }
  }
  return files;
}

/** 从 Cargo.toml 的 [dependencies] 里取出本 workspace 的 crate 依赖。 */
function parseWorkspaceDeps(cargoToml) {
  const deps = [];
  let inDependencies = false;
  for (const rawLine of cargoToml.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      inDependencies = line === "[dependencies]";
      continue;
    }
    if (!inDependencies || !line) continue;
    const match = /^zcode-cli-([a-z-]+)/.exec(line);
    if (match) deps.push(match[1]);
  }
  return deps;
}

async function main() {
  const crateDirs = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  for (const crate of crateDirs) {
    if (!(crate in ALLOWED_DEPS)) {
      fail(`${crate}: 未在 ALLOWED_DEPS 中声明，拒绝未登记的 crate`);
      continue;
    }
  }

  for (const crate of crateDirs) {
    const cargoPath = resolve(root, crate, "Cargo.toml");
    let cargoToml;
    try {
      cargoToml = await readFile(cargoPath, "utf-8");
    } catch (error) {
      fail(`${crate}: 无法读取 Cargo.toml (${error.message})`);
      continue;
    }
    const declared = parseWorkspaceDeps(cargoToml);
    const allowed = ALLOWED_DEPS[crate] ?? [];

    for (const dep of declared) {
      if (!allowed.includes(dep)) {
        fail(
          `${crate} → ${dep}: Cargo.toml 声明了不允许的依赖边（允许：${allowed.join(", ") || "无"}）`,
        );
      }
    }
    for (const dep of allowed) {
      if (!declared.includes(dep)) {
        fail(`${crate} → ${dep}: 规格要求该依赖边，但 Cargo.toml 未声明`);
      }
    }
  }

  for (const crate of crateDirs) {
    const crateRoot = resolve(root, crate);
    for (const filePath of await walk(crateRoot)) {
      const rel = relative(root, filePath).replaceAll("\\", "/");
      const source = await readFile(filePath, "utf-8");
      // 去掉注释与字符串，避免注释里的示例触发误报。
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/[^\n]*/g, "")
        .replace(/"(?:[^"\\]|\\.)*"/g, '""');

      const lineCount = source.split("\n").length;
      if (lineCount > MAX_FILE_LINES) {
        fail(`${rel}: ${lineCount} 行，超过 ${MAX_FILE_LINES} 行上限（拆文件，别堆）`);
      }

      if (APPLICATION_CRATES.includes(crate)) {
        for (const forbidden of APPLICATION_FORBIDDEN_MODULES) {
          if (code.includes(forbidden)) {
            fail(`${rel}: application 层禁用的 IO 引用 ${forbidden}`);
          }
        }
        for (const adapter of ADAPTER_CRATES) {
          if (code.includes(`zcode_cli_${adapter.replace(/-/g, "_")}`)) {
            fail(`${rel}: application 层不得引用 adapter crate ${adapter}`);
          }
        }
      }

      if (crate === "domain") {
        for (const forbidden of DOMAIN_FORBIDDEN_CRATES) {
          if (code.includes(forbidden)) {
            fail(`${rel}: domain 禁用的依赖 ${forbidden}（domain 必须是无 IO 的纯领域层）`);
          }
        }
      }
    }
  }

  if (failures.length > 0) {
    console.error(`zcode-cli-rust 边界检查失败（${failures.length} 项）：`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log(`zcode-cli-rust 边界检查通过（${crateDirs.length} 个 crate）`);
}

await main();
