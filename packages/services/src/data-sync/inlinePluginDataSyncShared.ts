import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  getUserZcodePluginRoot,
  normalizePluginIdKey,
  readPluginManifestInfo,
  readUserPluginConfigState,
  type PluginManifestInfo,
} from "#src/plugin-sync/pluginSyncService.js";
import { hasSymlinkWithin, isPathWithin } from "./directoryContent.js";

/**
 * 插件目录内的 `data/` 是该端的运行数据：不导出、不参与签名和哈希，覆盖时保留目标端的 `data/`。
 * （CLI 运行时的插件数据目录在用户数据目录的 `cli/plugins/data/<id>`，不在插件目录里，本来就不会被同步触碰。）
 */
export const PLUGIN_DATA_DIRECTORY = "data";
export const INLINE_PLUGIN_CONTENT_OPTIONS = { excludeTopLevel: [PLUGIN_DATA_DIRECTORY] } as const;

export interface ResolvedInlinePlugin {
  key: string;
  manifest: PluginManifestInfo;
  /** plugins.dirs 中登记的路径（resolve 后，未取 realpath）；覆盖时替换这个位置。 */
  configuredPath: string;
  /** 内容根：configuredPath 的 realpath。 */
  contentRoot: string;
  enabled: boolean;
  options: Record<string, unknown>;
  /** 作为目标时不能被覆盖的原因。 */
  overwriteBlockedReason?: "external-directory" | "target-symlink";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function inlinePluginKey(manifest: PluginManifestInfo): string {
  return normalizePluginIdKey(manifest.pluginId);
}

/**
 * 按 `name@inline`（小写）对齐 plugins.dirs 中登记的 inline 插件；目录名只表示位置。
 * 同 id 重复时保留第一项，与 CLI 运行时「重复插件忽略」一致。
 */
export async function resolveInlinePlugins(): Promise<Map<string, ResolvedInlinePlugin>> {
  const config = await readUserPluginConfigState();
  const pluginRoot = getUserZcodePluginRoot();
  const result = new Map<string, ResolvedInlinePlugin>();
  for (const rawDir of config.dirs) {
    const configuredPath = resolve(rawDir);
    const contentRoot = await realpath(configuredPath).catch(() => null);
    if (!contentRoot) continue;
    const manifest = await readPluginManifestInfo(contentRoot);
    if (!manifest) continue;
    const key = inlinePluginKey(manifest);
    if (result.has(key)) continue;
    const overwriteBlockedReason = !isPathWithin(pluginRoot, configuredPath)
      ? ("external-directory" as const)
      : (await hasSymlinkWithin(pluginRoot, configuredPath))
        ? ("target-symlink" as const)
        : undefined;
    const options = config.options[manifest.pluginId];
    result.set(key, {
      key,
      manifest,
      configuredPath,
      contentRoot,
      enabled: config.enabledOverrides.get(key) ?? true,
      options: isRecord(options) ? options : {},
      ...(overwriteBlockedReason ? { overwriteBlockedReason } : {}),
    });
  }
  return result;
}
