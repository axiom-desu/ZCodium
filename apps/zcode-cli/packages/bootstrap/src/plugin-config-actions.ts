import { resolveZCodePlugins } from "./plugins.js";
import type {
  ConfigureZCodePluginOptions,
  DescribeZCodePluginOptions,
  ResetZCodePluginConfigOptions,
  SetZCodePluginEnabledOptions,
  SetZCodePluginEnabledResult,
  ValidateZCodePluginOptions,
} from "./plugin-types.js";
import { toPluginDiagnostic } from "./plugin-data.js";
import type { DescribeMarketplacePluginResult } from "@zcode/adapters/plugins";
import { resolvePluginContext, resolvePluginConfigPath } from "./plugin-context.js";
import {
  normalizePluginOptions,
  normalizePluginOptionKeys,
  resolvePluginSelector,
} from "./plugin-data.js";
import { resolve } from "node:path";
import {
  createConfig,
  removePluginEnabledFromFileConfig,
  removePluginFromFileConfig,
  updatePluginEnabledInFileConfig,
  updatePluginOptionsInFileConfig,
} from "@zcode/adapters/config";
import {
  describeMarketplacePlugin,
  ensureMarketplaceManifestAvailable,
  parseMarketplaceSourceInput,
  validateMarketplacePlugin,
  validateMarketplaceSource,
} from "@zcode/adapters/plugins";
import type { PluginLoadOutcome } from "@zcode/contracts";
export async function setZCodePluginEnabled(
  options: SetZCodePluginEnabledOptions,
): Promise<SetZCodePluginEnabledResult> {
  const workingDirectory = resolve(options.workingDirectory ?? process.cwd());
  const configResult =
    options.configResult ??
    createConfig({
      env: options.env,
      projectConfigPath: options.projectConfigPath,
      workingDirectory,
      skipUserConfig: options.skipUserConfig,
      userConfigPath: options.userConfigPath,
    });
  const outcome = resolveZCodePlugins({
    ...options,
    configResult,
    workingDirectory,
  });
  const plugin = resolvePluginSelector(options.plugin, outcome.plugins);
  const patch = await updatePluginEnabledInFileConfig(
    resolvePluginConfigPath(options, configResult, workingDirectory),
    plugin.id,
    options.enabled,
  );

  return {
    enabled: patch.enabled,
    path: patch.path,
    plugin: {
      ...plugin,
      enabled: patch.enabled,
    },
  };
}

export async function configureZCodePlugin(options: ConfigureZCodePluginOptions): Promise<void> {
  const normalizedOptions = normalizePluginOptions(options.options);
  const clearOptionKeys = normalizePluginOptionKeys(options.clearOptionKeys);
  const { configResult, pluginStorageRoot, workingDirectory } = resolvePluginContext(options);
  const outcome = resolveZCodePlugins({
    ...options,
    configResult,
    pluginStorageRoot,
    workingDirectory,
  });
  const plugin = resolvePluginSelector(options.pluginId, outcome.plugins);
  if (options.dryRun === true) return;
  await updatePluginOptionsInFileConfig(
    resolvePluginConfigPath(options, configResult, workingDirectory),
    plugin.id,
    normalizedOptions,
    clearOptionKeys,
  );
}

/** 删除指定 scope 的 Plugin 配置键，使 Workspace scope 回退到 User。 */
export async function resetZCodePluginConfig(
  options: ResetZCodePluginConfigOptions,
): Promise<{ path: string; pluginId: string }> {
  const { configResult, workingDirectory } = resolvePluginContext(options);
  const path = resolvePluginConfigPath(options, configResult, workingDirectory);
  if (options.scope === "workspace") {
    // “恢复继承”只删除 Workspace 的 enable override。options 是独立配置维度，
    // 不能因为用户恢复开关继承而把 Workspace options/secret 一并抹掉。
    await removePluginEnabledFromFileConfig(path, options.pluginId);
  } else {
    await removePluginFromFileConfig(path, options.pluginId);
  }
  return { path, pluginId: options.pluginId };
}

export async function validateZCodePlugin(
  options: ValidateZCodePluginOptions,
): Promise<PluginLoadOutcome["diagnostics"]> {
  const { pluginStorageRoot } = resolvePluginContext(options);
  if (options.source) {
    try {
      const source = await parseMarketplaceSourceInput(options.source);
      return (
        await validateMarketplaceSource({
          source,
          storageRoot: pluginStorageRoot,
        })
      ).map(toPluginDiagnostic);
    } catch (error) {
      return [
        {
          code: "plugin_marketplace_invalid",
          message: error instanceof Error ? error.message : String(error),
          severity: "error",
        },
      ];
    }
  }
  if (options.marketplace && options.pluginName) {
    try {
      await ensureMarketplaceManifestAvailable({
        marketplace: options.marketplace,
        storageRoot: pluginStorageRoot,
      });
    } catch (error) {
      return [
        {
          code: "plugin_marketplace_invalid",
          message: error instanceof Error ? error.message : String(error),
          pluginId: `${options.pluginName}@${options.marketplace}`,
          severity: "error",
        },
      ];
    }
    return (
      await validateMarketplacePlugin({
        marketplace: options.marketplace,
        name: options.pluginName,
        storageRoot: pluginStorageRoot,
      })
    ).map(toPluginDiagnostic);
  }
  return [];
}

export async function describeZCodePlugin(
  options: DescribeZCodePluginOptions,
): Promise<DescribeMarketplacePluginResult> {
  const { pluginStorageRoot } = resolvePluginContext(options);
  return describeMarketplacePlugin({
    marketplace: options.marketplace,
    name: options.pluginName,
    storageRoot: pluginStorageRoot,
    ...(options.withWriteLock ? { withWriteLock: options.withWriteLock } : {}),
  });
}
