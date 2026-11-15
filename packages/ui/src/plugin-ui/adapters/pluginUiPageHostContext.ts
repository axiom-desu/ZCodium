import type { McpUiHostContext } from "@modelcontextprotocol/ext-apps/app-bridge";
import {
  buildPluginUiHostContext,
  type PluginUiHostContextInput,
} from "../domain/buildPluginUiHostContext.js";
import { readPluginUiStyleVariables } from "./readPluginUiStyleVariables.js";

/**
 * 宿主上下文只在主题/locale/展示模式/宽度/头部变化时重算；
 * 同一内容不重复推给页面，避免页面因 host-context-changed 抖动。
 */
export function createPluginUiPageHostContextUpdater(apply: (context: McpUiHostContext) => void) {
  let inputs = "";
  let last = "";
  return (next: PluginUiHostContextInput) => {
    const nextInputs = JSON.stringify([
      next.theme,
      next.locale,
      next.displayMode,
      next.width,
      next.titleBar,
      next.availableDisplayModes,
    ]);
    if (nextInputs === inputs) return;
    inputs = nextInputs;
    const context = buildPluginUiHostContext({
      ...next,
      styleVariables: readPluginUiStyleVariables(),
    });
    const contextKey = JSON.stringify(context);
    if (contextKey === last) return;
    last = contextKey;
    apply(context);
  };
}
