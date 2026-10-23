import type { ConfigResult } from "@zcode/adapters/config";
import type {
  Logger,
  PluginHookDetail,
  PluginLoadOutcome,
  PluginMetadata,
  PluginStoreListing,
} from "@zcode/contracts";
export interface ResolveZCodePluginsOptions {
  configResult?: ConfigResult;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  officialPluginRoots?: string[];
  pluginStorageRoot?: string;
  projectConfigPath?: string;
  skipUserConfig?: boolean;
  userConfigPath?: string;
  workingDirectory?: string;
}

export interface ListZCodePluginsOptions extends ResolveZCodePluginsOptions {}

export interface SetZCodePluginEnabledOptions extends ResolveZCodePluginsOptions {
  enabled: boolean;
  plugin: string;
  scope?: "user" | "workspace";
}

export interface SetZCodePluginEnabledResult {
  enabled: boolean;
  path: string;
  plugin: PluginMetadata;
}

export interface ZCodeMarketplaceSummaryData {
  id: string;
  name: string;
  source: Record<string, unknown>;
  description?: string;
  lastUpdated?: string;
  pluginCount: number;
  isOfficial: boolean;
  refreshFailure?: {
    code: string;
    failedAt: string;
    message: string;
  };
  // 目录顶层 featured 策展名单（商店「公开」分段 Featured 区），随 manifest 下发。
  featured?: string[];
}

export interface ZCodeAvailablePluginData {
  id: string;
  name: string;
  marketplace: string;
  description?: string;
  version?: string;
  installed: boolean;
  componentTypes?: string[];
  hookDetails?: PluginHookDetail[];
  // 商店信息（显示名/icon/分类/作者/链接/hero/示例提示词），来自目录条目。
  listing?: PluginStoreListing;
}

export interface ZCodeInstalledPluginData {
  id: string;
  name: string;
  marketplace: string;
  description?: string;
  version?: string;
  enabled: boolean;
  scope: "user" | "workspace";
  installPath?: string;
  installedAt?: string;
  componentTypes?: string[];
  hookDetails?: PluginHookDetail[];
  updateStatus?: "none" | "update-available" | "version-changed";
  latestVersion?: string;
  // 已安装插件的商店信息由目录条目按 id join 得到（市场被移除时缺失，UI 走降级）。
  listing?: PluginStoreListing;
}

export interface ZCodePluginsOverviewData {
  marketplaces: ZCodeMarketplaceSummaryData[];
  availablePlugins: ZCodeAvailablePluginData[];
  installedPlugins: ZCodeInstalledPluginData[];
  restorableBuiltins: ZCodeAvailablePluginData[];
  diagnostics: PluginLoadOutcome["diagnostics"];
}

export interface ZCodeMarketplaceUpdateData {
  diagnostics: PluginLoadOutcome["diagnostics"];
  marketplaces: ZCodeMarketplaceSummaryData[];
}

export interface AddZCodeMarketplaceOptions extends ResolveZCodePluginsOptions {
  abortSignal?: AbortSignal;
  dryRun?: boolean;
  source: string;
  /** `marketplace add --sparse`：仅 git/github 源支持 sparse checkout 子目录。 */
  sparsePaths?: string[];
}

export interface RemoveZCodeMarketplaceOptions extends ResolveZCodePluginsOptions {
  marketplace: string;
}

export interface UpdateZCodeMarketplaceOptions extends ResolveZCodePluginsOptions {
  abortSignal?: AbortSignal;
  marketplace?: string;
}

export interface InstallZCodeMarketplacePluginOptions extends ResolveZCodePluginsOptions {
  abortSignal?: AbortSignal;
  dryRun?: boolean;
  marketplace: string;
  pluginName: string;
  scope?: "user" | "workspace";
}

export interface UninstallZCodeMarketplacePluginOptions extends ResolveZCodePluginsOptions {
  pluginId?: string;
  pluginName?: string;
  marketplace?: string;
  removeCache?: boolean;
  /** 保留 data/<plugin-id> 用户数据目录（`zcode plugins uninstall --keep-data`）。 */
  keepData?: boolean;
}

export interface UpdateZCodeMarketplacePluginOptions extends ResolveZCodePluginsOptions {
  abortSignal?: AbortSignal;
  pluginId: string;
}

export interface ValidateZCodePluginPathOptions extends ResolveZCodePluginsOptions {
  abortSignal?: AbortSignal;
  path: string;
}

export interface ZCodePluginUpdateData extends ZCodePluginInstallData {
  previousVersion: string;
}

export interface RestoreBuiltinPluginOptions extends ResolveZCodePluginsOptions {
  pluginId: string;
}

export interface ConfigureZCodePluginOptions extends ResolveZCodePluginsOptions {
  clearOptionKeys?: string[];
  dryRun?: boolean;
  options: Record<string, unknown>;
  pluginId: string;
  scope?: "user" | "workspace";
}

export interface ResetZCodePluginConfigOptions extends ResolveZCodePluginsOptions {
  pluginId: string;
  scope?: "user" | "workspace";
}

export interface ValidateZCodePluginOptions extends ResolveZCodePluginsOptions {
  marketplace?: string;
  pluginName?: string;
  source?: string;
}

export interface DescribeZCodePluginOptions extends ResolveZCodePluginsOptions {
  marketplace: string;
  pluginName: string;
}

export interface ZCodePluginInstallData {
  dependencyClosure: string[];
  installedPlugins: ZCodeInstalledPluginData[];
  diagnostics: PluginLoadOutcome["diagnostics"];
}
