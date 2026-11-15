import type { ExtensionGrantRecord, ExtensionManifest } from "@zcode/shared/extension-host";
import type { ExtensionPluginState } from "../contract.js";
import { resolveGrantState, resolveInactiveGrantState, type DeclaredPlugin } from "./grantState.js";

/** app 层只需要的发现结果形状；不反向依赖 adapters。 */
export interface ProjectedExtension {
  manifest: ExtensionManifest;
  capabilities: string[];
}

/** 从「已发现清单 + 用户记录」派生稳定的插件投影；不持有第二份授权状态。 */
export function buildPluginStates(
  loaded: readonly ProjectedExtension[],
  records: readonly ExtensionGrantRecord[] | null,
  declaredPlugin: (extension: ProjectedExtension) => DeclaredPlugin,
): ExtensionPluginState[] {
  const result: ExtensionPluginState[] = [];
  for (const extension of loaded) {
    const record = (records ?? []).find((item) => item.pluginId === extension.manifest.id);
    const state = resolveGrantState(declaredPlugin(extension), record);
    result.push({
      ...state,
      version: extension.manifest.version,
      capabilities: extension.capabilities,
      protocols: extension.manifest.protocols,
    });
  }
  for (const record of records ?? []) {
    if (loaded.some((extension) => extension.manifest.id === record.pluginId)) continue;
    result.push({
      ...resolveInactiveGrantState(record.pluginId, record),
      version: record.consentVersion,
      capabilities: [],
      protocols: {},
    });
  }
  return result;
}
