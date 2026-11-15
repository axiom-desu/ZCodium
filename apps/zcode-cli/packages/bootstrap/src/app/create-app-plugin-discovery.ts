import type { PluginDiscoveryPort } from "@zcode/contracts";
import type { ZCodeAppOptions } from "./types.js";
import type { AppDependencies } from "./create-app-dependencies.js";
import { createStorePluginDiscoveryPort } from "../plugin-discovery-store.js";

/**
 * 为一个 App 会话装配插件发现端口。
 *
 * 目录与写入口都是本进程既有的插件 store（同一 storageRoot、同一把存储锁），因此不需要
 * 第二份目录缓存；`loadedPluginIds` 只说「本会话已加载了哪些插件」，用于把「已装但本会话
 * 还没加载」回答成 `refreshRequired`，而不是假装 ready。
 */
export function resolveAppPluginDiscoveryPort(
  options: ZCodeAppOptions,
  deps: Pick<AppDependencies, "configResult" | "pluginOutcome" | "logger">,
  input: { workingDirectory: string },
): PluginDiscoveryPort {
  if (options.pluginDiscoveryPort) return options.pluginDiscoveryPort;
  // 只在本进程有插件解析结果的会话上装配；缺席即工具不注册（fail closed，不造空目录）。
  const loaded = new Set(deps.pluginOutcome.plugins.map((plugin) => plugin.id));
  return createStorePluginDiscoveryPort({
    configResult: deps.configResult,
    env: options.env,
    logger: deps.logger,
    pluginStorageRoot: options.pluginStorageRoot,
    projectConfigPath: options.projectConfigPath,
    skipUserConfig: options.skipUserConfig,
    userConfigPath: options.userConfigPath,
    workingDirectory: input.workingDirectory,
    loadedPluginIds: () => loaded,
  });
}
