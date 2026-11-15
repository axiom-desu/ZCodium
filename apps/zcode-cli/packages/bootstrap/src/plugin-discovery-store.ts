import {
  ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
  type PluginActivationStatus,
  type PluginDiscoveryCandidate,
  type PluginDiscoveryContext,
  type PluginDiscoveryPort,
} from "@zcode/contracts";
import { isOfficialMarketplaceId } from "@zcode/contracts";
import type { ResolveZCodePluginsOptions } from "./plugin-types.js";
import { resolvePluginContext } from "./plugin-context.js";
import { getZCodePluginsOverview } from "./plugin-overview.js";
import { installZCodeMarketplacePlugin } from "./plugin-install-actions.js";
import { setZCodePluginEnabled } from "./plugin-config-actions.js";
import { updateZCodePluginMarketplace } from "./plugin-marketplace-actions.js";
import { resolveZCodePlugins } from "./plugins.js";
import { withPluginStorageLock } from "./lib/plugin-storage-lock.js";
import { createPluginDiscoveryPort } from "./plugin-discovery/port.js";
import { officialPluginCatalogRefresh } from "./plugin-discovery/refresh.js";
import { resolveZCodePlugins as loadPlugins } from "./plugins.js";

const DESCRIPTION_LIMIT = 4_000;
const I18N_LIMIT = 2_000;
const EXAMPLE_LIMIT = 20;
const boundText = (value?: string) => value?.slice(0, DESCRIPTION_LIMIT);
function boundLocale(value?: Record<string, string>): Record<string, string> | undefined {
  if (!value) return undefined;
  const entries = Object.entries(value)
    .slice(0, 20)
    .map(([locale, text]) => [locale, text.slice(0, I18N_LIMIT)] as const);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

interface PluginDiscoveryStoreOptions extends ResolveZCodePluginsOptions {
  /** 本会话已加载的插件 id（激活判定用）；缺席时只回答 refreshRequired。 */
  loadedPluginIds?: () => ReadonlySet<string>;
  /** 单飞刷新实例；测试注入独立实例，生产复用进程级单例。 */
  refresh?: typeof officialPluginCatalogRefresh;
}

/**
 * 把既有插件 store 投影成发现候选。
 *
 * 单一目录：读 `getZCodePluginsOverview`（商店/目录/安装态）与 `resolveZCodePlugins`
 * （已加载的运行时事实），不新增第二份插件目录缓存。
 * fail closed：同名插件冲突（另一个同名插件已启用）与身份冲突整条剔除——模型拿到的
 * `pluginId` 必须能唯一对应一个可安装条目。
 */
async function readCatalog(options: PluginDiscoveryStoreOptions): Promise<PluginDiscoveryCandidate[]> {
  const { configResult, pluginStorageRoot } = resolvePluginContext(options);
  const overview = await getZCodePluginsOverview({ ...options, configResult, pluginStorageRoot });
  const outcome = await loadPlugins({ ...options, configResult, pluginStorageRoot });
  const loaded = new Map(outcome.plugins.map((plugin) => [plugin.id, plugin]));
  const seen = new Set<string>();
  const entries = [...overview.availablePlugins, ...overview.restorableBuiltins];
  return entries
    .filter((entry) => isOfficialMarketplaceId(entry.marketplace))
    .filter((entry) => {
      // 同一 id 可能同时出现在 available 与 restorable；先到先得，保持稳定。
      if (seen.has(entry.id)) return false;
      if (outcome.plugins.some((other) => other.enabled && other.name === entry.name && other.id !== entry.id))
        return false;
      seen.add(entry.id);
      return true;
    })
    .map((entry) => {
      const plugin = loaded.get(entry.id);
      const listing = entry.listing;
      const installed = Boolean(plugin) || entry.installed;
      const enabled = plugin?.enabled ?? false;
      return {
        pluginId: entry.id,
        name: entry.name,
        displayName: listing?.displayName,
        displayNameI18n: boundLocale(listing?.displayNameI18n),
        description: boundText(entry.description ?? plugin?.description),
        descriptionI18n: boundLocale(listing?.descriptionI18n),
        category: listing?.category,
        icon: listing?.icon,
        examplePrompts: [
          ...(listing?.examplePrompts ?? []),
          ...Object.values(listing?.examplePromptsI18n ?? {}).flat(),
        ]
          .slice(0, EXAMPLE_LIMIT)
          .map((text) => text.slice(0, 1_000)),
        installed,
        enabled,
        action: !installed ? ("install" as const) : enabled ? ("none" as const) : ("enable" as const),
        // 会话内确认只授权当前 workspace；user 级禁用与其他 workspace 覆盖保持不变。
        scope: "workspace" as const,
      } satisfies PluginDiscoveryCandidate;
    });
}

function marketplaceIdOf(pluginId: string): string {
  const at = pluginId.lastIndexOf("@");
  return at <= 0 ? "" : pluginId.slice(at + 1);
}

/**
 * 只复用既有插件 store 的读/写入口：安装走 `installZCodeMarketplacePlugin`，
 * 启用走 `setZCodePluginEnabled`，两者都在同一把插件存储锁内完成并复验。
 */
function applyPlugin(
  options: PluginDiscoveryStoreOptions,
  plugin: PluginDiscoveryCandidate,
  context: PluginDiscoveryContext,
): Promise<boolean> {
  const { configResult, pluginStorageRoot } = resolvePluginContext(options);
  return withPluginStorageLock(pluginStorageRoot, async () => {
      context.signal.throwIfAborted();
      const current = (
        await readCatalog({ ...options, configResult, pluginStorageRoot })
      ).find((entry) => entry.pluginId === plugin.pluginId);
      if (!current) throw new Error("plugin_no_longer_available");
      if (current.action === "none") return false;
      if (current.action !== plugin.action || current.scope !== plugin.scope)
        throw new Error("plugin_state_changed");
      if (current.action === "install") {
        const result = await installZCodeMarketplacePlugin({
          ...options,
          configResult,
          pluginStorageRoot,
          pluginName: current.name,
          marketplace: marketplaceIdOf(current.pluginId),
          scope: "user",
          abortSignal: context.signal,
        });
        const error = result.diagnostics.find((item) => item.severity === "error");
        if (error || result.installedPlugins.length === 0)
          throw new Error(error?.message ?? "plugin_install_empty");
      }
      try {
        // 旧流程只写 user 安装；workspace 残留 false 会压过它，确认同时授权当前 workspace 启用。
        await setZCodePluginEnabled({
          ...options,
          configResult,
          pluginStorageRoot,
          plugin: current.pluginId,
          enabled: true,
          scope: current.scope,
        });
      } catch (error) {
        if (current.action !== "install") throw error;
        throw new Error(
          `Plugin is installed, but could not enable it in this workspace: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      const installed = (
        await readCatalog({ ...options, configResult, pluginStorageRoot })
      ).find((entry) => entry.pluginId === current.pluginId);
      if (!installed?.installed || !installed.enabled) throw new Error("plugin_install_verification_failed");
      return true;
  });
}

/**
 * 激活事实只来自既有插件解析结果：安装落盘不等于本会话已经能用。
 * 会话未加载 → `refreshRequired`；本会话已加载且启用 → `ready`。
 */
function activationOf(
  options: PluginDiscoveryStoreOptions,
  pluginId: string,
): Promise<PluginActivationStatus> {
  return (async () => {
    const { configResult, pluginStorageRoot } = resolvePluginContext(options);
    const outcome = await resolveZCodePlugins({ ...options, configResult, pluginStorageRoot });
    const plugin = outcome.plugins.find((entry) => entry.id === pluginId);
    if (!plugin) return "refreshRequired";
    if (!plugin.enabled) return "disabled";
    const missingRequired = Object.entries(plugin.userConfig ?? {}).some(([key, option]) => {
      const value = plugin.configuredOptions?.[key] ?? option.default;
      return option.required === true && (value === undefined || value === "");
    });
    if (missingRequired) return "needsConfiguration";
    const loaded = options.loadedPluginIds?.();
    if (loaded && !loaded.has(pluginId)) return "refreshRequired";
    return "ready";
  })();
}

/**
 * 为一个 CLI/Host 会话装配插件发现端口。候选目录与写入口都是既有插件 store，
 * 这里只补上「搜索排序 / 分页 / 确认后重读 / 单飞去重」这些用例语义。
 */
export function createStorePluginDiscoveryPort(
  options: PluginDiscoveryStoreOptions,
): PluginDiscoveryPort {
  const { configResult, pluginStorageRoot } = resolvePluginContext(options);
  const refresh = options.refresh ?? officialPluginCatalogRefresh;
  const resolveOne = async (pluginId: string) =>
    (await readCatalog(options)).find((entry) => entry.pluginId === pluginId);
  return createPluginDiscoveryPort({
    list: () => readCatalog(options),
    resolve: resolveOne,
    refresh: async (request) => {
      const lastUpdated = (await getZCodePluginsOverview({ ...options, configResult, pluginStorageRoot }))
        .marketplaces.find((market) => isOfficialMarketplaceId(market.id))?.lastUpdated;
      return refresh.ensure(
        pluginStorageRoot,
        lastUpdated,
        async (signal) => {
          const result = await updateZCodePluginMarketplace({
            ...options,
            configResult,
            pluginStorageRoot,
            marketplace: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
            abortSignal: signal,
          });
          if (result.diagnostics.some((item) => item.severity === "error"))
            throw new Error("official_marketplace_refresh_failed");
        },
        request,
      );
    },
    apply: (plugin, context) => applyPlugin(options, plugin, context),
    activate: (pluginId) => activationOf(options, pluginId),
  });
}
