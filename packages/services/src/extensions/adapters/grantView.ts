import {
  normalizeGrants,
  type ExtensionGrant,
  type ExtensionGrantRecord,
} from "@zcode/shared/extension-host";
import { isGrantRunnable, resolveGrantState, type DeclaredPlugin } from "../app/grantState.js";
import type { ProjectedExtension } from "../app/projection.js";

/**
 * 授权视图：只把「已发现清单 + 已记录授予」解释为只读状态，不持有第二份授权状态。
 * 记录的唯一写入者仍是 adapters/service 的 grantStore；这里不做 IO。
 */
export function createGrantView(state: {
  loaded(): readonly ProjectedExtension[];
  records(): readonly ExtensionGrantRecord[] | null;
}) {
  function declaredPlugin(extension: ProjectedExtension): DeclaredPlugin {
    return {
      pluginId: extension.manifest.id,
      name: extension.manifest.name,
      version: extension.manifest.version,
      capabilities: extension.capabilities,
      slotIds: extension.manifest.slots.map((slot) => slot.id),
      protocols: extension.manifest.protocols,
      declared: normalizeGrants(extension.manifest.grants),
    };
  }

  function recordFor(pluginId: string): ExtensionGrantRecord | undefined {
    return (state.records() ?? []).find((item) => item.pluginId === pluginId);
  }

  function stateFor(extension: ProjectedExtension) {
    return resolveGrantState(declaredPlugin(extension), recordFor(extension.manifest.id));
  }

  /** 只有存在用户同意记录且与当前声明/版本一致时才允许加载插件代码。 */
  function isRunnable(extension: ProjectedExtension): boolean {
    return isGrantRunnable(stateFor(extension));
  }

  function consented(pluginId: string): boolean {
    const extension = state.loaded().find((item) => item.manifest.id === pluginId);
    return extension ? isRunnable(extension) : false;
  }

  function grantedFor(pluginId: string): ExtensionGrant[] {
    const extension = state.loaded().find((item) => item.manifest.id === pluginId);
    return extension ? stateFor(extension).granted : [];
  }

  return { declaredPlugin, recordFor, stateFor, isRunnable, consented, grantedFor };
}
