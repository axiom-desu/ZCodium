import {
  zcodePluginsConfigureParamsSchema,
  zcodePluginsResetConfigParamsSchema,
  zcodePluginsInstallParamsSchema,
  zcodePluginsMarketplaceAddParamsSchema,
  zcodePluginsMarketplaceRemoveParamsSchema,
  zcodePluginsMarketplaceUpdateParamsSchema,
  zcodePluginsOverviewParamsSchema,
  zcodePluginsListParamsSchema,
  zcodePluginsSetEnabledParamsSchema,
  zcodePluginsUninstallParamsSchema,
  zcodePluginsUpdateParamsSchema,
  zcodePluginsValidateParamsSchema,
  zcodePluginsDescribeParamsSchema,
  zcodePluginsRestoreBuiltinParamsSchema,
  type ZCodeInstalledPluginSummary,
  type ZCodePluginComponentGroup,
  type ZCodePluginDiagnostic,
  type ZCodePluginsConfigureResult,
  type ZCodePluginsDescribeResult,
  type ZCodePluginsInstallResult,
  type ZCodePluginsListResult,
  type ZCodePluginsMarketplaceMutationResult,
  type ZCodePluginsOverviewResult,
  type ZCodePluginsRestoreBuiltinResult,
  type ZCodePluginsSetEnabledResult,
  type ZCodePluginsUninstallResult,
  type ZCodePluginsValidateResult,
} from "@zcode/shared";
import {
  addZCodePluginMarketplace,
  configureZCodePlugin,
  describeZCodePlugin,
  getZCodePluginsOverview,
  installZCodeMarketplacePlugin,
  removeZCodePluginMarketplace,
  resolveZCodePlugins,
  resetZCodePluginConfig,
  restoreBuiltinPlugin as restoreBuiltinPluginCore,
  setZCodePluginEnabled,
  uninstallZCodeMarketplacePlugin,
  updateZCodePluginMarketplace,
  validateZCodePlugin,
} from "../plugins.js";
import { listInstalledPluginRecords } from "@zcode/adapters/plugins";
import { withPluginStorageLock } from "../lib/plugin-storage-lock.js";
import { getCliStorageRoot, getPluginStorageRoot } from "../app/paths.js";
import { createConfig, resolvePath, type ConfigResult } from "@zcode/adapters/config";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";
import {
  createMissingConfiguredPluginInfos,
  toAvailablePluginSummary,
  toInstalledPluginSummary,
  toMarketplaceSummary,
  toPluginDiagnostic,
  toPluginInfo,
} from "./plugin-protocol-projection.js";

function createPluginConfigView(
  context: ZCodeProtocolAgentServerContext,
  workspacePath: string,
  configScope: "user" | "workspace" | undefined,
): ConfigResult {
  // Settings 的 User 与 Workspace 现在是同一批 Host Plugin 的两个配置视图。
  // User 视图若继续加载 project config，会把 Workspace override 投影成 User 当前值；
  // 不传 workingDirectory 可保留 User/default 层，同时仍由调用方的 workspacePath 决定
  // package storage 和相对执行上下文。
  return createConfig({
    env: context.deps?.env,
    ...(configScope === "user" ? {} : { workingDirectory: workspacePath }),
  });
}

export async function listPlugins(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodePluginsListResult> {
  const params = parseParams(zcodePluginsListParamsSchema, rawParams);
  const configResult = createPluginConfigView(
    context,
    params.workspace.workspacePath,
    params.configScope,
  );
  const outcome = resolveZCodePlugins({
    configResult,
    logger: context.logger,
    workingDirectory: params.workspace.workspacePath,
  });
  const plugins = outcome.plugins.map((plugin) => toPluginInfo(plugin, configResult));
  return {
    plugins: [
      ...plugins,
      ...createMissingConfiguredPluginInfos(
        configResult,
        new Set(plugins.map((plugin) => plugin.id)),
      ),
    ],
    diagnostics: outcome.diagnostics.map(toPluginDiagnostic),
  };
}

export async function setPluginEnabled(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  abortSignal?: AbortSignal,
): Promise<ZCodePluginsSetEnabledResult> {
  const params = parseParams(zcodePluginsSetEnabledParamsSchema, rawParams);
  abortSignal?.throwIfAborted();
  const result = await setZCodePluginEnabled({
    enabled: params.enabled,
    logger: context.logger,
    plugin: params.pluginId,
    scope: params.scope,
    workingDirectory: params.workspace.workspacePath,
  });
  // 启用配置写入当前不可回滚；若取消在 IO 期间到达，只阻断后续响应和 UI 写入。
  abortSignal?.throwIfAborted();
  return {
    plugin: {
      ...toPluginInfo(result.plugin),
      enabledSource: params.scope ?? "user",
    },
    enabled: result.enabled,
  };
}

export async function getPluginsOverview(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodePluginsOverviewResult> {
  const params = parseParams(zcodePluginsOverviewParamsSchema, rawParams);
  const overview = getZCodePluginsOverview({
    configResult: createPluginConfigView(
      context,
      params.workspace.workspacePath,
      params.configScope,
    ),
    logger: context.logger,
    workingDirectory: params.workspace.workspacePath,
  });
  return {
    marketplaces: overview.marketplaces.map(toMarketplaceSummary),
    availablePlugins: overview.availablePlugins.map(toAvailablePluginSummary),
    installedPlugins: overview.installedPlugins.map(toInstalledPluginSummary),
    restorableBuiltins: overview.restorableBuiltins.map(toAvailablePluginSummary),
    diagnostics: overview.diagnostics.map(toPluginDiagnostic),
    capability: { supported: true },
  };
}

export async function addPluginMarketplace(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  abortSignal?: AbortSignal,
): Promise<ZCodePluginsMarketplaceMutationResult> {
  const params = parseParams(zcodePluginsMarketplaceAddParamsSchema, rawParams);
  const pluginStorageRoot = resolvePluginStorageRoot(params.workspace.workspacePath);
  const marketplace = await withPluginStorageLock(pluginStorageRoot, async () =>
    addZCodePluginMarketplace({
      abortSignal,
      dryRun: params.dryRun,
      logger: context.logger,
      source: params.source,
      workingDirectory: params.workspace.workspacePath,
    }),
  );
  return { marketplace: toMarketplaceSummary(marketplace), diagnostics: [] };
}

export async function removePluginMarketplace(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodePluginsMarketplaceMutationResult> {
  const params = parseParams(zcodePluginsMarketplaceRemoveParamsSchema, rawParams);
  const pluginStorageRoot = resolvePluginStorageRoot(params.workspace.workspacePath);
  await withPluginStorageLock(pluginStorageRoot, async () =>
    removeZCodePluginMarketplace({
      logger: context.logger,
      marketplace: params.marketplace,
      workingDirectory: params.workspace.workspacePath,
    }),
  );
  return { diagnostics: [] };
}

export async function updatePluginMarketplace(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  abortSignal?: AbortSignal,
): Promise<ZCodePluginsMarketplaceMutationResult> {
  const params = parseParams(zcodePluginsMarketplaceUpdateParamsSchema, rawParams);
  const pluginStorageRoot = resolvePluginStorageRoot(params.workspace.workspacePath);
  const result = await withPluginStorageLock(pluginStorageRoot, async () =>
    updateZCodePluginMarketplace({
      abortSignal,
      logger: context.logger,
      marketplace: params.marketplace,
      workingDirectory: params.workspace.workspacePath,
    }),
  );
  return {
    marketplaces: result.marketplaces.map(toMarketplaceSummary),
    diagnostics: result.diagnostics.map(toPluginDiagnostic),
  };
}

export async function installPlugin(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  abortSignal?: AbortSignal,
): Promise<ZCodePluginsInstallResult> {
  const params = parseParams(zcodePluginsInstallParamsSchema, rawParams);
  const pluginStorageRoot = resolvePluginStorageRoot(params.workspace.workspacePath);
  const result = await withPluginStorageLock(pluginStorageRoot, async () =>
    installZCodeMarketplacePlugin({
      abortSignal,
      dryRun: params.dryRun,
      logger: context.logger,
      marketplace: params.marketplace,
      pluginName: params.pluginName,
      scope: params.scope,
      workingDirectory: params.workspace.workspacePath,
    }),
  );
  return {
    dependencyClosure: result.dependencyClosure,
    installedPlugins: result.installedPlugins.map(toInstalledPluginSummary),
    diagnostics: result.diagnostics.map(toPluginDiagnostic),
  };
}

export async function uninstallPlugin(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodePluginsUninstallResult> {
  const params = parseParams(zcodePluginsUninstallParamsSchema, rawParams);
  const removed = await uninstallZCodeMarketplacePlugin({
    logger: context.logger,
    marketplace: params.marketplace,
    pluginId: params.pluginId,
    pluginName: params.pluginName,
    removeCache: params.removeCache,
    workingDirectory: params.workspace.workspacePath,
  });
  return {
    ...(removed ? { removedPlugin: toInstalledPluginSummary(removed) } : {}),
    diagnostics: [],
  };
}

export async function updatePlugin(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodePluginsInstallResult> {
  const params = parseParams(zcodePluginsUpdateParamsSchema, rawParams);
  const pluginStorageRoot = resolvePluginStorageRoot(params.workspace.workspacePath);
  const installed = listInstalledPluginRecords(pluginStorageRoot).filter((record) => {
    if (params.pluginId) return record.id === params.pluginId;
    if (params.marketplace) return record.marketplace === params.marketplace;
    return true;
  });
  // 与 uninstall 一样把整个重装循环串行化到同一 storageRoot 的 in-process 锁里，
  // 避免并发 update/install 交错读改写 installed_plugins.json / cache。
  return withPluginStorageLock(pluginStorageRoot, async () => {
    const installedPlugins: ZCodeInstalledPluginSummary[] = [];
    const dependencyClosure: string[] = [];
    // 聚合每条记录重装产生的诊断：installZCodeMarketplacePlugin 失败时不抛错，而是返回
    // CLI 形态的 PluginDiagnostic（见其错误分支的 toMarketplaceInstallDiagnostic），
    // 这里逐条经协议侧 toPluginDiagnostic 投影成 ZCodePluginDiagnostic 回传，
    // 让失败的重装显式暴露，而不是静默"成功"。
    const diagnostics: ZCodePluginDiagnostic[] = [];
    for (const record of installed) {
      const result = await installZCodeMarketplacePlugin({
        logger: context.logger,
        marketplace: record.marketplace,
        pluginName: record.name,
        scope: record.scope,
        workingDirectory: params.workspace.workspacePath,
      });
      installedPlugins.push(...result.installedPlugins.map(toInstalledPluginSummary));
      dependencyClosure.push(...result.dependencyClosure);
      diagnostics.push(...result.diagnostics.map(toPluginDiagnostic));
    }
    return { dependencyClosure, installedPlugins, diagnostics };
  });
}

// 恢复一个被抑制（"卸载"）的内置插件：清除 suppressedBuiltins 标记并立即重新 seed。
// bootstrap 侧的同名函数被别名为 restoreBuiltinPluginCore，避免与本协议处理器重名。
export async function restoreBuiltinPlugin(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodePluginsRestoreBuiltinResult> {
  const params = parseParams(zcodePluginsRestoreBuiltinParamsSchema, rawParams);
  await restoreBuiltinPluginCore({
    logger: context.logger,
    pluginId: params.pluginId,
    workingDirectory: params.workspace.workspacePath,
  });
  return { pluginId: params.pluginId, diagnostics: [] };
}

export async function configurePlugin(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodePluginsConfigureResult> {
  const params = parseParams(zcodePluginsConfigureParamsSchema, rawParams);
  await configureZCodePlugin({
    clearOptionKeys: params.clearOptionKeys,
    dryRun: params.dryRun,
    logger: context.logger,
    options: params.options,
    pluginId: params.pluginId,
    scope: params.scope,
    workingDirectory: params.workspace.workspacePath,
  });
  return { pluginId: params.pluginId, diagnostics: [] };
}

export async function resetPluginConfig(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodePluginsConfigureResult> {
  const params = parseParams(zcodePluginsResetConfigParamsSchema, rawParams);
  await resetZCodePluginConfig({
    logger: context.logger,
    pluginId: params.pluginId,
    scope: params.scope,
    workingDirectory: params.workspace.workspacePath,
  });
  return { pluginId: params.pluginId, diagnostics: [] };
}

export async function validatePlugin(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodePluginsValidateResult> {
  const params = parseParams(zcodePluginsValidateParamsSchema, rawParams);
  const pluginStorageRoot = resolvePluginStorageRoot(params.workspace.workspacePath);
  // validate 不是纯读取：未知市场会懒加载 manifest 并写 known/缓存，source 解析也可能 clone。
  // 因此保留整个写锁，不把它伪装成读路径；只有 describe 的已缓存/已装读取才免锁。
  const diagnostics = await withPluginStorageLock(pluginStorageRoot, async () =>
    validateZCodePlugin({
      logger: context.logger,
      marketplace: params.marketplace,
      pluginName: params.pluginName,
      source: params.source,
      workingDirectory: params.workspace.workspacePath,
    }),
  );
  return {
    ok: diagnostics.every((diagnostic) => diagnostic.severity !== "error"),
    diagnostics: diagnostics.map(toPluginDiagnostic),
    compatibility: {
      runnable: ["skills", "commands", "hooks", "mcpServers", "userConfig"],
      diagnosticOnly: ["agents", "lspServers", "outputStyles", "channels", "settings"],
      unsupported: ["mcpb", "dxt", "npm", "hostPattern", "pathPattern"],
    },
  };
}

export async function describePlugin(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodePluginsDescribeResult> {
  const params = parseParams(zcodePluginsDescribeParamsSchema, rawParams);
  const pluginStorageRoot = resolvePluginStorageRoot(params.workspace.workspacePath);
  // 已装目录、已缓存 manifest 与临时 source 解析都不持锁；只有懒加载 manifest 写入进锁。
  // 安装 A 下载期间打开 B 的详情不再排在 storage lock 队列里。
  const result = await describeZCodePlugin({
    logger: context.logger,
    marketplace: params.marketplace,
    pluginName: params.pluginName,
    withWriteLock: (write) => withPluginStorageLock(pluginStorageRoot, write),
    workingDirectory: params.workspace.workspacePath,
  });
  const components: ZCodePluginComponentGroup[] = result.components.map((group) => ({
    kind: group.kind,
    items: group.items.map((item) => ({
      name: item.name,
      ...(item.description ? { description: item.description } : {}),
    })),
  }));
  const diagnostics = result.diagnostics.map(toPluginDiagnostic);
  return {
    components,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
    ...(result.metadata ? { metadata: result.metadata } : {}),
  };
}

function resolvePluginStorageRoot(workingDirectory: string): string {
  const config = createConfig({ workingDirectory });
  const storageRoot = resolvePath(config.config.storage.dir);
  return getPluginStorageRoot(getCliStorageRoot(storageRoot));
}
