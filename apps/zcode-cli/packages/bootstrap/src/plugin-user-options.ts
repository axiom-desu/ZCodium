// 本插件 user 层设置读口：扩展/Host 读取「自己这个插件」在用户层的有效值（含敏感值）。
// 规格：`.agents/specs/upstream-3.18-plugin-secrets.md` §6。
//
// 边界：
// - 只给 runtime/受信任宿主用，不注册为协议方法，不进模型可见工具，不打印值；
// - 只取 user 视图（不加载任何项目配置层），因此跨 workspace 的私有值不会出现；
// - 只按参数里的 pluginId 取该插件，调用方不能借它读其他插件的值。
import type { PluginMetadata, PluginOptionValues } from "@zcode/contracts";
import type { ResolveZCodePluginsOptions } from "./plugin-types.js";
import { resolveZCodePlugins } from "./plugins.js";

const PLUGIN_USER_OPTIONS_PLUGIN_NOT_FOUND = "plugin_not_found";
const PLUGIN_USER_OPTIONS_FORBIDDEN = "plugin_user_options_forbidden";

class PluginUserOptionsError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PluginUserOptionsError";
  }
}

interface ReadPluginUserOptionsOptions extends ResolveZCodePluginsOptions {
  pluginId: string;
  /**
   * 受信任接线确定的调用方插件 id（不得取自插件可控 payload）。必须提供且与 pluginId 相同，
   * 防止这个读口退化成跨插件秘密读取或通用 renderer 密钥口。
   */
  consumerPluginId: string;
}

/**
 * 返回该插件 user 层的有效值（manifest 默认值 + 用户层已配置值，含敏感值）。
 * 插件不存在时抛 `plugin_not_found`；workspace 层的值永远不进入结果。
 */
export async function readPluginUserOptions(
  options: ReadPluginUserOptionsOptions,
): Promise<{ values: PluginOptionValues }> {
  if (options.consumerPluginId !== options.pluginId) {
    throw new PluginUserOptionsError(
      PLUGIN_USER_OPTIONS_FORBIDDEN,
      "A plugin can only read its own user options",
    );
  }
  const outcome = await resolveZCodePlugins({
    env: options.env,
    logger: options.logger,
    officialPluginRoots: options.officialPluginRoots,
    pluginStorageRoot: options.pluginStorageRoot,
    skipUserConfig: options.skipUserConfig,
    userConfigPath: options.userConfigPath,
    // user 视图：不传 workingDirectory/projectConfigPath 即不加载任何项目配置层。
  });
  const plugin = outcome.plugins.find((item) => item.id === options.pluginId);
  if (!plugin) {
    throw new PluginUserOptionsError(
      PLUGIN_USER_OPTIONS_PLUGIN_NOT_FOUND,
      `Plugin not installed: ${options.pluginId}`,
    );
  }
  return { values: { ...readUserConfigDefaults(plugin), ...plugin.configuredOptions } };
}

function readUserConfigDefaults(plugin: PluginMetadata): PluginOptionValues {
  const defaults: PluginOptionValues = {};
  for (const [key, option] of Object.entries(plugin.userConfig ?? {})) {
    if (option.default !== undefined) defaults[key] = option.default;
  }
  return defaults;
}
