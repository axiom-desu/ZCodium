import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  BUILTIN_PLUGIN_ASSETS,
  cuaRuntimeRequiredPaths,
} from "../../packages/shared/src/builtinPluginAssets.ts";
import { validateBuiltinPluginAssets } from "../builtin-plugin-assets.mjs";
import { build } from "esbuild";
import { resolveBuildAliases } from "../../apps/zcode-cli/packages/cli/scripts/build.mjs";

test("CLI bundle resolves the shared asset contract through its production aliases", async () => {
  const result = await build({
    stdin: {
      contents:
        'import { BUILTIN_PLUGIN_ASSETS, cuaRuntimeRequiredPaths } from "@zcode/shared/builtin-plugin-assets"; console.log(BUILTIN_PLUGIN_ASSETS.length);',
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: "node",
    alias: resolveBuildAliases(),
  });
  assert.equal(result.errors.length, 0);
});

test("every bundled plugin has its manifest and source assets, with runtime outputs explicitly declared", async () => {
  const names = new Set();
  for (const plugin of BUILTIN_PLUGIN_ASSETS) {
    assert.ok(!names.has(plugin.directory));
    names.add(plugin.directory);
    const root = new URL(`../../apps/zcode-cli/packages/${plugin.directory}/`, import.meta.url);
    await access(new URL(".zcodium-plugin/plugin.json", root));
    for (const path of plugin.requiredSeedPaths) {
      if (!plugin.requiredRuntimePaths.includes(path)) await access(new URL(path, root));
    }
  }
  assert.ok(names.has("node-repl-host"));
  assert.ok(names.has("zcode-cua-plugin"));
});

test("staging fails if any required asset is missing, including the shared host and office executors", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zcodium-builtin-assets-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const plugin of BUILTIN_PLUGIN_ASSETS) {
    for (const path of [".zcodium-plugin/plugin.json", ...plugin.requiredSeedPaths]) {
      const file = join(directory, plugin.directory, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, "fixture");
    }
  }
  for (const path of cuaRuntimeRequiredPaths(process.platform, process.arch)) {
    const file = join(directory, "node-repl-host", path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "fixture");
  }
  await validateBuiltinPluginAssets(directory);
  for (const path of [
    "node-repl-host/dist/mcp/server.js",
    `node-repl-host/${cuaRuntimeRequiredPaths(process.platform, process.arch).at(-2)}`,
    "zcode-cua-plugin/scripts/computer-use-target.mjs",
    "documents-plugin/skills/docx/scripts/document.py",
    // 换上游实现后 pdf 技能的关键脚本名变了（`pdf_qa_checks.py` → `pdf_qa.py`）；
    // 这里必须点一个 seed 清单里真实存在的文件，否则失败信息变成 ENOENT 而不是缺资产。
    "pdf-plugin/skills/pdf/scripts/pdf_qa.py",
  ]) {
    const file = join(directory, path);
    await rm(file);
    await assert.rejects(validateBuiltinPluginAssets(directory), /Missing builtin plugin asset/);
    await writeFile(file, "fixture");
  }
});

/** 静态解析技能脚本里的相对 require/import 说明符（只认静态字符串）。 */
function collectLocalModuleSpecifiers(source) {
  const specifiers = new Set();
  const patterns = [
    /require\(\s*["'](\.[^"']*)["']\s*\)/g,
    /(?:^|\n)\s*import\s[^;]*?from\s+["'](\.[^"']*)["']/g,
    /\bimport\(\s*["'](\.[^"']*)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  }
  return specifiers;
}

test("skill scripts keep their local dependencies inside the required seed paths", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const { posix } = await import("node:path");
  const collect = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      const path = posix.join(directory, entry.name);
      if (entry.isDirectory()) files.push(...(await collect(path)));
      else files.push(path);
    }
    return files;
  };

  let checked = 0;
  for (const plugin of BUILTIN_PLUGIN_ASSETS) {
    if (!plugin.requiredSeedPaths.some((path) => path.startsWith("skills/"))) continue;
    const required = new Set(plugin.requiredSeedPaths);
    const root = new URL(`../../apps/zcode-cli/packages/${plugin.directory}/`, import.meta.url);
    const skillsRoot = new URL("skills/", root);
    let files = [];
    try {
      files = await collect(skillsRoot.pathname);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const file of files) {
      if (!/\.(?:js|mjs|cjs)$/.test(file) || /\.test\./u.test(file)) continue;
      const relativeFile = posix.relative(new URL(root).pathname, file);
      const source = await readFile(file, "utf8");
      for (const specifier of collectLocalModuleSpecifiers(source)) {
        const target = posix.normalize(
          posix.join(posix.dirname(relativeFile), specifier.replace(/\.js$/u, "")),
        );
        const candidates = [`${target}.js`, `${target}.mjs`, `${target}.cjs`, target];
        const declared = candidates.find((candidate) => required.has(candidate));
        assert.ok(
          declared,
          `${relativeFile} depends on ${specifier}, but ${candidates.join(" / ")} is missing from requiredSeedPaths (staged plugin would break at runtime)`,
        );
        checked += 1;
      }
    }
  }
  assert.ok(checked > 0, "expected to scan at least one skill script dependency");
});
