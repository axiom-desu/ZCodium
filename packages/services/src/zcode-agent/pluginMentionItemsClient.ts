import {
  zcodePluginsMentionItemsParamsSchema,
  zcodePluginsMentionItemsResultSchema,
  zcodeProtocolMethods,
} from "@zcode/shared";
import type {
  ZCodeAgentPluginMentionItemsParams,
  ZCodeAgentPluginMentionItemsResult,
} from "./zcodeAgentPluginParams.js";

/** 首次调用可能在会话里等用户审批；用有界观察超时，不把单次查询升级为 workspace CLI 不可信。 */
const MENTION_ITEMS_TIMEOUT_MS = 10 * 60_000;

/** 最小只读请求面：与 `ZCodeProtocolClient.request` 对齐，便于真实 Client 与测试复用。 */
interface PluginMentionItemsRequester {
  request(
    method: string,
    params: unknown,
    schema: unknown,
    options?: { lifecycle?: "operation" | "observation"; timeoutMs?: number },
  ): Promise<unknown>;
}

function isMethodNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === -32601
  );
}

/**
 * App 侧 `plugins/mentionItems` 的唯一请求路径。
 *
 * - 只在调用方已取得的 existing-only client 上执行；本函数不启动/恢复会话。
 * - 旧 CLI 的 -32601 是能力缺失（`supported:false`），不是失败。
 * - 首次调用可能在会话里等用户审批，超时不能触发整个 workspace CLI 回收。
 */
export async function requestPluginMentionItems(
  client: PluginMentionItemsRequester,
  params: ZCodeAgentPluginMentionItemsParams,
): Promise<ZCodeAgentPluginMentionItemsResult> {
  const wire = zcodePluginsMentionItemsParamsSchema.parse({
    sessionId: params.sessionId,
    pluginId: params.pluginId,
    tool: params.tool,
    query: params.query,
  });
  try {
    const result = zcodePluginsMentionItemsResultSchema.parse(
      await client.request(
        zcodeProtocolMethods.pluginsMentionItems,
        wire,
        zcodePluginsMentionItemsResultSchema,
        {
          lifecycle: "observation",
          timeoutMs: MENTION_ITEMS_TIMEOUT_MS,
        },
      ),
    );
    return { supported: true, items: result.items };
  } catch (error) {
    if (isMethodNotFound(error)) return { supported: false };
    throw error;
  }
}
