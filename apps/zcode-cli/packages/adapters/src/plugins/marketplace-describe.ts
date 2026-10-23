import { directoryExists } from "./helpers.js";
import type { PluginDiagnostic, PluginManifest } from "@zcode/contracts";
import { enumeratePluginComponents, type PluginComponentGroup } from "./plugin-components.js";
import {
  type DescribeMarketplacePluginResult,
  type PluginManifestDisplayMetadata,
  type PluginMarketplaceEntry,
  type PluginMarketplaceManifest,
  type PluginValidationDiagnostic,
  type ResolvedPluginSourceRoot,
  getMarketplaceManifestPath,
} from "./marketplace-types.js";
import {
  loadInstalledPluginsSync,
  loadMarketplaceManifestSync,
  normalizeAuthorValue,
  readPluginManifestFromRoot,
  resolveInstalledPluginRoot,
} from "./marketplace-manifest.js";
import { ensureMarketplaceManifestAvailable } from "./marketplace-refresh.js";
import { toValidationDiagnostic } from "./marketplace-diagnostics.js";
import { resolvePluginSourceRoot } from "./marketplace-source.js";
import { cleanupPluginSourceBestEffort } from "./helpers.js";

export async function describeMarketplacePlugin(input: {
  marketplace: string;
  name: string;
  storageRoot: string;
  /**
   * 只包住会写 known/manifest 的懒加载分支；其余只读路径不进锁。
   * 由调用方注入既有 storage lock（`withPluginStorageLock`），不在这里新建锁权威。
   */
  withWriteLock?: <T>(write: () => Promise<T>) => Promise<T>;
}): Promise<DescribeMarketplacePluginResult> {
  const diagnostics: PluginValidationDiagnostic[] = [];
  const pluginId = `${input.name}@${input.marketplace}`;

  // 已安装优先：本地目录无需 clone，速度快且离线可用。
  const installedRecord = loadInstalledPluginsSync(input.storageRoot).plugins.find(
    (record) => record.marketplace === input.marketplace && record.name === input.name,
  );
  if (installedRecord) {
    const rootPath = resolveInstalledPluginRoot(input.storageRoot, installedRecord);
    if (directoryExists(rootPath)) {
      const read = readComponentsAtRoot({
        diagnostics,
        marketplace: input.marketplace,
        rootPath,
      });
      return {
        components: read.components,
        diagnostics,
        ...(read.metadata ? { metadata: read.metadata } : {}),
      };
    }
    // 安装记录存在但缓存缺失（被清理）——继续走源解析兜底，而不是直接报错。
  }

  let manifest: PluginMarketplaceManifest | null = null;
  try {
    // Bugfix：describe 曾整体持 storage lock，安装/刷新下载期间所有详情都排在锁后。
    // 已装缓存与已缓存 manifest 是纯读；只有 manifest 缺失时才写 known/manifest，
    // 那段必须与安装、市场刷新串行，因此只把懒加载分支交给既有写锁。
    manifest = loadMarketplaceManifestSync(input.storageRoot, input.marketplace);
    if (!manifest) {
      const withWriteLock = input.withWriteLock ?? ((write) => write());
      await withWriteLock(async () => {
        // 二次检查：并发读者进入锁后若已被前一个填充，就不再重复抓取/覆盖。
        if (loadMarketplaceManifestSync(input.storageRoot, input.marketplace)) return;
        await ensureMarketplaceManifestAvailable({
          marketplace: input.marketplace,
          storageRoot: input.storageRoot,
        });
      });
      manifest = loadMarketplaceManifestSync(input.storageRoot, input.marketplace);
    }
  } catch (error) {
    diagnostics.push(toValidationDiagnostic(error, pluginId));
    return { components: [], diagnostics };
  }
  if (!manifest) {
    diagnostics.push({
      code: "plugin_marketplace_invalid",
      message: `Marketplace not found: ${input.marketplace}`,
      path: getMarketplaceManifestPath(input.storageRoot, input.marketplace),
      severity: "error",
    });
    return { components: [], diagnostics };
  }
  const entry = manifest.plugins.find((candidate) => candidate.name === input.name);
  if (!entry) {
    diagnostics.push({
      code: "plugin_not_found",
      message: `Plugin not found: ${pluginId}`,
      path: getMarketplaceManifestPath(input.storageRoot, input.marketplace),
      severity: "error",
    });
    return { components: [], diagnostics };
  }

  let resolved: ResolvedPluginSourceRoot | null = null;
  try {
    resolved = await resolvePluginSourceRoot({
      entry,
      marketplace: input.marketplace,
      storageRoot: input.storageRoot,
    });
    const read = readComponentsAtRoot({
      diagnostics,
      entry,
      marketplace: input.marketplace,
      rootPath: resolved.path,
    });
    return {
      components: read.components,
      diagnostics,
      ...(read.metadata ? { metadata: read.metadata } : {}),
    };
  } catch (error) {
    diagnostics.push(toValidationDiagnostic(error, pluginId));
    return { components: [], diagnostics };
  } finally {
    await cleanupPluginSourceBestEffort(resolved?.cleanup);
  }
}

/** 读插件根目录的 manifest（失败按 null 降级），再交给纯枚举器列出组件名称+描述。 */
function readComponentsAtRoot(input: {
  diagnostics: PluginValidationDiagnostic[];
  entry?: PluginMarketplaceEntry;
  marketplace: string;
  rootPath: string;
}): { components: PluginComponentGroup[]; metadata?: PluginManifestDisplayMetadata } {
  let loadedManifest: { manifest: PluginManifest; manifestPath?: string } | null = null;
  try {
    loadedManifest = readPluginManifestFromRoot(
      input.rootPath,
      input.entry ?? { name: "__describe__", raw: {} },
    );
  } catch {
    // manifest 解析失败不致命：仍可按默认目录约定扫描组件。
    loadedManifest = null;
  }
  const loaded = loadedManifest
    ? {
        id: `${loadedManifest.manifest.name}@${input.marketplace}`,
        manifest: loadedManifest.manifest,
        manifestPath: loadedManifest.manifestPath ?? input.rootPath,
        marketplace: input.marketplace,
        rootPath: input.rootPath,
        source: "cache" as const,
      }
    : undefined;
  const components = enumeratePluginComponents(input.rootPath, loadedManifest?.manifest ?? null, {
    diagnostics: input.diagnostics as PluginDiagnostic[],
    ...(loaded ? { loaded } : {}),
  });
  const metadata = loadedManifest ? toManifestDisplayMetadata(loadedManifest.manifest) : undefined;
  return { components, ...(metadata ? { metadata } : {}) };
}

/** 抽取 plugin.json 里可展示的回退字段；一个都没有时返回 undefined。 */
function toManifestDisplayMetadata(
  manifest: PluginManifest,
): PluginManifestDisplayMetadata | undefined {
  const author = normalizeAuthorValue(manifest.author);
  const homepage =
    typeof manifest.homepage === "string" && manifest.homepage.trim().length > 0
      ? manifest.homepage
      : undefined;
  const metadata: PluginManifestDisplayMetadata = {
    ...(author?.name ? { author: author.name } : {}),
    ...(author?.url ? { authorUrl: author.url } : {}),
    ...(homepage ? { homepage } : {}),
    ...(manifest.version ? { version: manifest.version } : {}),
  };
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}
