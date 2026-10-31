import type { ResolveZCodePluginsOptions } from "./plugin-types.js";
import { resolveOfficialPluginRoots } from "./app/bundled-plugins.js";
import { discoverNodePluginsSync } from "@zcode/adapters/plugins";
import type { PluginLoadOutcome } from "@zcode/contracts";
import { DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS } from "./app/official-plugin-definitions.js";
import { resolvePluginContext } from "./plugin-context.js";

export async function resolveZCodePlugins(
  options: ResolveZCodePluginsOptions = {},
): Promise<PluginLoadOutcome> {
  const { configResult, pluginStorageRoot, workingDirectory } = resolvePluginContext(options);

  return discoverNodePluginsSync({
    config: configResult.config.plugins,
    env: options.env ?? process.env,
    officialPluginRoots: await resolveOfficialPluginRoots({
      extraRoots: options.officialPluginRoots,
      // cache 锁冲突已从 fatal 改为 degraded，普通插件入口也必须保留诊断日志。
      logger: options.logger,
      storageRoot: pluginStorageRoot,
      suppressedBuiltins: new Set(configResult.config.plugins.suppressedBuiltins),
    }),
    officialPluginsEnabledByDefault: DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS,
    storageRoot: pluginStorageRoot,
    workingDirectory,
  });
}

export { getZCodePluginsOverview } from "./plugin-overview.js";
export { listZCodePlugins } from "./plugin-overview.js";
export {
  addZCodePluginMarketplace,
  removeZCodePluginMarketplace,
  updateZCodePluginMarketplace,
  validateZCodePluginPath,
} from "./plugin-marketplace-actions.js";
export {
  installZCodeMarketplacePlugin,
  restoreBuiltinPlugin,
  uninstallZCodeMarketplacePlugin,
  updateZCodeMarketplacePlugin,
} from "./plugin-install-actions.js";
export {
  configureZCodePlugin,
  describeZCodePlugin,
  resetZCodePluginConfig,
  setZCodePluginEnabled,
  validateZCodePlugin,
} from "./plugin-config-actions.js";
export type {
  ResolveZCodePluginsOptions,
  ListZCodePluginsOptions,
  SetZCodePluginEnabledOptions,
  SetZCodePluginEnabledResult,
  ZCodeMarketplaceSummaryData,
  ZCodeAvailablePluginData,
  ZCodeInstalledPluginData,
  ZCodePluginsOverviewData,
  ZCodeMarketplaceUpdateData,
  AddZCodeMarketplaceOptions,
  RemoveZCodeMarketplaceOptions,
  UpdateZCodeMarketplaceOptions,
  InstallZCodeMarketplacePluginOptions,
  UninstallZCodeMarketplacePluginOptions,
  UpdateZCodeMarketplacePluginOptions,
  ValidateZCodePluginPathOptions,
  ZCodePluginUpdateData,
  ZCodePluginInstallData,
} from "./plugin-types.js";
