import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { CANONICAL_CUA_PLUGIN_ID, LEGACY_CUA_PLUGIN_ID } from "./schema.js";
import { isRecord } from "./json-record.js";

export function migratePluginConfigInFile(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || !isRecord(value.plugins)) return undefined;
  const plugins = value.plugins;
  const nextPlugins = { ...plugins };
  let changed = false;

  if (isRecord(plugins.enabledPlugins)) {
    const enabledPlugins = { ...plugins.enabledPlugins };
    for (const [id, enabled] of Object.entries(plugins.enabledPlugins)) {
      if (id === LEGACY_CUA_PLUGIN_ID) {
        const canonicalId = CANONICAL_CUA_PLUGIN_ID;
        if (enabledPlugins[canonicalId] === undefined) enabledPlugins[canonicalId] = enabled;
        delete enabledPlugins[id];
        changed = true;
      }
    }
    if (changed) nextPlugins.enabledPlugins = enabledPlugins;
  }

  if (Array.isArray(plugins.suppressedBuiltins)) {
    const suppressedBuiltins = plugins.suppressedBuiltins.map((id) =>
      id === LEGACY_CUA_PLUGIN_ID ? CANONICAL_CUA_PLUGIN_ID : id,
    );
    if (JSON.stringify(suppressedBuiltins) !== JSON.stringify(plugins.suppressedBuiltins)) {
      nextPlugins.suppressedBuiltins = suppressedBuiltins;
      changed = true;
    }
  }

  if (isRecord(plugins.options)) {
    const options = { ...plugins.options };
    for (const [id, pluginOptions] of Object.entries(plugins.options)) {
      if (id === LEGACY_CUA_PLUGIN_ID) {
        const canonicalId = CANONICAL_CUA_PLUGIN_ID;
        if (options[canonicalId] === undefined) options[canonicalId] = pluginOptions;
        delete options[id];
        changed = true;
      }
    }
    if (changed) nextPlugins.options = options;
  }

  return changed ? { ...value, plugins: nextPlugins } : undefined;
}

export function persistPluginConfigMigration(
  filePath: string,
  value: Record<string, unknown>,
): void {
  const tempPath = `${filePath}.migrate.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    renameSync(tempPath, filePath);
  } catch {
    // 迁移写回是 best-effort 副作用，失败不能改变合法配置的装载语义。
    try {
      unlinkSync(tempPath);
    } catch {
      // 临时文件清理失败不影响当前配置装载。
    }
  }
}
