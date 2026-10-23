import type {
  InstallZCodeMarketplacePluginOptions,
  RestoreBuiltinPluginOptions,
  UninstallZCodeMarketplacePluginOptions,
  UpdateZCodeMarketplacePluginOptions,
  ZCodeInstalledPluginData,
  ZCodePluginInstallData,
  ZCodePluginUpdateData,
} from "./plugin-types.js";
import { resolvePluginContext } from "./plugin-context.js";
import {
  materializeDeclaredMarketplaceForExplicitAction,
  resolveDeclaredMarketplaceSources,
} from "./plugin-marketplace-declaration.js";
import { createMarketplaceSourceRepointDiagnostic } from "./plugin-data.js";
import {
  toInstalledPluginData,
  toMarketplaceInstallDiagnostic,
  toPluginDiagnostic,
  resolvePluginIdForMutation,
} from "./plugin-data.js";
import { updateZCodePluginMarketplace } from "./plugin-marketplace-actions.js";
import { resolveZCodePlugins } from "./plugins.js";
import { rm } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
  addSuppressedBuiltinInFileConfig,
  enablePluginsByDefaultInFileConfig,
  removePluginFromFileConfig,
  removeSuppressedBuiltinInFileConfig,
} from "@zcode/adapters/config";
import {
  getPluginDataDir,
  installMarketplacePlugin,
  listInstalledPluginRecords,
  loadKnownMarketplacesSync,
  loadMarketplaceManifestSync,
  uninstallMarketplacePlugin,
  validateMarketplacePlugin,
  validateMarketplaceSource,
} from "@zcode/adapters/plugins";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@zcode/contracts";
import { ZCODE_CUA_OFFICIAL_PLUGIN_ID, isZCodeCuaInternalFeatureEnabled } from "@zcode/shared";
import { resolveOfficialPluginRoots } from "./app/bundled-plugins.js";
import { withPluginStorageLock } from "./lib/plugin-storage-lock.js";
export async function installZCodeMarketplacePlugin(
  options: InstallZCodeMarketplacePluginOptions,
): Promise<ZCodePluginInstallData> {
  const { configResult, pluginStorageRoot, workingDirectory } = resolvePluginContext(options);
  if (options.dryRun === true) {
    const declarationSource = resolveDeclaredMarketplaceSources({
      configResult,
    }).get(options.marketplace);
    const known = loadKnownMarketplacesSync(pluginStorageRoot).find(
      (record) => record.id === options.marketplace,
    );
    if (declarationSource && known && !isDeepStrictEqual(known.source, declarationSource)) {
      return {
        dependencyClosure: [],
        installedPlugins: [],
        diagnostics: [createMarketplaceSourceRepointDiagnostic(options.marketplace)],
      };
    }
    if (
      declarationSource &&
      (!known || !loadMarketplaceManifestSync(pluginStorageRoot, options.marketplace))
    ) {
      return {
        dependencyClosure: [],
        installedPlugins: [],
        diagnostics: (
          await validateMarketplaceSource({
            expectedId: options.marketplace,
            pluginName: options.pluginName,
            signal: options.abortSignal,
            source: declarationSource,
            storageRoot: pluginStorageRoot,
          })
        ).map(toPluginDiagnostic),
      };
    }
    return {
      dependencyClosure: [],
      installedPlugins: [],
      diagnostics: (
        await validateMarketplacePlugin({
          marketplace: options.marketplace,
          name: options.pluginName,
          storageRoot: pluginStorageRoot,
        })
      ).map(toPluginDiagnostic),
    };
  }
  const pluginId = `${options.pluginName}@${options.marketplace}`;
  const bundledEntry = loadMarketplaceManifestSync(
    pluginStorageRoot,
    options.marketplace,
  )?.plugins.find((entry) => entry.name === options.pluginName);
  const isSuppressedBundledOfficial =
    options.marketplace === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE &&
    configResult.config.plugins.suppressedBuiltins.includes(pluginId) &&
    (bundledEntry?.source === "filesystem" || bundledEntry?.source === "sea");
  if (isSuppressedBundledOfficial) {
    // 内置插件的 filesystem/SEA entry 只是 Catalog 指针，不是普通 Marketplace source。
    // 直接安装必须复用 restore，避免把同一份官方 cache 写进 installed_plugins.json，
    // 否则卸载/更新会把内置资产误判成用户安装并破坏恢复语义。
    // 当前调用由协议层的 storage lock 保护；这里必须调用不再加锁的核心，
    // 否则同一 storageRoot 的 promise-chain lock 会等待自身而永久阻塞。
    await restoreBuiltinPluginCore({ ...options, configResult, pluginId });
    const fresh = resolvePluginContext({ ...options, configResult: undefined });
    const outcome = resolveZCodePlugins({
      ...options,
      configResult: fresh.configResult,
      pluginStorageRoot: fresh.pluginStorageRoot,
    });
    const restored = outcome.plugins.find((plugin) => plugin.id === pluginId);
    if (!restored) {
      return {
        dependencyClosure: [],
        installedPlugins: [],
        diagnostics: [
          toPluginDiagnostic({
            code: "plugin_not_found",
            message: `Bundled plugin could not be restored: ${pluginId}`,
            pluginId,
            severity: "error",
          }),
        ],
      };
    }
    const now = new Date().toISOString();
    return {
      dependencyClosure: [pluginId],
      installedPlugins: [
        toInstalledPluginData(
          {
            id: restored.id,
            name: restored.name,
            marketplace: restored.marketplace,
            version: restored.version ?? "",
            installPath: restored.rootPath,
            installedAt: now,
            updatedAt: now,
            scope: "user",
          },
          restored.enabled,
          restored,
        ),
      ],
      diagnostics: [],
    };
  }
  let installed: Awaited<ReturnType<typeof installMarketplacePlugin>>;
  try {
    await materializeDeclaredMarketplaceForExplicitAction({
      configResult,
      marketplaceId: options.marketplace,
      pluginStorageRoot,
      abortSignal: options.abortSignal,
      workingDirectory,
    });
    installed = await installMarketplacePlugin({
      signal: options.abortSignal,
      marketplace: options.marketplace,
      name: options.pluginName,
      // package/cache/installed record 是目标 Host 的 User inventory；
      // 旧协议的 Workspace scope 仅为兼容保留，不能改变 Marketplace 默认启用写入 User config
      // 的语义。installed record 没有 workspace identity，不能让它参与 Workspace 配置归属。
      scope: "user",
      storageRoot: pluginStorageRoot,
    });
  } catch (error) {
    return {
      dependencyClosure: [],
      installedPlugins: [],
      diagnostics: [
        toMarketplaceInstallDiagnostic(error, `${options.pluginName}@${options.marketplace}`),
      ],
    };
  }
  if (options.marketplace === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE) {
    // 官方 marketplace 复用内置插件的 id 空间。若同名 CDN 插件重新安装，
    // 清掉历史内置 suppression，否则 Runtime 仍会把已拥有的安装误判为 suppressed。
    for (const record of installed.installed) {
      await removeSuppressedBuiltinInFileConfig(configResult.sources.user.path, record.id);
    }
  }
  // Marketplace 只管理 Host User inventory；即使旧协议调用方传入 workspace scope，
  // 安装即默认启用也必须写入 User config，不能把 Marketplace 动作变成 Workspace override。
  // 仅作用于用户配置里尚未显式声明的 id（停用后重装等显式选择不被覆盖）。
  const { enabledIds } = await enablePluginsByDefaultInFileConfig(
    configResult.sources.user.path,
    installed.installed.map((record) => record.id),
  );
  const enabledIdSet = new Set(enabledIds);
  // 已有显式配置的，沿用其当前启用态；本次新置默认启用的标记为 true。
  const enabledById = (id: string): boolean =>
    enabledIdSet.has(id) || (configResult.config.plugins.enabledPlugins[id] ?? false);
  return {
    dependencyClosure: installed.closure,
    installedPlugins: installed.installed.map((record) =>
      toInstalledPluginData(record, enabledById(record.id)),
    ),
    diagnostics: [],
  };
}

export async function uninstallZCodeMarketplacePlugin(
  options: UninstallZCodeMarketplacePluginOptions,
): Promise<ZCodeInstalledPluginData | null> {
  const { configResult, pluginStorageRoot, workingDirectory } = resolvePluginContext(options);
  return withPluginStorageLock(pluginStorageRoot, async () => {
    const pluginId = resolvePluginIdForMutation(options);

    // 官方 CDN marketplace 与内置插件共享 zcode-plugins-official id 空间，且其缓存
    // 也位于 official cache 下。若先看 runtime source="official"，会把已有
    // installed_plugins.json 记录的 CDN 插件误判成内置插件，只写 suppression 却不删安装记录，
    // 导致 UI 永远保持 installed、无法重装。持久化安装记录是 marketplace 所有权的权威证据，
    // 必须优先于运行时来源分类；同时清掉可能遗留的错误 suppression，让状态自愈。
    const installedRecord = listInstalledPluginRecords(pluginStorageRoot).find(
      (record) => record.id === pluginId,
    );
    if (installedRecord) {
      const removed = await uninstallMarketplacePlugin({
        pluginId,
        // 卸载语义即彻底清除：除非调用方显式传 removeCache=false，否则连缓存与 data 目录一起删。
        removeCache: options.removeCache ?? true,
        keepData: options.keepData,
        storageRoot: pluginStorageRoot,
      });
      if (!removed) return null;
      await removePluginFromFileConfig(configResult.sources.user.path, removed.id);
      await removeSuppressedBuiltinInFileConfig(configResult.sources.user.path, removed.id);
      return toInstalledPluginData(removed, false);
    }

    // 内置（官方）插件不在 installed_plugins.json 里，无法走 marketplace 卸载路径。
    // 卸载只改变 Runtime 抑制态并清理用户数据/config；Catalog 与不可变 cache 必须保留，
    // 这样详情页仍能离线读取组件，且恢复动作不依赖重新下载或重新构造目录。
    const outcome = resolveZCodePlugins({
      ...options,
      configResult,
      pluginStorageRoot,
      workingDirectory,
    });
    const builtin = outcome.plugins.find(
      (plugin) => plugin.id === pluginId && plugin.source === "official",
    );
    if (builtin) {
      await addSuppressedBuiltinInFileConfig(configResult.sources.user.path, pluginId);
      // 先清掉 user config 里的 enabledPlugins[id] 与 options[id]，再删目录：抑制标记已是
      // 唯一真相源（写入用原子 temp+rename），即使后续删除抛错，下次 resolve 也会跳过并补删
      // 缓存；把 config 清理放在删除之前可保证「恢复时从干净状态开始」即便删除中途失败。
      await removePluginFromFileConfig(configResult.sources.user.path, pluginId);
      // 不删除官方 cache：它与 Marketplace Catalog 同属详情/恢复所需的只读资产。
      if (options.keepData !== true) {
        await rm(getPluginDataDir(pluginStorageRoot, pluginId), { force: true, recursive: true });
      }
      const now = new Date().toISOString();
      return toInstalledPluginData(
        {
          id: builtin.id,
          name: builtin.name,
          marketplace: builtin.marketplace,
          version: builtin.version ?? "",
          installPath: builtin.rootPath,
          installedAt: now,
          updatedAt: now,
          scope: "user",
        },
        false,
      );
    }

    return null;
  });
}

/**
 * `zcode plugins update <plugin>`：先刷新所属 marketplace 目录，再按同一条目重装。
 * cacheMarketplacePlugin 对已存在的安装记录做原地覆盖并保留 installedAt；启用态只会给
 * 用户配置里尚未显式声明的 id 补默认值，因此更新不会改变用户已经做过的开关选择。
 */
export async function updateZCodeMarketplacePlugin(
  options: UpdateZCodeMarketplacePluginOptions,
): Promise<ZCodePluginUpdateData> {
  const { pluginStorageRoot } = resolvePluginContext(options);
  const record = listInstalledPluginRecords(pluginStorageRoot).find(
    (installed) => installed.id === options.pluginId,
  );
  if (!record) throw new Error(`Plugin not installed: ${options.pluginId}`);
  const refreshed = await updateZCodePluginMarketplace({
    ...options,
    marketplace: record.marketplace,
  });
  const refreshErrors = refreshed.diagnostics.filter((item) => item.severity === "error");
  if (refreshErrors.length > 0) {
    return {
      dependencyClosure: [],
      installedPlugins: [],
      diagnostics: refreshErrors,
      previousVersion: record.version,
    };
  }
  const installed = await installZCodeMarketplacePlugin({
    ...options,
    marketplace: record.marketplace,
    pluginName: record.name,
    scope: record.scope,
  });
  return { ...installed, previousVersion: record.version };
}

/** `zcode plugins validate <path>`：只读校验本地插件目录或 marketplace 目录。 */
async function restoreBuiltinPluginCore(options: RestoreBuiltinPluginOptions): Promise<void> {
  const zcodeCuaPluginId = ZCODE_CUA_OFFICIAL_PLUGIN_ID;
  if (
    options.pluginId === zcodeCuaPluginId &&
    !isZCodeCuaInternalFeatureEnabled(options.env ?? process.env)
  ) {
    // overview 虽然隐藏了恢复入口，但协议调用仍可绕过 UI 写用户配置。
    // 功能开关关闭时在写盘前失败，确保用户配置与插件缓存都保持零痕迹。
    throw new Error("computer-use built-in plugin requires ZCODE_CUA_PRODUCT_HELPER to be enabled");
  }
  const { configResult } = resolvePluginContext(options);
  await removeSuppressedBuiltinInFileConfig(configResult.sources.user.path, options.pluginId);
  // 重读磁盘上的最新 config（patch 后），确保抑制集合不再包含刚恢复的 id；
  // 不能复用 patch 前可能被传入的 configResult。
  const fresh = resolvePluginContext({ ...options, configResult: undefined });
  // 立即重新 seed，让插件即刻可用，无需等待下一次 resolve。
  resolveOfficialPluginRoots({
    storageRoot: fresh.pluginStorageRoot,
    suppressedBuiltins: new Set(fresh.configResult.config.plugins.suppressedBuiltins),
  });
}

export async function restoreBuiltinPlugin(options: RestoreBuiltinPluginOptions): Promise<void> {
  const { pluginStorageRoot } = resolvePluginContext(options);
  await withPluginStorageLock(pluginStorageRoot, () => restoreBuiltinPluginCore(options));
}
