import type { UiLocale } from "@zcode/contracts";
import { canonicalizePluginId, pluginIdAliases } from "./schema.js";
import { isRecord } from "./json-record.js";

export function patchUiLocale(
  parsed: Record<string, unknown>,
  locale: UiLocale,
): Record<string, unknown> {
  const currentUi = isRecord(parsed.ui) ? parsed.ui : {};

  return {
    ...parsed,
    ui: {
      ...currentUi,
      locale,
    },
  };
}

export function patchPluginEnabled(
  parsed: Record<string, unknown>,
  pluginId: string,
  enabled: boolean,
): Record<string, unknown> {
  const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
  const enabledPlugins = isRecord(plugins.enabledPlugins) ? plugins.enabledPlugins : {};
  const canonicalPluginId = canonicalizePluginId(pluginId);
  const nextEnabledPlugins = { ...enabledPlugins };
  for (const id of pluginIdAliases(canonicalPluginId)) delete nextEnabledPlugins[id];

  return {
    ...parsed,
    plugins: {
      ...plugins,
      enabledPlugins: {
        ...nextEnabledPlugins,
        [canonicalPluginId]: enabled,
      },
    },
  };
}

export function patchPluginOptions(
  parsed: Record<string, unknown>,
  pluginId: string,
  options: Record<string, string | number | boolean>,
  clearOptionKeys: string[],
): Record<string, unknown> {
  const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
  const currentOptions = isRecord(plugins.options) ? plugins.options : {};
  const canonicalPluginId = canonicalizePluginId(pluginId);
  const aliases = pluginIdAliases(canonicalPluginId);
  const legacyPluginId = aliases.length > 1 ? aliases[1] : undefined;
  const currentPluginOptions = isRecord(currentOptions[canonicalPluginId])
    ? currentOptions[canonicalPluginId]
    : legacyPluginId && isRecord(currentOptions[legacyPluginId])
      ? currentOptions[legacyPluginId]
      : {};
  const nextOptions = { ...currentOptions };
  for (const id of aliases) delete nextOptions[id];
  const clearedOptionKeySet = new Set(clearOptionKeys);
  const retainedPluginOptions = Object.fromEntries(
    Object.entries(currentPluginOptions).filter(([key]) => !clearedOptionKeySet.has(key)),
  );

  return {
    ...parsed,
    plugins: {
      ...plugins,
      options: {
        ...nextOptions,
        // 敏感字段按脱敏合同不会回传 UI，二次保存普通字段时请求中自然缺少
        // 已存 secret。这里按 option key 合并，避免整对象替换把同 scope 的密钥静默清空。
        // 显式清除走 clearOptionKeys，先删除指定键，再合并本次输入；不会连带删除启用状态
        // 或同插件的其他配置。
        [canonicalPluginId]: {
          ...retainedPluginOptions,
          ...options,
        },
      },
    },
  };
}

export function patchPluginRemoved(
  parsed: Record<string, unknown>,
  pluginId: string,
): { next: Record<string, unknown>; removedEnabled: boolean; removedOptions: boolean } {
  const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
  const enabledPlugins = isRecord(plugins.enabledPlugins) ? plugins.enabledPlugins : {};
  const options = isRecord(plugins.options) ? plugins.options : {};
  const aliases = pluginIdAliases(pluginId);
  const removedEnabled = aliases.some((id) => id in enabledPlugins);
  const removedOptions = aliases.some((id) => id in options);
  if (!removedEnabled && !removedOptions) {
    return { next: parsed, removedEnabled, removedOptions };
  }

  const nextEnabled = { ...enabledPlugins };
  for (const id of aliases) delete nextEnabled[id];
  const nextOptions = { ...options };
  for (const id of aliases) delete nextOptions[id];

  return {
    next: {
      ...parsed,
      plugins: {
        ...plugins,
        enabledPlugins: nextEnabled,
        options: nextOptions,
      },
    },
    removedEnabled,
    removedOptions,
  };
}
