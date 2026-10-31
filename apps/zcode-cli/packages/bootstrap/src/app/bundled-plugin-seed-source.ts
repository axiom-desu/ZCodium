import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@zcode/contracts";
import { candidateBaseDirs } from "./bundled-plugins.js";
import {
  OFFICIAL_PLUGIN_DEFINITIONS,
  type OfficialPluginDefinition,
} from "./official-plugin-definitions.js";
import { walkPluginSeedFiles, shouldIncludePluginSeedFile } from "./plugin-seed-files.js";

export const OFFICIAL_PLUGIN_MARKETPLACE = ZCODE_OFFICIAL_PLUGIN_MARKETPLACE;
const SEA_PLUGIN_ASSET_PREFIX = "zcode-official-plugins/";
const SEA_PLUGIN_MANIFEST_ASSET_KEY = `${SEA_PLUGIN_ASSET_PREFIX}manifest.json`;
export const SEED_MARKER_FILE = ".zcodium-plugin-seed.json";

const includedTopLevelPaths = new Set([
  ".mcp.json",
  ".zcodium-plugin",
  "README.md",
  // MIT/BSD 派生内容的署名义务：NOTICE.md 记录来源、许可与 delta，必须随插件
  // 一起 seed 到 cache，否则分发物里只有派生内容而没有归属声明。
  "NOTICE.md",
  // 同理，vendor 进插件的第三方 LICENSE 文本（如 superpowers 的 MIT 全文）必须
  // 随包分发——MIT 的义务就是版权声明与许可声明跟内容一起走。
  "LICENSE",
  // 官方内容插件新增 agents 后，filesystem seed 的顶层白名单未同步，目录被静默裁掉。
  "agents",
  "commands",
  "dist",
  "docs",
  "hooks",
  "output-styles",
  "package.json",
  // Browser skill 会从官方插件根目录动态导入 scripts/browser-client.mjs。
  // filesystem seed 若漏掉 scripts，Dev 会连接 node_repl 成功却在首次 Browser Use 时导入失败。
  "scripts",
  "skills",
  "templates",
]);

export interface OfficialPluginSeedFile {
  mode?: number;
  path: string;
  sha256: string;
  sourcePath?: string;
}

export interface OfficialPluginSeedPluginSource {
  definition: OfficialPluginDefinition;
  files: OfficialPluginSeedFile[];
  hash: string;
  missingSeedPaths: string[];
  rootPath?: string;
}

export interface OfficialPluginSeedSource {
  kind: "filesystem" | "sea";
  plugins: OfficialPluginSeedPluginSource[];
  /**
   * 读取单个 seed 文件字节的唯一边界：filesystem 走真实路径，SEA 走内嵌资产键。
   * 由 resolve 函数按来源类型注入，使「SEA 内嵌资产在哪里」不再散在读取方。
   */
  readFileBytes?: (
    plugin: OfficialPluginSeedPluginSource,
    file: OfficialPluginSeedFile,
  ) => Buffer | Promise<Buffer>;
}

interface SeaOfficialPluginManifest {
  hash: string;
  plugins: Array<{
    files: OfficialPluginSeedFile[];
    marketplace: string;
    name: string;
    version: string;
  }>;
  version: 1;
}

type SeaModule = typeof import("node:sea");

interface ResolveSeedSourceOptions {
  /**
   * 候选插件根目录基址。默认走 `candidateBaseDirs()`；测试用它指向临时 checkout，
   * 避免为了覆盖查找路径去改 `process.argv`/`cwd` 这类进程全局状态。
   */
  baseDirs?: readonly string[];
}

export async function resolveSeedSource(
  options: ResolveSeedSourceOptions = {},
): Promise<OfficialPluginSeedSource | undefined> {
  const seaSource = resolveSeaSeedSource();
  if (seaSource) return seaSource;
  return resolveFilesystemSeedSource(options.baseDirs ?? candidateBaseDirs());
}

function resolveSeaSeedSource(): OfficialPluginSeedSource | undefined {
  const sea = getSeaModule();
  if (!sea?.isSea()) return undefined;

  const manifest = readSeaManifest(sea);
  if (!manifest) return undefined;
  return resolveSeaSeedSourceFromManifest(manifest, (assetKey) =>
    Buffer.from(sea.getRawAsset(assetKey)),
  );
}

/**
 * 从 SEA 内嵌清单构造 seed 源（纯数据 + 可注入读取器）。运行时用 `sea.getRawAsset`，
 * 验收用同一份清单形状 + 与生产一致资产键的临时资产表，证明两条 seed 变体走同一段
 * staging/闭包校验/降级路径。
 */
export function resolveSeaSeedSourceFromManifest(
  manifest: SeaOfficialPluginManifest,
  readAsset: (assetKey: string) => Buffer,
): OfficialPluginSeedSource | undefined {
  const plugins = OFFICIAL_PLUGIN_DEFINITIONS.flatMap((definition) => {
    const plugin = manifest.plugins.find(
      (item) =>
        item.marketplace === OFFICIAL_PLUGIN_MARKETPLACE &&
        item.name === definition.name &&
        item.version === definition.version,
    );
    if (!plugin) return [];
    return [
      {
        definition,
        files: plugin.files,
        hash: hashSeedFiles(plugin.files),
        missingSeedPaths: findMissingOfficialPluginSeedPaths(definition, plugin.files),
      },
    ];
  });
  if (plugins.length === 0) return undefined;

  return {
    kind: "sea",
    // SEA 资产键与构建期（sea-official-plugin-assets.mjs）逐段一致；读取失败直接抛出，
    // 由 seed 以「seed 内容残缺」降级，而不是启动时静默少一份资源。
    readFileBytes: (plugin, file) => readAsset(seaSeedAssetKey(plugin.definition, file)),
    plugins,
  };
}

/** SEA 内嵌官方插件资产的唯一定键规则。 */
export function seaSeedAssetKey(
  definition: Pick<OfficialPluginDefinition, "name" | "version">,
  file: Pick<OfficialPluginSeedFile, "path">,
): string {
  return `${SEA_PLUGIN_ASSET_PREFIX}${OFFICIAL_PLUGIN_MARKETPLACE}/${definition.name}/${definition.version}/${file.path}`;
}

async function resolveFilesystemSeedSource(
  baseDirs: readonly string[],
): Promise<OfficialPluginSeedSource | undefined> {
  const plugins: OfficialPluginSeedPluginSource[] = [];
  for (const definition of OFFICIAL_PLUGIN_DEFINITIONS) {
    const rootPath = await resolveFilesystemPluginRoot(definition, baseDirs);
    if (!rootPath) continue;
    const files = await collectFilesystemPluginFiles(rootPath, definition);
    plugins.push({
      definition,
      files,
      hash: hashSeedFiles(files),
      missingSeedPaths: findMissingOfficialPluginSeedPaths(definition, files),
      rootPath,
    });
  }
  if (plugins.length === 0) return undefined;
  return {
    kind: "filesystem",
    plugins,
    readFileBytes: (_plugin, file) => {
      if (!file.sourcePath)
        throw new Error(`Filesystem seed file has no source path: ${file.path}`);
      return readFile(file.sourcePath);
    },
  };
}

function findMissingOfficialPluginSeedPaths(
  definition: Pick<OfficialPluginDefinition, "requiredSeedPaths">,
  files: ReadonlyArray<{ path: string }>,
): string[] {
  const availablePaths = new Set(files.map((file) => file.path));
  return (definition.requiredSeedPaths ?? []).filter(
    (requiredPath) => !availablePaths.has(requiredPath),
  );
}

function getSeaModule(): SeaModule | undefined {
  const getBuiltinModule = process.getBuiltinModule as ((id: "node:sea") => SeaModule) | undefined;
  try {
    return getBuiltinModule?.("node:sea");
  } catch {
    return undefined;
  }
}

function readSeaManifest(sea: SeaModule): SeaOfficialPluginManifest | undefined {
  try {
    const raw = sea.getAsset(SEA_PLUGIN_MANIFEST_ASSET_KEY, "utf8");
    const manifest = JSON.parse(raw) as SeaOfficialPluginManifest;
    return manifest.version === 1 && Array.isArray(manifest.plugins) ? manifest : undefined;
  } catch {
    return undefined;
  }
}

async function resolveFilesystemPluginRoot(
  definition: OfficialPluginDefinition,
  baseDirs: readonly string[],
): Promise<string | undefined> {
  for (const baseDir of baseDirs) {
    for (const relativePath of definition.rootCandidates) {
      const rootPath = resolve(baseDir, relativePath);
      if (
        await access(join(rootPath, ".zcodium-plugin", "plugin.json")).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        )
      )
        return rootPath;
    }
  }
  return undefined;
}

async function collectFilesystemPluginFiles(
  rootPath: string,
  definition: OfficialPluginDefinition,
): Promise<OfficialPluginSeedFile[]> {
  const files: OfficialPluginSeedFile[] = [];
  const allowedTopLevelPaths = new Set([
    ...includedTopLevelPaths,
    ...(definition.runtimeTopLevelPaths ?? []),
  ]);
  for await (const sourcePath of walkPluginSeedFiles(
    rootPath,
    allowedTopLevelPaths,
    new Set(definition.runtimeSubtrees ?? []),
  )) {
    const relativePath = toPosixPath(sourcePath.slice(rootPath.length + 1));
    if (!shouldIncludePluginSeedFile(relativePath, allowedTopLevelPaths)) continue;
    const bytes = await readFile(sourcePath);
    files.push({
      mode: modeForSeedFile(relativePath, (await stat(sourcePath)).mode),
      path: relativePath,
      sha256: hashBytes(bytes),
      sourcePath,
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export function readSeedFileBytes(
  source: OfficialPluginSeedSource,
  plugin: OfficialPluginSeedPluginSource,
  file: OfficialPluginSeedFile,
): Buffer | Promise<Buffer> {
  if (source.readFileBytes) return source.readFileBytes(plugin, file);
  // 兼容旧调用方：手工构造的 source 没有读取器时仍按 kind 回退到原有规则。
  if (source.kind === "filesystem" && file.sourcePath) return readFile(file.sourcePath);
  const sea = getSeaModule();
  if (!sea?.isSea()) throw new Error("SEA plugin asset is unavailable outside SEA runtime.");
  return Buffer.from(sea.getRawAsset(seaSeedAssetKey(plugin.definition, file)));
}

export function modeForSeedFile(filePath: string, sourceMode?: number): number {
  if (sourceMode !== undefined && (sourceMode & 0o111) !== 0) return 0o755;

  const normalizedPath = toPosixPath(filePath);
  // official plugin seed 会重写缓存文件权限。部分插件通过 polyglot shell wrapper
  // 直接执行 hook 脚本，若落盘成 0644 会 permission denied。这里保留源码执行位，
  // 并对 SEA/旧 manifest 缺少 mode 的 hook 脚本兜底。
  if (/(?:^|\/)dist\/mcp\/server\.js$/i.test(normalizedPath)) return 0o755;
  if (normalizedPath.startsWith("hooks/") && !/\.(json|md|txt)$/iu.test(normalizedPath)) {
    return 0o755;
  }

  return 0o644;
}

function hashSeedFiles(files: OfficialPluginSeedFile[]): string {
  return hashText(
    JSON.stringify(
      files.map((file) => [file.path, file.sha256, modeForSeedFile(file.path, file.mode)]),
    ),
  );
}

function toPosixPath(value: string): string {
  return value.split(sep).join("/");
}

export function uniquePaths(paths: string[]): string[] {
  return paths.filter((path, index) => paths.indexOf(path) === index);
}

export function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashText(text: string): string {
  return hashBytes(Buffer.from(text));
}
