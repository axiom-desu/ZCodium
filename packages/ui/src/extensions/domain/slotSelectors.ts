import type { ExtensionSlotId } from "@zcode/shared/extension-host";
import type { ExtensionsSnapshot } from "@zcode/services";
import type { ExtensionSlotViewState } from "../contract.js";

/** 纯选择器：从服务投影得到某个槽位的 UI 视图状态。 */
export function selectSlotView(
  snapshot: ExtensionsSnapshot | null,
  slot: ExtensionSlotId,
  options: { available: boolean; loading: boolean; error?: string },
): ExtensionSlotViewState {
  if (!options.available || !snapshot) {
    return {
      available: options.available,
      loading: options.loading,
      phase: snapshot?.phase ?? "stopped",
      slots: [],
      pending: [],
      canStart: false,
      ...(options.error ? { error: options.error } : {}),
    };
  }
  const generation = snapshot.generation;
  const slots = snapshot.slots.filter(
    (candidate) => candidate.slot === slot && candidate.generation === generation,
  );
  const pending = snapshot.plugins
    .filter((plugin) => plugin.status === "needs-consent")
    .map((plugin) => ({
      pluginId: plugin.pluginId,
      name: plugin.name,
      declared: plugin.granted.length > 0 ? plugin.granted : plugin.declared,
    }));
  return {
    available: true,
    loading: options.loading,
    phase: snapshot.phase,
    slots,
    pending,
    canStart:
      snapshot.phase === "stopped" || snapshot.phase === "error"
        ? Boolean(snapshot.workspaceIdentity)
        : false,
    ...(options.error ? { error: options.error } : {}),
  };
}

/** 槽位是否应当出现在导航/状态区：停止或没有贡献时隐藏，不占位。 */
export function isSlotVisible(view: ExtensionSlotViewState): boolean {
  return view.available && view.slots.length > 0;
}
