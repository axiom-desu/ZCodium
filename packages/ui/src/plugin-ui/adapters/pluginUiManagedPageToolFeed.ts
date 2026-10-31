import type { PluginUiHostController } from "@/plugin-ui/app/pluginUiHostController.js";
import type { UsePluginUiHostInput } from "@/plugin-ui/adapters/pluginUiHostTypes.js";

type ToolFeedInput = Pick<
  UsePluginUiHostInput,
  "toolCallId" | "toolInput" | "toolResult" | "toolCancelled"
>;

/** 同一 page 只投喂变化过的工具数据；多锚点/后台结果不能重复通知。 */
export function createPluginUiToolFeed() {
  let lastFeed = "";
  return (controller: PluginUiHostController | null, next: ToolFeedInput): void => {
    const feed = JSON.stringify([
      next.toolCallId,
      next.toolInput,
      next.toolResult,
      next.toolCancelled,
    ]);
    if (feed === lastFeed) return;
    lastFeed = feed;
    if (next.toolInput) controller?.notifyToolInput({ arguments: next.toolInput });
    if (next.toolResult) controller?.notifyToolResult(next.toolResult);
    if (next.toolCancelled) controller?.notifyToolCancelled();
  };
}
