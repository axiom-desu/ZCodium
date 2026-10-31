import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

test("office viewer plugins share one runtime closure across seed, SEA, desktop and remote", async () => {
  const { OFFICE_VIEWER_RUNTIME_PATHS } =
    await import("../../packages/shared/src/builtinPluginAssets.ts");
  const { OFFICE_RUNTIME_OUTPUTS } =
    await import("../../apps/zcode-cli/packages/office-runtime/contract.ts");
  const { officialSeaPlugins } =
    await import("../../apps/zcode-cli/packages/cli/scripts/sea-official-plugin-assets.mjs");
  // 产物路径唯一定义在 office-runtime contract；其它三处只能引用同一份清单。
  assert.deepEqual([...OFFICE_VIEWER_RUNTIME_PATHS], [...OFFICE_RUNTIME_OUTPUTS]);
  const office = ["documents", "pdf", "presentations", "spreadsheets"];
  const versions = {
    documents: "0.2.0",
    pdf: "0.2.1",
    presentations: "0.2.0",
    spreadsheets: "0.2.0",
  };
  for (const name of office) {
    const plugin = BUILTIN_PLUGIN_ASSETS.find((item) => item.directory === `${name}-plugin`);
    assert.ok(plugin, `${name} is staged`);
    assert.equal(plugin.requiresRuntime, true, `${name} needs its built panel`);
    assert.equal(plugin.runtimeBuildScript, "../office-runtime/scripts/build.mjs");
    assert.ok(
      plugin.requiredSeedPaths.includes(
        `skills/${name === "documents" ? "docx" : name === "spreadsheets" ? "xlsx" : name === "presentations" ? "pptx" : "pdf"}-viewer/SKILL.md`,
      ),
    );
    for (const path of OFFICE_VIEWER_RUNTIME_PATHS)
      assert.ok(plugin.requiredSeedPaths.includes(path), `${name} seeds ${path}`);
    // 自包含 staging：只允许插件根下白名单资产，绝不携带 node_modules 或 fixtures。
    for (const path of plugin.requiredSeedPaths) {
      assert.ok(!path.includes("node_modules"), `${name} must not stage node_modules`);
      assert.ok(!path.startsWith("fixtures"), `${name} must not stage fixtures`);
      const top = path.split("/")[0];
      assert.ok(
        ["agents", "dist", "skills"].includes(top),
        `${name} stages unexpected top-level path: ${path}`,
      );
    }
    const sea = officialSeaPlugins.find((item) => item.name === name);
    assert.ok(sea, `${name} is embedded in SEA`);
    assert.deepEqual(sea.requiredRuntimePaths, [...OFFICE_VIEWER_RUNTIME_PATHS]);
    assert.equal(sea.version, versions[name]);
  }
});

test("office filesystem validation is asynchronous with one validator owner", async () => {
  const source = await readFile(
    new URL("../../packages/shared/src/officeViewerAssetsNode.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /\b(?:readFileSync|statSync|existsSync|validateOfficeViewerRuntimeAssetsSync)\b/u,
  );
  assert.match(source, /from "node:fs\/promises"/u);
  const { validateStagedOfficeViewerAssets } =
    await import("../../packages/shared/src/officeViewerAssetsNode.ts");
  const directory = await mkdtemp(join(tmpdir(), "office-profile-missing-"));
  try {
    await mkdir(join(directory, "dist/ui"), { recursive: true });
    await writeFile(join(directory, "dist/ui/assets.json"), "{}");
    const validation = validateStagedOfficeViewerAssets(directory);
    assert.ok(validation instanceof Promise);
    await assert.rejects(validation, /missing its office profile kinds/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("office viewer manifest fails closed on every resource, not just the entry files", async (t) => {
  const { createHash } = await import("node:crypto");
  const { validateOfficeViewerRuntimeAssets } =
    await import("../../packages/shared/src/officeViewerAssetsNode.ts");
  const directory = await mkdtemp(join(tmpdir(), "office-viewer-assets-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = new Map([
    ["dist/server.mjs", "// server\n"],
    ["dist/THIRD_PARTY_NOTICES.txt", "notices\n"],
    ["dist/LICENSE", "license\n"],
    ["dist/ui/panel.html", "<html></html>\n"],
    ["dist/ui/panel.css", "body{}\n"],
    ["dist/ui/bundle-0.txt", "bundle\n"],
    ["dist/ui/cjk-fallback.json", '{"faces":[]}\n'],
    ["dist/ui/pdf-worker.js", "// worker\n"],
    ["dist/ui/pdfjs/cmaps/UniGB-UCS2-H.bcmap", "cmap\n"],
    ["dist/ui/pdfjs/standard_fonts/FoxitSans.pfb", "font\n"],
    ["dist/ui/pdfjs/wasm/openjpeg.wasm", "wasm\n"],
  ]);
  for (let index = 0; index < 97; index += 1)
    files.set(`dist/ui/fonts/noto-sans-sc-${index}-400-normal.woff2`, `slice-${index}\n`);
  const writeManifest = async () => {
    await writeFile(
      join(directory, "dist/ui/assets.json"),
      JSON.stringify({
        scripts: ["bundle-0.txt"],
        scriptBytes: Buffer.byteLength(files.get("dist/ui/bundle-0.txt")),
        files: [...files.entries()].map(([path, value]) => ({
          path,
          bytes: Buffer.byteLength(value),
          sha256: createHash("sha256").update(value).digest("hex"),
        })),
      }),
    );
  };
  for (const [path, value] of files) {
    const file = join(directory, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, value);
  }
  await writeManifest();
  await validateOfficeViewerRuntimeAssets(directory, ["pdf"]);

  // 删除任一非入口资源（字体/worker/wasm/NOTICE）都必须失败。
  for (const missing of [
    "dist/ui/fonts/noto-sans-sc-0-400-normal.woff2",
    "dist/ui/pdfjs/wasm/openjpeg.wasm",
    "dist/ui/pdf-worker.js",
    "dist/THIRD_PARTY_NOTICES.txt",
  ]) {
    const file = join(directory, missing);
    const original = files.get(missing);
    await rm(file);
    files.delete(missing);
    await writeManifest();
    await assert.rejects(
      validateOfficeViewerRuntimeAssets(directory, ["pdf"]),
      /missing required asset|asset is missing|font slices/u,
    );
    files.set(missing, original);
    await writeFile(file, original);
  }
  await writeManifest();

  // 篡改大小/哈希与越界路径同样拒绝（manifest 不能自证）。
  const tampered = JSON.parse(await readFile(join(directory, "dist/ui/assets.json"), "utf8"));
  tampered.files[0].bytes += 1;
  await writeFile(join(directory, "dist/ui/assets.json"), JSON.stringify(tampered));
  await assert.rejects(validateOfficeViewerRuntimeAssets(directory, ["pdf"]), /size mismatch/u);
  tampered.files[0].bytes -= 1;
  tampered.files[0].sha256 = "0".repeat(64);
  await writeFile(join(directory, "dist/ui/assets.json"), JSON.stringify(tampered));
  await assert.rejects(validateOfficeViewerRuntimeAssets(directory, ["pdf"]), /hash mismatch/u);
  tampered.files[0].path = "../escape.txt";
  await writeFile(join(directory, "dist/ui/assets.json"), JSON.stringify(tampered));
  await assert.rejects(
    validateOfficeViewerRuntimeAssets(directory, ["pdf"]),
    /Unsafe office viewer asset path/u,
  );
});

test("real checkout office seed closure is complete instead of silently skipped without dist", async () => {
  const { tsImport } = await import("tsx/esm/api");
  const { resolveSeedSource } = await tsImport(
    "../../apps/zcode-cli/packages/bootstrap/src/app/bundled-plugin-seed-source.ts",
    import.meta.url,
  );
  const { validateStagedOfficeViewerAssets } = await tsImport(
    "../../packages/shared/src/officeViewerAssetsNode.ts",
    import.meta.url,
  );
  const source = await resolveSeedSource({ baseDirs: [resolve("apps/zcode-cli")] });
  assert.ok(source, "the dev seed source must resolve from the real checkout");
  for (const name of ["documents", "pdf", "presentations", "spreadsheets"]) {
    const plugin = source.plugins.find((entry) => entry.definition.name === name);
    assert.ok(plugin, `${name} must be seeded from the real checkout`);
    // fresh checkout 没有 dist 不是通过条件：清单为空说明没构建，必须明确失败并给出
    // 真实构建命令，而不是把「没有产物所以跳过」当成通过。
    assert.deepEqual(
      plugin.missingSeedPaths,
      [],
      `${name}-plugin 缺少构建产物；先执行 pnpm --filter @zcode/${name}-plugin build`,
    );
    // 对真实产物跑 seed 在 promote 前用的同一份 office 闭包：字体 97 片/worker/wasm/NOTICE 哈希。
    await validateStagedOfficeViewerAssets(plugin.rootPath);
  }
});
