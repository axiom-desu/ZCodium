import { existsSync, mkdirSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeBundledOfficialMarketplacePartitionSync } from "@zcode/adapters";
import type { Logger } from "@zcode/contracts";
import { validateStagedOfficeViewerAssets } from "@zcode/shared/office-viewer-assets";
import {
  getOfficialPluginCacheRetryAttempts,
  removeOfficialPluginCacheDirectory,
  renameOfficialPluginCachePath,
  type OfficialPluginCacheRetryBudget,
} from "./official-plugin-cache-fs.js";
import type { OfficialPluginDefinition } from "./official-plugin-definitions.js";
import {
  OFFICIAL_PLUGIN_MARKETPLACE,
  SEED_MARKER_FILE,
  type OfficialPluginSeedPluginSource,
  type OfficialPluginSeedSource,
  readSeedFileBytes,
} from "./bundled-plugin-seed-source.js";

export async function writeOfficialMarketplace(
  storageRoot: string,
  source: OfficialPluginSeedSource,
): Promise<void> {
  const plugins = await Promise.all(
    source.plugins.map(async (plugin) => {
      // 商店信息（listing）与描述随本地目录条目下发，
      // 由 adapter 的同一套 parseEntryStoreListing 解析，UI 才能给内置插件渲染
      // 显示名/分类/作者/示例提示词。描述取自插件包内 plugin.json（单一事实源）。
      const description = await readSeedPluginDescription(source, plugin);
      return {
        cachePath: officialPluginCacheRoot(storageRoot, plugin.definition),
        // 未安装/已卸载时商店读目录条目的 componentTypes 判断「UI 插件」；缺失会掉进分类分组。
        ...(plugin.definition.componentTypes
          ? { componentTypes: [...plugin.definition.componentTypes] }
          : {}),
        ...(description ? { description } : {}),
        name: plugin.definition.name,
        source: source.kind,
        version: plugin.definition.version,
        ...plugin.definition.listing,
      };
    }),
  );
  writeBundledOfficialMarketplacePartitionSync({
    manifest: {
      name: OFFICIAL_PLUGIN_MARKETPLACE,
      plugins,
      version: 1,
    },
    storageRoot,
  });
}

/** 从 seed 文件集中读插件 plugin.json 的 description；读取/解析失败按 undefined 降级。 */
async function readSeedPluginDescription(
  source: OfficialPluginSeedSource,
  plugin: OfficialPluginSeedPluginSource,
): Promise<string | undefined> {
  const manifestFile = plugin.files.find((file) => file.path === ".zcodium-plugin/plugin.json");
  if (!manifestFile) return undefined;
  try {
    const parsed = JSON.parse(
      (await readSeedFileBytes(source, plugin, manifestFile)).toString("utf8"),
    ) as {
      description?: unknown;
    };
    return typeof parsed.description === "string" && parsed.description.trim().length > 0
      ? parsed.description
      : undefined;
  } catch {
    return undefined;
  }
}

export async function isSeedCurrent(
  targetRoot: string,
  plugin: OfficialPluginSeedPluginSource,
): Promise<boolean> {
  // 修复：标记只证明曾发布过这个版本，磁盘清理或损坏丢失必需库时仍需重新 seed。
  if (!(await isSeedUsable(targetRoot, plugin.definition))) return false;
  const markerPath = join(targetRoot, SEED_MARKER_FILE);
  if (!existsSync(markerPath)) return false;
  try {
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as ReturnType<typeof seedMarker>;
    return marker.hash === plugin.hash && marker.pluginVersion === plugin.definition.version;
  } catch {
    return false;
  }
}

/**
 * 旧版本缓存只要插件清单和运行所需文件完整，就可以继续服务当前会话。
 * marker hash 不匹配只表示需要升级，不能把一个可用的旧缓存当成启动失败。
 */
async function isSeedUsable(
  targetRoot: string,
  definition: OfficialPluginDefinition,
): Promise<boolean> {
  try {
    const manifest = JSON.parse(
      await readFile(join(targetRoot, ".zcodium-plugin", "plugin.json"), "utf8"),
    ) as { name?: unknown };
    if (manifest.name !== definition.name) return false;
  } catch {
    return false;
  }

  // 修复：缓存复用与新 seed 必须等待同一闭包/哈希校验，不能维护只验大小的第二份规则。
  try {
    await validateStagedOfficeViewerAssets(targetRoot);
  } catch {
    return false;
  }

  return (definition.requiredSeedPaths ?? []).every((requiredPath) =>
    existsSync(join(targetRoot, ...requiredPath.split("/"))),
  );
}

export async function findUsableOfficialPluginFallback(
  storageRoot: string,
  definition: OfficialPluginDefinition,
): Promise<string | undefined> {
  const targetRoot = officialPluginCacheRoot(storageRoot, definition);
  if (await isSeedUsable(targetRoot, definition)) return undefined;

  let entries;
  try {
    entries = await readdir(dirname(targetRoot), { withFileTypes: true });
  } catch (error) {
    if (isNotFoundFsError(error)) return undefined;
    throw error;
  }

  const candidates = entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name !== definition.version &&
        !entry.name.includes(".backup") &&
        // 锁目录（含 .seed-lock.stale-*）与版本目录同级；超时降级后锁必然在场，
        // 不能依赖 isSeedUsable 的内容检查兜底，按名字直接排除。
        !entry.name.includes(".seed-lock") &&
        !entry.name.includes(".tmp-"),
    )
    .sort((left, right) =>
      right.name.localeCompare(left.name, undefined, { numeric: true, sensitivity: "base" }),
    )
    .map((entry) => join(dirname(targetRoot), entry.name));
  for (const rootPath of candidates) {
    if (await isSeedUsable(rootPath, definition)) return rootPath;
  }
  return undefined;
}

export async function replaceSeedRoot(
  temporaryRoot: string,
  targetRoot: string,
  plugin: OfficialPluginSeedPluginSource,
  retryBudget: OfficialPluginCacheRetryBudget,
): Promise<void> {
  const backupRoot = createSeedBackupRoot(targetRoot);
  let movedTargetToBackup = false;
  mkdirSync(dirname(targetRoot), { recursive: true });
  if (existsSync(targetRoot)) {
    try {
      renameOfficialPluginCachePath(targetRoot, backupRoot, retryBudget);
      movedTargetToBackup = true;
    } catch (error) {
      // 官方插件缓存由桌面窗口、协议与 CLI 入口共享。existsSync 之后，
      // 另一个进程可能先移走 target；此处只收敛这个 TOCTOU 的 ENOENT，随后继续
      // promote 或由 isSeedCurrent 识别并发赢家，其他缺失错误仍保持原有 fatal 语义。
      if (!isNotFoundFsError(error)) throw error;
    }
  }

  try {
    renameOfficialPluginCachePath(temporaryRoot, targetRoot, retryBudget);
  } catch (error) {
    if (await isSeedCurrent(targetRoot, plugin)) {
      removeOfficialPluginCacheDirectory(temporaryRoot, retryBudget);
      if (movedTargetToBackup) {
        removeOfficialPluginCacheDirectory(backupRoot, retryBudget);
      }
      cleanupLegacySeedBackup(targetRoot, retryBudget);
      return;
    }
    if (movedTargetToBackup && !existsSync(targetRoot) && existsSync(backupRoot)) {
      renameOfficialPluginCachePath(backupRoot, targetRoot, retryBudget);
    }
    throw error;
  }

  if (movedTargetToBackup) {
    removeOfficialPluginCacheDirectory(backupRoot, retryBudget);
  }
  cleanupLegacySeedBackup(targetRoot, retryBudget);
}

export function cleanupLegacySeedBackup(
  targetRoot: string,
  retryBudget: OfficialPluginCacheRetryBudget,
): void {
  const backupRoot = `${targetRoot}.backup`;
  if (!existsSync(backupRoot)) return;

  // 旧版固定 backup 没有事务归属，target 暂时缺失时可能属于另一个仍在
  // promote 的进程，不能把它恢复回去。仅在当前 seed 已确认可用后清理这个遗留目录。
  removeOfficialPluginCacheDirectory(backupRoot, retryBudget);
}

function createSeedBackupRoot(targetRoot: string): string {
  // 固定 backup 会被并发启动进程共同当作 rollback 点；每次替换使用唯一目录，
  // catch 分支只恢复自己移动出的 target，避免一个进程窃取另一个进程的事务状态。
  return `${targetRoot}.backup-${process.pid}-${Date.now()}`;
}

export function isNotFoundFsError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    String((error as NodeJS.ErrnoException).code) === "ENOENT"
  );
}

export function warnCacheDegraded(
  logger: Logger | undefined,
  input: {
    error: NodeJS.ErrnoException;
    missingSeedPaths?: readonly string[];
    operation: "remove_suppressed_plugin" | "seed_plugin";
    pluginId: string;
    reason?: string;
    targetRoot: string;
  },
): void {
  logger?.warn("Official plugin cache operation degraded", {
    attempts: getOfficialPluginCacheRetryAttempts(input.error),
    degraded: true,
    errorCode: input.error.code,
    ...(input.missingSeedPaths ? { missingSeedPaths: input.missingSeedPaths } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    module: "bootstrap.official_plugin_cache",
    operation: input.operation,
    pluginId: input.pluginId,
    targetRoot: input.targetRoot,
  });
}

export function seedMarker(
  source: OfficialPluginSeedSource,
  plugin: OfficialPluginSeedPluginSource,
) {
  return {
    hash: plugin.hash,
    marketplace: OFFICIAL_PLUGIN_MARKETPLACE,
    plugin: plugin.definition.name,
    pluginVersion: plugin.definition.version,
    source: source.kind,
    version: 1,
  };
}

export function officialPluginCacheRoot(
  storageRoot: string,
  definition: OfficialPluginDefinition,
): string {
  return join(
    storageRoot,
    "cache",
    OFFICIAL_PLUGIN_MARKETPLACE,
    definition.name,
    definition.version,
  );
}

/** 内置技能包（bundled-skills.ts）沿同一组候选目录定位，保证两类内置资产在每种运行布局下同进同出。 */
