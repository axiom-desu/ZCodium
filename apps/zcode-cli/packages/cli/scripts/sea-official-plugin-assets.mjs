import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export const seaOfficialPluginAssetPrefix = "zcode-official-plugins/";
export const seaOfficialPluginManifestAssetKey = `${seaOfficialPluginAssetPrefix}manifest.json`;
const browserUseRequiredRuntimePaths = [
  "scripts/browser-client.mjs",
  "docs/api.json",
  "docs/documents.json",
  "docs/overview.md",
  // recording lookup 是录屏 API 的模型入口，SEA 不得接受缺失正文的插件资产。
  "docs/recording.md",
  "docs/workflow.md",
  "skills/control-browser/SKILL.md",
  "skills/web-gui-tester/SKILL.md",
];

export const officialSeaPlugins = [
  {
    marketplace: "zcode-plugins-official",
    name: "visualize",
    packageName: "@zcode/visualize-plugin",
    requiresRuntime: false,
    requiredSeedPaths: [
      "skills/visualize/SKILL.md",
      "skills/visualize/references/api.md",
      "skills/visualize/references/styles.md",
      "skills/visualize/tweak.md",
      "skills/visualize/LICENSE.md",
      "skills/visualize/scripts/render.py",
      "skills/visualize/assets/visualize.css",
      "skills/visualize/assets/visualize.html",
      "skills/visualize/assets/calendar.js",
      "skills/visualize/assets/runtime-manifest.json",
      "skills/visualize/scripts/vendor.py",
      "skills/visualize/assets/vendor/manifest.json",
      "skills/visualize/assets/vendor/floating-ui-core-1.7.3.min.js",
      "skills/visualize/assets/vendor/floating-ui-core-1.7.3.min.js.LICENSE",
      "skills/visualize/assets/vendor/floating-ui-dom-1.7.4.min.js",
      "skills/visualize/assets/vendor/floating-ui-dom-1.7.4.min.js.LICENSE",
      "skills/visualize/assets/vendor/lucide-1.17.0.js",
      "skills/visualize/assets/vendor/lucide-1.17.0.js.LICENSE",
      "skills/visualize/assets/vendor/d3-7.9.0.min.js",
      "skills/visualize/assets/vendor/d3-7.9.0.min.js.LICENSE",
      "skills/visualize/widgets/calendar.md",
      "skills/visualize/examples/calendar.html",
      "skills/visualize/assets/standalone-host-bridge.js",
      "skills/visualize/assets/standalone-shell.js",
    ],
    rootPath: join("packages", "visualize-plugin"),
    version: "0.1.0",
  },
  {
    // node_repl 宿主：Browser Use 与 Computer Use 共用的运行时产物，自己不是面向用户的插件
    // （无 skill、无市场 listing）。它必须始终随发布物嵌入，否则任一能力启用时都没有宿主可跑。
    marketplace: "zcode-plugins-official",
    name: "node-repl-host",
    packageName: "@zcode/node-repl-host",
    requiresRuntime: true,
    requiredRuntimePaths: ["dist/mcp/server.js"],
    rootPath: join("packages", "node-repl-host"),
    version: "0.6.0",
  },
  {
    marketplace: "zcode-plugins-official",
    name: "browser-use",
    packageName: "@zcode/browser-use-plugin",
    requiresRuntime: true,
    // Browser Use 的 runtime、client、API 文档和 skills 是同一发布单元；
    // SEA 构建必须在嵌入前拒绝任一缺失项，不能把损坏产物留到用户启动时才发现。
    requiredRuntimePaths: browserUseRequiredRuntimePaths,
    rootPath: join("packages", "browser-use-plugin"),
    // SEA 清单仍指向旧版时，runtime 会与官方 definition 精确匹配失败，
    // 导致发布产物不 seed browser-use，进而无法装配宿主 node_repl MCP。
    version: "0.5.1",
  },
];

export const collectSeaOfficialPluginAssets = async ({
  requireRuntime = false,
  root,
  stagingDirectory,
} = {}) => {
  const files = [];
  const assets = {};
  const plugins = [];

  await rm(stagingDirectory, {
    force: true,
    recursive: true,
  });

  for (const plugin of officialSeaPlugins) {
    const pluginRoot = resolve(root, plugin.rootPath);
    assertPluginRoot(pluginRoot, plugin);
    assertPluginRequiredSeedAssets(pluginRoot, plugin);
    // 只提供 skills 的内容型插件没有 MCP server，用 requiresRuntime:false 跳过校验；
    // 其余运行时插件仍要在此校验，避免发布缺失可执行入口的产物。
    if (requireRuntime && plugin.requiresRuntime !== false) assertPluginRuntime(pluginRoot, plugin);

    const pluginFiles = [];
    for await (const sourcePath of walkFiles(pluginRoot)) {
      const relativePath = relative(pluginRoot, sourcePath);
      if (!shouldIncludePluginFile(relativePath)) continue;

      const bytes = await readFile(sourcePath);
      const sourceStats = await stat(sourcePath);
      const assetPath = toPosixPath(
        join(plugin.marketplace, plugin.name, plugin.version, relativePath),
      );
      assets[`${seaOfficialPluginAssetPrefix}${assetPath}`] = sourcePath;
      const file = {
        mode: modeForSeedFile(relativePath, sourceStats.mode),
        path: toPosixPath(relativePath),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
      pluginFiles.push(file);
      files.push({
        ...file,
        plugin: plugin.name,
      });
    }

    pluginFiles.sort((left, right) => left.path.localeCompare(right.path));
    plugins.push({
      files: pluginFiles,
      marketplace: plugin.marketplace,
      name: plugin.name,
      version: plugin.version,
    });
  }

  plugins.sort((left, right) => left.name.localeCompare(right.name));
  const manifestHash = createHash("sha256")
    .update(
      JSON.stringify(
        plugins.map((plugin) => [
          plugin.marketplace,
          plugin.name,
          plugin.version,
          plugin.files.map(({ path, sha256, mode }) => [path, sha256, modeForSeedFile(path, mode)]),
        ]),
      ),
    )
    .digest("hex");
  const manifest = {
    hash: manifestHash,
    plugins,
    version: 1,
  };
  const manifestPath = resolve(stagingDirectory, "official-plugins-manifest.json");
  await mkdir(stagingDirectory, {
    recursive: true,
  });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  assets[seaOfficialPluginManifestAssetKey] = manifestPath;

  return {
    assets,
    manifest,
  };
};

function assertPluginRoot(pluginRoot, plugin) {
  if (!existsSync(join(pluginRoot, ".zcodium-plugin", "plugin.json"))) {
    throw new Error(`Missing ${plugin.name} plugin manifest at ${pluginRoot}`);
  }
}

function assertPluginRequiredSeedAssets(pluginRoot, plugin) {
  for (const relativePath of plugin.requiredSeedPaths ?? []) {
    const assetPath = join(pluginRoot, ...relativePath.split("/"));
    if (!existsSync(assetPath)) {
      throw new Error(`Missing ${plugin.name} required seed asset at ${assetPath}`);
    }
  }
}

function assertPluginRuntime(pluginRoot, plugin) {
  for (const relativePath of plugin.requiredRuntimePaths ?? ["dist/mcp/server.js"]) {
    const runtimePath = join(pluginRoot, ...relativePath.split("/"));
    if (!existsSync(runtimePath)) {
      const assetKind = relativePath === "dist/mcp/server.js" ? "MCP runtime" : "runtime asset";
      throw new Error(
        `Missing ${plugin.name} ${assetKind} at ${runtimePath}. ` +
          `Run \`pnpm --filter ${plugin.packageName} build\` before \`pnpm sea\`.`,
      );
    }
  }
}

async function* walkFiles(directory) {
  const entries = await readdir(directory, {
    withFileTypes: true,
  });

  for (const entry of entries) {
    if (shouldSkipDirectory(entry.name)) continue;
    const fullPath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(fullPath);
      continue;
    }
    if (entry.isFile()) {
      yield fullPath;
    }
  }
}

const shouldSkipDirectory = (name) =>
  name === "node_modules" ||
  name === ".turbo" ||
  name === "coverage" ||
  name === ".venv" ||
  name === "__pycache__";

const includedTopLevelPaths = new Set([
  ".mcp.json",
  ".zcodium-plugin",
  "README.md",
  // SEA 资源采集曾只允许 skills/commands，导致 document-skills 的 judge 子代理未进入可执行文件。
  "agents",
  "commands",
  "dist",
  "docs",
  "hooks",
  "output-styles",
  "package.json",
  "scripts",
  "skills",
  "templates",
]);

const shouldIncludePluginFile = (relativePath) => {
  const segments = relativePath.split(sep);
  if (segments.includes(".DS_Store") || segments.some((segment) => segment.endsWith(".pyc"))) {
    return false;
  }
  const [topLevel] = relativePath.split(sep);
  return topLevel !== undefined && includedTopLevelPaths.has(topLevel);
};

const toPosixPath = (value) => value.split(sep).join("/");

const modeForSeedFile = (filePath, sourceMode) => {
  if (sourceMode !== undefined && (sourceMode & 0o111) !== 0) return 0o755;

  const normalizedPath = toPosixPath(filePath);
  if (/(?:^|\/)dist\/mcp\/server\.js$/i.test(normalizedPath)) return 0o755;
  if (/^hooks\//u.test(normalizedPath) && !/\.(json|md|txt)$/iu.test(normalizedPath)) {
    return 0o755;
  }

  return 0o644;
};
