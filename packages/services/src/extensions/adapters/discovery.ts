import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  EXTENSION_MAX_MANIFEST_BYTES,
  declaredCapabilityIds,
  validateExtensionManifest,
  type ExtensionManifest,
} from "@zcode/shared/extension-host";

/** 一个可启动的扩展；`dir` 只用于扩展进程加载 main，不进入 Renderer。 */
export interface DiscoveredExtension {
  dir: string;
  manifest: ExtensionManifest;
  capabilities: string[];
}

interface ExtensionDiscoveryResult {
  extensions: DiscoveredExtension[];
  /** 被拒绝的清单：只记录插件目录名与原因码，不记录清单内容。 */
  rejected: Array<{ directory: string; code: string }>;
}

/**
 * 发现扩展：`<pluginDir>/<folder>/extension.json`，严格校验并限制读取大小。
 * 无效清单不会激活，也不会被部分接受；发现阶段不执行任何插件代码。
 */
export async function discoverExtensions(pluginDir: string): Promise<ExtensionDiscoveryResult> {
  const result: ExtensionDiscoveryResult = { extensions: [], rejected: [] };
  let entries;
  try {
    entries = await readdir(pluginDir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const manifestPath = join(pluginDir, entry.name, "extension.json");
    let raw: string;
    try {
      const info = await stat(manifestPath);
      if (!info.isFile() || info.size > EXTENSION_MAX_MANIFEST_BYTES) {
        result.rejected.push({ directory: entry.name, code: "invalid-manifest" });
        continue;
      }
      raw = await readFile(manifestPath, "utf8");
    } catch {
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      result.rejected.push({ directory: entry.name, code: "invalid-manifest" });
      continue;
    }
    const validation = validateExtensionManifest(json);
    if (!validation.ok) {
      result.rejected.push({ directory: entry.name, code: validation.code });
      continue;
    }
    result.extensions.push({
      dir: join(pluginDir, entry.name),
      manifest: validation.manifest,
      capabilities: declaredCapabilityIds(validation.manifest),
    });
  }
  result.extensions.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  return result;
}
