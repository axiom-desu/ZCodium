import { PLUGIN_UI_CARD_DEFAULT_HEIGHT_PX } from "../contract.js";
import type { UsePluginUiHostResult } from "./pluginUiHostTypes.js";

/** 页面快照的唯一可变副本；订阅者只读 store，patch 后统一通知。 */
export function createPluginUiPageSnapshot(input: { key: string; reload(): void; notify(): void }) {
  let snapshot: UsePluginUiHostResult = {
    pageKey: input.key,
    supported: true,
    phase: "idle",
    handle: null,
    height: PLUGIN_UI_CARD_DEFAULT_HEIGHT_PX,
    error: null,
    appCapabilities: undefined,
    reload: () => input.reload(),
  };
  return {
    read: () => snapshot,
    patch(value: Partial<UsePluginUiHostResult>) {
      snapshot = { ...snapshot, ...value };
      input.notify();
    },
  };
}
