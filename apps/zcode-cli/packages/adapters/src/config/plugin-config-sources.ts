// 插件配置的分层来源视图（`ConfigResult.sources.plugins`）。
//
// `options` 是每个键的胜出来源 scope（设置页徽标与 clear 可用性）；`optionLayers` 是原始层序，
// 敏感选项私有文件由 bootstrap 按这一层层叠加（spec: `.agents/specs/upstream-3.18-plugin-secrets.md`）。
import type { RuntimeConfigPatch } from "@zcode/contracts";
import type { ProjectConfigFile } from "./project-config.adapter.js";

// 修复：拆分仅为真实包内消费者开放结构，不能重新公开曾清理的无用 scope 名称。
type PluginConfigScope = "user" | "workspace";

/**
 * 一层插件 options 的原始视图：`path` 是该层配置文件，`workspaceRoot` 是该层配置文件的
 * baseDir（私有文件的 workspace 键按它匹配）。私有值按这一层层序叠加，与 `config.json` 的
 * 优先级一致。
 */
export interface PluginOptionLayer {
  scope: PluginConfigScope;
  path: string;
  workspaceRoot?: string;
  options: Record<string, Record<string, string | number | boolean>>;
}

export interface PluginConfigSources {
  dirs: {
    user: string[];
    workspace: string[];
  };
  enabled: Record<string, PluginConfigScope>;
  marketplaces: Record<string, PluginConfigScope>;
  options: Record<string, Record<string, PluginConfigScope>>;
  /**
   * 来自私有文件的键。投影必须继续隐藏这些键的实际值：清单把敏感键改回普通后，
   * 旧私有值仍可能生效，不能因为当前清单不再标 sensitive 就回显到 renderer/API。
   */
  secretKeys: Record<string, string[]>;
  /** 从低到高的原始层；敏感选项私有文件按它叠加。 */
  optionLayers: PluginOptionLayer[];
  paths: {
    user: string;
    workspace: string | undefined;
  };
}

export function resolvePluginConfigSources(input: {
  projectConfig: RuntimeConfigPatch;
  projectFiles: ProjectConfigFile[];
  projectPath: string | undefined;
  skipUserConfig: boolean;
  userConfig: RuntimeConfigPatch;
  userPath: string;
}): PluginConfigSources {
  const enabled: Record<string, PluginConfigScope> = {};
  const marketplaces: Record<string, PluginConfigScope> = {};
  const options: Record<string, Record<string, PluginConfigScope>> = {};

  for (const pluginId of Object.keys(input.userConfig.plugins?.enabledPlugins ?? {})) {
    enabled[pluginId] = "user";
  }
  for (const pluginId of Object.keys(input.projectConfig.plugins?.enabledPlugins ?? {})) {
    enabled[pluginId] = "workspace";
  }

  for (const marketplaceId of Object.keys(input.userConfig.plugins?.extraKnownMarketplaces ?? {})) {
    marketplaces[marketplaceId] = "user";
  }
  for (const [pluginId, pluginOptions] of Object.entries(input.userConfig.plugins?.options ?? {})) {
    options[pluginId] = {};
    for (const key of Object.keys(pluginOptions)) options[pluginId][key] = "user";
  }
  for (const [pluginId, pluginOptions] of Object.entries(
    input.projectConfig.plugins?.options ?? {},
  )) {
    const sourceByKey = (options[pluginId] ??= {});
    for (const key of Object.keys(pluginOptions)) sourceByKey[key] = "workspace";
  }

  return {
    dirs: {
      user: input.userConfig.plugins?.dirs ?? [],
      workspace: input.projectConfig.plugins?.dirs ?? [],
    },
    enabled,
    marketplaces,
    options,
    secretKeys: {},
    // 层序即合并顺序：user 最低，项目配置文件按发现顺序（外→内）。
    optionLayers: [
      ...(input.skipUserConfig
        ? []
        : [
            {
              scope: "user" as const,
              path: input.userPath,
              options: input.userConfig.plugins?.options ?? {},
            },
          ]),
      ...input.projectFiles.map((file) => ({
        scope: "workspace" as const,
        path: file.path,
        workspaceRoot: file.baseDir,
        options: file.config.plugins?.options ?? {},
      })),
    ],
    paths: {
      user: input.userPath,
      workspace: input.projectPath,
    },
  };
}
