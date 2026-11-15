/**
 * Desktop 子工程类型/产物守卫（G7 回归）。
 *
 * 背景：`tsconfig.main.json` 只 include `src/main`，但 main 直接 import 了 `src/host` 与
 * `src/scheduler`。缺少 project references 时 `tsc -b` 会报 TS6059/TS6307，并把
 * `electronPort` / `schedulerProtocol` 的 `.js`/`.d.ts` 产物写回 `src/`。
 * 该测试不跑 tsc，只守住「配置齐全 + 工作树没有回写产物」，避免 CI 重复全量构建。
 */
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const root = new URL("../..", import.meta.url).pathname;
const desktop = join(root, "packages/desktop");

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

/** Windows/注释容忍：只提取 "outDir": "..." 与 "noEmit": true。 */
function readCompilerOption(text, name) {
  const match = new RegExp(`"${name}"\\s*:\\s*(true|"[^"]+")`).exec(text);
  if (!match) return undefined;
  return match[1] === "true" ? true : match[1].slice(1, -1);
}

test("every desktop project config owns an emit boundary", async () => {
  const configs = (await readdir(desktop)).filter(
    (name) => name.startsWith("tsconfig.") && name.endsWith(".json"),
  );
  assert.ok(configs.length >= 6, `expected desktop project configs, got ${configs.length}`);
  for (const name of configs) {
    const text = await readFile(join(desktop, name), "utf8");
    // tsconfig.json 是 solution 文件（files: [] + references），不直接编译任何源文件。
    if (/"files"\s*:\s*\[\s*\]/.test(text)) continue;
    const outDir = readCompilerOption(text, "outDir");
    const noEmit = readCompilerOption(text, "noEmit");
    assert.ok(
      outDir !== undefined || noEmit === true,
      `${name} must declare outDir or noEmit so tsc never writes next to src`,
    );
    if (outDir !== undefined) {
      assert.ok(
        outDir.startsWith("out/"),
        `${name} outDir must stay under packages/desktop/out, got ${outDir}`,
      );
    }
  }
});

test("main references every desktop project it imports", async () => {
  const text = await readFile(join(desktop, "tsconfig.main.json"), "utf8");
  for (const project of [
    "./tsconfig.host.json",
    "./tsconfig.scheduler.json",
    "./tsconfig.app-navigation.json",
  ]) {
    assert.ok(
      text.includes(`"path": "${project}"`),
      `tsconfig.main.json must reference ${project}`,
    );
  }
});

test("root typecheck covers all desktop projects", async () => {
  const pkg = await readJson(join(root, "package.json"));
  const script = pkg.scripts.typecheck;
  for (const project of ["main", "preload", "renderer", "app-navigation", "host", "scheduler"]) {
    assert.ok(
      script.includes(`packages/desktop/tsconfig.${project}.json`),
      `root typecheck must include packages/desktop/tsconfig.${project}.json`,
    );
  }
});

test("no tsc artifacts are written into desktop src", async () => {
  const generated = [
    "src/host/electronPort.js",
    "src/host/electronPort.js.map",
    "src/host/electronPort.d.ts",
    "src/host/electronPort.d.ts.map",
    "src/scheduler/schedulerProtocol.js",
    "src/scheduler/schedulerProtocol.js.map",
    "src/scheduler/schedulerProtocol.d.ts",
    "src/scheduler/schedulerProtocol.d.ts.map",
  ];
  for (const relative of generated) {
    const exists = await stat(join(desktop, relative)).then(
      () => true,
      () => false,
    );
    assert.equal(exists, false, `${relative} is a tsc artifact from a misconfigured project`);
  }
});
