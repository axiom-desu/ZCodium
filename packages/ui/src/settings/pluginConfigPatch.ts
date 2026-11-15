import type { ZCodePluginInfo, ZCodePluginUserConfigOption } from "@zcode/shared";

export type PluginOptionDraftValue = string | number | boolean | null;

/** 单个字段的显示态：值 + 是否「已保存但不回显」（敏感键）。 */
export interface PluginOptionDisplayState {
  hasStoredSecret: boolean;
  value: string | number | boolean;
}

/**
 * 当前表单应显示的值：显式 draft > 本 scope 回传的 effective 值 > manifest 默认值 > 类型默认。
 * 敏感键的 effective 值不会回传（私有存储不回显），因此已有值时得到空字符串 + `hasStoredSecret`。
 */
export function resolvePluginOptionValue(
  plugin: Pick<ZCodePluginInfo, "configuredOptions" | "optionSources">,
  key: string,
  option: ZCodePluginUserConfigOption,
  draft: PluginOptionDraftValue | undefined,
): PluginOptionDisplayState {
  if (draft === null) return { hasStoredSecret: false, value: "" };
  const value =
    draft ??
    plugin.configuredOptions?.[key] ??
    option.default ??
    (option.type === "boolean" ? false : "");
  return {
    // 敏感值有来源标记却没有回传值：说明它已保存在私有存储里，只是不回显。
    hasStoredSecret:
      option.sensitive === true &&
      plugin.optionSources?.[key] !== undefined &&
      plugin.configuredOptions?.[key] === undefined &&
      value === "",
    value,
  };
}

interface PluginConfigPatch {
  options: Record<string, string | number | boolean>;
  clearOptionKeys: string[];
}

/**
 * 构造 Plugin 配置写入 patch。
 *
 * `configuredOptions` 是当前 scope 的 effective 值，不能在保存时当作整份 draft
 * 写回；否则 Workspace 页面只修改一个字段，也会把 User/default 的其它字段固化成
 * Workspace override。只有明确产生 draft 的字段才属于本次写入。
 */
export function buildPluginConfigPatch(
  plugin: Pick<ZCodePluginInfo, "userConfig">,
  drafts: Record<string, PluginOptionDraftValue | undefined>,
): PluginConfigPatch {
  const options: Record<string, string | number | boolean> = {};
  const clearOptionKeys: string[] = [];

  for (const [key, option] of Object.entries(plugin.userConfig ?? {}) as [
    string,
    ZCodePluginUserConfigOption,
  ][]) {
    const draft = drafts[key];
    if (draft === undefined) continue;
    if (draft === null) {
      clearOptionKeys.push(key);
      continue;
    }

    // Sensitive 的空字符串仍表示“不修改已有值”，只有 null 才是显式清除。
    if (option.sensitive && draft === "") continue;

    if (option.type === "number") {
      const numeric = typeof draft === "number" ? draft : Number(draft);
      if (Number.isFinite(numeric)) options[key] = numeric;
      continue;
    }
    options[key] = draft;
  }

  return { options, clearOptionKeys };
}
