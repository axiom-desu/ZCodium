import type { ConfigResult } from "@zcode/adapters/config";
import type { ResolveZCodePluginsOptions } from "./plugin-types.js";
import { join, resolve } from "node:path";
import { createConfig, normalizePluginConfigPathForComparison, resolvePath } from "@zcode/adapters/config";
import { getCliStorageRoot, getPluginStorageRoot } from "./app/paths.js";
import { resolvePluginSecretsPath, withPluginSecrets } from "./plugin-secrets.js";
export function resolvePluginContext(options: ResolveZCodePluginsOptions): {
  configResult: ConfigResult;
  pluginStorageRoot: string;
  workingDirectory: string;
} {
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
  const storageRoot = resolvePath(configResult.config.storage.dir);
  return {
    configResult,
    pluginStorageRoot:
      options.pluginStorageRoot ?? getPluginStorageRoot(getCliStorageRoot(storageRoot)),
    workingDirectory,
  };
}

/**
 * 叠加敏感插件选项私有文件后的配置视图。协议投影读 `optionSources` 必须用这一份，
 * 否则迁进私有文件的敏感键在设置页没有来源标记（scope 徽标与显式 clear 依赖它）。
 */
export async function resolvePluginConfigView(
  options: ResolveZCodePluginsOptions,
): Promise<ConfigResult> {
  const { configResult, pluginStorageRoot } = resolvePluginContext(options);
  const { configResult: withSecrets } = await withPluginSecrets(
    configResult,
    resolvePluginSecretsPath(pluginStorageRoot),
  );
  return withSecrets;
}

export function resolvePluginConfigPath(
  options: ResolveZCodePluginsOptions & { scope?: "user" | "workspace" },
  configResult: ConfigResult,
  workingDirectory: string,
): string {
  if (options.scope !== "workspace") {
    return configResult.sources.user.path;
  }

  // Workspace Plugin 配置固定落在当前 `<workspace>/.zcodium/config.json`。嵌套 workspace
  // 可能同时发现仓库根与自身的配置，读取端 innermost 优先；写入端也必须锁定当前
  // workspace，不能用 project discovery 的第一个 outermost 文件。
  const workspaceConfigPath = join(workingDirectory, ".zcodium", "config.json");
  const projectConfigPaths = [
    ...(options.projectConfigPath ? [options.projectConfigPath] : []),
    ...configResult.sources.project.paths,
  ];
  const existingWorkspaceConfig = projectConfigPaths.find(
    (path) =>
      normalizePluginConfigPathForComparison(path) ===
      normalizePluginConfigPathForComparison(workspaceConfigPath),
  );
  if (existingWorkspaceConfig) return existingWorkspaceConfig;
  return workspaceConfigPath;
}
