import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { Logger } from "@zcode/contracts";
import {
  OFFICIAL_PLUGIN_DEFINITIONS,
  type OfficialPluginDefinition,
} from "../src/app/official-plugin-definitions.js";
import { officialPluginCacheRoot } from "../src/app/bundled-plugin-seed-cache.js";
import {
  SEED_MARKER_FILE,
  resolveSeedSource,
  resolveSeaSeedSourceFromManifest,
  type OfficialPluginSeedFile,
  type OfficialPluginSeedSource,
  seaSeedAssetKey,
} from "../src/app/bundled-plugin-seed-source.js";
import { resolveOfficialPluginRoots } from "../src/app/bundled-plugins.js";

/** 四个文档插件里的 pdf 面板资源闭包最全：97 片字体 + pdfjs 目录 + worker + wasm + NOTICE。 */
const pdfDefinition = OFFICIAL_PLUGIN_DEFINITIONS.find((entry) => entry.name === "pdf")!;
const MARKETPLACE = "zcode-plugins-official";
const FONT_SLICE = "dist/ui/fonts/noto-sans-sc-0-400-normal.woff2";

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** 真实形状的 pdf 面板产物：入口 + 字体 97 片 + worker/wasm/cmaps + NOTICE/LICENSE。 */
function officePanelFiles(): Map<string, string> {
  const files = new Map<string, string>([
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
  for (let index = 0; index < 97; index += 1) {
    files.set(`dist/ui/fonts/noto-sans-sc-${index}-400-normal.woff2`, `slice-${index}\n`);
  }
  return files;
}

function buildManifest(
  files: Map<string, string>,
  mutate?: (manifest: {
    scripts: string[];
    scriptBytes: number;
    files: Array<{ path: string; bytes: number; sha256: string }>;
  }) => void,
): string {
  const manifest = {
    scripts: ["bundle-0.txt"],
    scriptBytes: Buffer.byteLength(files.get("dist/ui/bundle-0.txt") ?? ""),
    files: [...files].map(([path, value]) => ({
      path,
      bytes: Buffer.byteLength(value),
      sha256: sha256(value),
    })),
  };
  mutate?.(manifest);
  return JSON.stringify(manifest);
}

async function write(root: string, relativePath: string, content: string): Promise<void> {
  const target = join(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

/** 写一份真实 dev checkout 布局：`packages/pdf-plugin/...`（含全部 requiredSeedPaths）。 */
async function writeCheckout(
  root: string,
  files: Map<string, string>,
  manifest = buildManifest(files),
  definition: OfficialPluginDefinition = pdfDefinition,
): Promise<void> {
  const pluginRoot = join(root, "packages", `${definition.name}-plugin`);
  await write(
    pluginRoot,
    "package.json",
    `${JSON.stringify({ name: `@zcode/${definition.name}-plugin`, office: { kinds: ["pdf"] } })}\n`,
  );
  await write(
    pluginRoot,
    ".zcodium-plugin/plugin.json",
    `${JSON.stringify({ name: definition.name, version: definition.version })}\n`,
  );
  for (const requiredPath of definition.requiredSeedPaths ?? []) {
    if (!files.has(requiredPath))
      await write(pluginRoot, requiredPath, `fixture:${requiredPath}\n`);
  }
  for (const [path, content] of files) await write(pluginRoot, path, content);
  // manifest 本身不能出现在自己的文件清单里（内容写入后还会变）。
  await write(pluginRoot, "dist/ui/assets.json", manifest);
}

function collectorLogger(): { events: Array<[string, Record<string, unknown>]>; logger: Logger } {
  const events: Array<[string, Record<string, unknown>]> = [];
  const logger: Logger = {
    child: () => logger,
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
    warn: (message, context) => events.push([message, (context ?? {}) as Record<string, unknown>]),
  };
  return { events, logger };
}

async function tempRoot(name: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `zcode-seed-closure-${name}-`));
}

async function cacheSnapshot(cacheRoot: string): Promise<string[]> {
  const entries: string[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(join(directory, entry.name), relativePath);
        continue;
      }
      const info = await stat(join(directory, entry.name));
      entries.push(`${relativePath}:${info.size}`);
    }
  };
  await walk(cacheRoot, "");
  return entries.sort();
}

/** SEA 变体：与构建期一致的 manifest 形状 + 生产一致的资产键。 */
function buildSeaSource(
  files: Map<string, Buffer>,
  options: { omitAssetPaths?: Set<string>; omitFromFileList?: Set<string> } = {},
): OfficialPluginSeedSource {
  // 生产 SEA 的 file list 是插件根下 `walkFiles` 的相对路径全集，读取器按资产键
  // （`zcode-official-plugins/<marketplace>/<name>/<version>/<path>`）取字节；两者分开
  // 才能分别验“清单缺项”与“内嵌资产缺字”。
  const pluginFiles: OfficialPluginSeedFile[] = [];
  for (const [path, bytes] of files) {
    if (options.omitFromFileList?.has(path)) continue;
    pluginFiles.push({ mode: 0o644, path, sha256: sha256(bytes) });
  }
  pluginFiles.sort((left, right) => left.path.localeCompare(right.path));
  const manifest = {
    hash: "fixture-sea-hash",
    plugins: [
      { files: pluginFiles, marketplace: MARKETPLACE, name: "pdf", version: pdfDefinition.version },
    ],
    version: 1,
  };
  const prefix = `${seaSeedAssetKey(pdfDefinition, { path: "" })}`;
  const source = resolveSeaSeedSourceFromManifest(manifest, (assetKey) => {
    assert.ok(assetKey.startsWith(prefix), `unexpected SEA asset key: ${assetKey}`);
    const path = assetKey.slice(prefix.length);
    if (options.omitAssetPaths?.has(path)) throw new Error(`missing SEA asset: ${assetKey}`);
    const asset = files.get(path);
    if (!asset) throw new Error(`missing SEA asset: ${assetKey}`);
    return asset;
  });
  assert.ok(source, "the SEA fixture must resolve the pdf seed source");
  return source;
}

/** SEA 内嵌资产表（插件根相对路径）：skills/manifest/panel 产物 + 构建 manifest。 */
function seaAssetsFromPanelFiles(
  files: Map<string, string>,
  manifest = buildManifest(files),
): Map<string, Buffer> {
  const assets = new Map<string, Buffer>();
  const add = (path: string, content: string): void => {
    assets.set(path, Buffer.from(content));
  };
  add(
    "package.json",
    `${JSON.stringify({ name: "@zcode/pdf-plugin", office: { kinds: ["pdf"] } })}\n`,
  );
  add(
    ".zcodium-plugin/plugin.json",
    `${JSON.stringify({ name: pdfDefinition.name, version: pdfDefinition.version })}\n`,
  );
  for (const requiredPath of pdfDefinition.requiredSeedPaths ?? []) {
    if (!files.has(requiredPath)) add(requiredPath, `fixture:${requiredPath}\n`);
  }
  for (const [path, content] of files) add(path, content);
  add("dist/ui/assets.json", manifest);
  return assets;
}

async function seedOnce(input: {
  baseDirs?: string[];
  seedSource?: OfficialPluginSeedSource;
  storageRoot: string;
}) {
  const { events, logger } = collectorLogger();
  const roots = await resolveOfficialPluginRoots({ ...input, logger });
  return { events, roots };
}

function degradedReason(events: Array<[string, Record<string, unknown>]>): string {
  const degraded = events.filter(
    ([message]) => message === "Official plugin cache operation degraded",
  );
  assert.equal(degraded.length, 1, JSON.stringify(events));
  const details = degraded[0]![1];
  assert.equal(details.errorCode, "ZCODE_PLUGIN_SEED_INCOMPLETE");
  assert.equal(details.degraded, true);
  return String(details.reason ?? "");
}

test("filesystem dev seed validates the whole office closure before activating the cache", async (t) => {
  const root = await tempRoot("dev");
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, "checkout");
  const storageRoot = join(root, "storage");
  await writeCheckout(checkout, officePanelFiles());

  const source = await resolveSeedSource({ baseDirs: [checkout] });
  const plugin = source?.plugins.find((entry) => entry.definition.name === "pdf");
  assert.ok(plugin, "the dev checkout must resolve the pdf seed");
  assert.deepEqual(plugin.missingSeedPaths, []);

  await seedOnce({ baseDirs: [checkout], storageRoot });
  const cacheRoot = officialPluginCacheRoot(storageRoot, pdfDefinition);
  await stat(join(cacheRoot, SEED_MARKER_FILE));
  assert.equal((await readdir(join(cacheRoot, "dist/ui/fonts"))).length, 97);
  const healthySnapshot = await cacheSnapshot(cacheRoot);

  // 删除一片字体：必须拒绝激活半成品，旧缓存与其它进程的 staging 都不受影响。
  await rm(join(checkout, "packages/pdf-plugin", FONT_SLICE));
  const staging = join(checkout, "packages/pdf-plugin/dist/ui/pdf-worker.js");
  await stat(staging);
  const foreignStaging = `${cacheRoot}.tmp-999999-1`;
  await mkdir(foreignStaging, { recursive: true });
  t.after(() => rm(foreignStaging, { recursive: true, force: true }));

  const failed = await seedOnce({ baseDirs: [checkout], storageRoot });
  assert.match(degradedReason(failed.events), /asset is missing/u);
  assert.deepEqual(await cacheSnapshot(cacheRoot), healthySnapshot);
  // 只清理本次 staging：外部 pid 的目录保留，本次自己的 *.tmp-<pid>-* 不残留。
  await stat(foreignStaging);
  const versionRoot = dirname(cacheRoot);
  const leftovers = (await readdir(versionRoot)).filter(
    (entry) =>
      entry.includes(".tmp-") && !entry.startsWith(`${pdfDefinition.version}.tmp-999999-1`),
  );
  assert.deepEqual(leftovers, []);

  // 缓存里的字体被删掉同样不能继续当可用缓存：下一次 seed 必须重建。
  await rm(join(cacheRoot, FONT_SLICE));
  await write(join(checkout, "packages/pdf-plugin"), FONT_SLICE, "slice-0\n");
  await seedOnce({ baseDirs: [checkout], storageRoot });
  assert.equal((await readdir(join(cacheRoot, "dist/ui/fonts"))).length, 97);
  // 同大小篡改不能只凭 marker/size 复用；必须 await 同一份哈希校验后重建。
  await write(cacheRoot, FONT_SLICE, "sl1ce-0\n");
  const repaired = await seedOnce({ baseDirs: [checkout], storageRoot });
  assert.deepEqual(repaired.events, []);
  assert.equal(await readFile(join(cacheRoot, FONT_SLICE), "utf8"), "slice-0\n");
  assert.deepEqual(await cacheSnapshot(cacheRoot), healthySnapshot);
});

test("filesystem dev seed fails closed on deleted worker, tampered bytes and unsafe paths", async () => {
  const cases: Array<{
    name: string;
    expected: RegExp;
    mutate: (checkout: string, files: Map<string, string>) => Promise<void>;
  }> = [
    {
      expected: /asset is missing/u,
      name: "deleted pdf worker",
      async mutate(checkout) {
        await rm(join(checkout, "packages/pdf-plugin/dist/ui/pdf-worker.js"));
      },
    },
    {
      expected: /size mismatch|hash mismatch/u,
      name: "tampered font bytes",
      async mutate(checkout) {
        await write(join(checkout, "packages/pdf-plugin"), FONT_SLICE, "sl1ce-0\n");
      },
    },
    {
      // NOTICE 同时是 requiredSeedPaths 与 manifest 条目：缺它在两端都 fail closed，
      // 这里走的是入口清单那一层（字体/worker/wasm 只由闭包覆盖）。
      expected: /missing required seed assets/u,
      name: "deleted third-party notices",
      async mutate(checkout) {
        await rm(join(checkout, "packages/pdf-plugin/dist/THIRD_PARTY_NOTICES.txt"));
      },
    },
    {
      expected: /Unsafe office viewer asset path/u,
      name: "path traversal manifest entry",
      async mutate(checkout, files) {
        await write(
          join(checkout, "packages/pdf-plugin"),
          "dist/ui/assets.json",
          buildManifest(files, (manifest) => {
            manifest.files[0]!.path = "../escape.txt";
          }),
        );
      },
    },
  ];

  for (const testCase of cases) {
    const root = await tempRoot("fail");
    try {
      const checkout = join(root, "checkout");
      const storageRoot = join(root, "storage");
      await writeCheckout(checkout, officePanelFiles());
      await testCase.mutate(checkout, officePanelFiles());
      const failed = await seedOnce({ baseDirs: [checkout], storageRoot });
      assert.match(degradedReason(failed.events), testCase.expected, testCase.name);
      // 从未激活过缓存：不能留下目录或半成品 staging。
      await assert.rejects(stat(officialPluginCacheRoot(storageRoot, pdfDefinition)), {
        code: "ENOENT",
      });
      const versionParent = dirname(officialPluginCacheRoot(storageRoot, pdfDefinition));
      const versionEntries = await readdir(versionParent).catch(() => [] as string[]);
      assert.deepEqual(
        versionEntries.filter((entry) => entry.includes(".tmp-")),
        [],
        testCase.name,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("SEA seed validates the same closure after extract, before cache activation", async (t) => {
  const root = await tempRoot("sea");
  t.after(() => rm(root, { recursive: true, force: true }));
  const storageRoot = join(root, "storage");

  await seedOnce({
    seedSource: buildSeaSource(seaAssetsFromPanelFiles(officePanelFiles())),
    storageRoot,
  });
  const cacheRoot = officialPluginCacheRoot(storageRoot, pdfDefinition);
  assert.equal((await readdir(join(cacheRoot, "dist/ui/fonts"))).length, 97);
  const healthySnapshot = await cacheSnapshot(cacheRoot);

  // 删掉清单里的一片字体（assets.json 仍然声明它）：闭包校验必须拒绝。
  const missingFont = buildSeaSource(seaAssetsFromPanelFiles(officePanelFiles()), {
    omitFromFileList: new Set([FONT_SLICE]),
  });
  const missingFailure = await seedOnce({ seedSource: missingFont, storageRoot });
  assert.match(degradedReason(missingFailure.events), /asset is missing/u);
  assert.deepEqual(await cacheSnapshot(cacheRoot), healthySnapshot);

  // 内嵌资产字节被篡改：写入 staging 时的哈希校验必须拒绝，旧缓存保留。
  const tampered = seaAssetsFromPanelFiles(officePanelFiles());
  tampered.set(FONT_SLICE, Buffer.from("sl1ce-0\n"));
  const tamperedFailure = await seedOnce({ seedSource: buildSeaSource(tampered), storageRoot });
  assert.match(degradedReason(tamperedFailure.events), /hash mismatch/u);
  assert.deepEqual(await cacheSnapshot(cacheRoot), healthySnapshot);

  // 资产键整体缺失（清单仍声明）：读取失败也按 seed 不完整降级，而不是把启动炸掉。
  // 用独立 storage：已经 current 的缓存会走复用分支、不会重读资产，那一支已由前面的
  // 哈希篡改用例覆盖；这里要证明的是「首次激活前的读取失败」不会产生缓存。
  const absentStorageRoot = join(root, "storage-absent-asset");
  const absentFailure = await seedOnce({
    seedSource: buildSeaSource(seaAssetsFromPanelFiles(officePanelFiles()), {
      omitAssetPaths: new Set(["dist/ui/pdfjs/wasm/openjpeg.wasm"]),
    }),
    storageRoot: absentStorageRoot,
  });
  assert.match(degradedReason(absentFailure.events), /missing SEA asset/u);
  await assert.rejects(stat(officialPluginCacheRoot(absentStorageRoot, pdfDefinition)), {
    code: "ENOENT",
  });

  // 删除 SEA 文件清单里的 NOTICE：入口清单那一层就拒绝，缓存不动。
  const noticeFailure = await seedOnce({
    seedSource: buildSeaSource(seaAssetsFromPanelFiles(officePanelFiles()), {
      omitFromFileList: new Set(["dist/THIRD_PARTY_NOTICES.txt"]),
    }),
    storageRoot,
  });
  assert.match(degradedReason(noticeFailure.events), /missing required seed assets/u);
  assert.deepEqual(await cacheSnapshot(cacheRoot), healthySnapshot);

  // 篡改 SEA 里的 assets.json 路径：闭包校验在 promote 前拒绝。
  const traversalAssets = seaAssetsFromPanelFiles(
    officePanelFiles(),
    buildManifest(officePanelFiles(), (manifest) => {
      manifest.files[0]!.path = "../escape.txt";
    }),
  );
  const traversalFailure = await seedOnce({
    seedSource: buildSeaSource(traversalAssets),
    storageRoot,
  });
  assert.match(degradedReason(traversalFailure.events), /Unsafe office viewer asset path/u);
  assert.deepEqual(await cacheSnapshot(cacheRoot), healthySnapshot);
});
