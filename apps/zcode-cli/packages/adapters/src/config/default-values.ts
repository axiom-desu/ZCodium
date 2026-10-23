import { ConfigKey, DefaultRuntimeConfig as DefaultConfig } from "@zcode/contracts";

// 默认值表与 ConfigPortImpl 的 getAll 分开维护：这里只回答
// “key 的默认值是什么”，不持有任何可变配置状态。
export function getDefaultValue(key: ConfigKey): unknown {
  const defaults = DefaultConfig;
  switch (key) {
    case ConfigKey.ModelStreamIdleTimeout:
      return defaults.modelStream.idleTimeoutMs;
    case ConfigKey.PermissionMode:
      return defaults.permission.mode;
    case ConfigKey.PermissionAllowedTools:
      return defaults.permission.allowedTools;
    case ConfigKey.PermissionDisallowedTools:
      return defaults.permission.disallowedTools;
    case ConfigKey.PermissionAutoApproveHighRisk:
      return defaults.permission.autoApproveHighRisk;
    case ConfigKey.PermissionAllowMediumRiskInAuto:
      return defaults.permission.allowMediumRiskInAuto;
    case ConfigKey.StorageDir:
      return defaults.storage.dir;
    case ConfigKey.StorageSessionDbPath:
      return defaults.storage.sessionDbPath;
    case ConfigKey.HttpProxy:
      return defaults.network.httpProxy;
    case ConfigKey.NoProxy:
      return defaults.network.noProxy;
    case ConfigKey.CaCertFile:
      return defaults.network.caCertFile;
    case ConfigKey.HttpTimeout:
      return defaults.network.timeout;
    case ConfigKey.FeatureCompact:
      return defaults.features.compact;
    case ConfigKey.FeatureRewind:
      return defaults.features.rewind;
    case ConfigKey.FeatureSubagent:
      return defaults.features.subagent;
    case ConfigKey.FeatureMemory:
      return defaults.features.memory;
    case ConfigKey.FeatureSkill:
      return defaults.features.skill;
    case ConfigKey.FeatureMcp:
      return defaults.features.mcp;
    case ConfigKey.MemoryUse:
      return defaults.memory.use;
    case ConfigKey.McpServers:
      return defaults.mcp.servers;
    case ConfigKey.PluginsEnabled:
      return defaults.plugins.enabled;
    case ConfigKey.PluginsDirs:
      return defaults.plugins.dirs;
    case ConfigKey.PluginsEnabledPlugins:
      return defaults.plugins.enabledPlugins;
    case ConfigKey.PluginsExtraKnownMarketplaces:
      return defaults.plugins.extraKnownMarketplaces;
    case ConfigKey.PluginsOptions:
      return defaults.plugins.options;
    case ConfigKey.PluginsSuppressedBuiltins:
      return defaults.plugins.suppressedBuiltins;
    case ConfigKey.SkillsEnabled:
      return defaults.skills.enabled;
    case ConfigKey.SkillsIncludeInstructions:
      return defaults.skills.includeInstructions;
    case ConfigKey.SkillsMetadataBudget:
      return defaults.skills.metadataBudget;
    case ConfigKey.SkillsRoots:
      return defaults.skills.roots;
    case ConfigKey.LogLevel:
      return defaults.logging.level;
    case ConfigKey.LogFormat:
      return defaults.logging.format;
    case ConfigKey.ToolConcurrencyMax:
      return defaults.toolConcurrency.maxConcurrency;
    case ConfigKey.ModelAnomalyGuard:
      return defaults.modelAnomalyGuard;
    case ConfigKey.Hooks:
      return defaults.hooks;
    case ConfigKey.UiLocale:
      return defaults.ui.locale;
    case ConfigKey.UiTheme:
      return defaults.ui.theme;
    default:
      return undefined;
  }
}

export function hasDefaultValue(key: ConfigKey): boolean {
  return getDefaultValue(key) !== undefined;
}
