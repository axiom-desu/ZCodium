// App → CLI 的插件只读宿主查询（`plugins/mentionItems`）。
// 规格：`.agents/specs/upstream-3.18-agent-control.md`。App 与 CLI 共用这里的严格 schema。
import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);

/**
 * 稳定错误码。引用类（插件、工具找不到或不可调）用 JSON-RPC -32602；
 * 执行类（授权被拒、工具报错、结果不合 schema）用 -32000。
 */
export const ZCODE_PLUGIN_MENTION_ERROR_CODES = {
  pluginUnavailable: "plugin_mention_plugin_unavailable",
  toolNotFound: "plugin_mention_tool_not_found",
  toolNotAppVisible: "plugin_mention_tool_not_app_visible",
  /** 会话的 MCP App 授权链拒绝了这次调用（deny 规则、用户拒绝、hook 拒绝）。 */
  toolDenied: "plugin_mention_tool_denied",
  toolFailed: "plugin_mention_tool_failed",
  resultInvalid: "plugin_mention_result_invalid",
} as const;
export type ZCodePluginMentionErrorCode =
  (typeof ZCODE_PLUGIN_MENTION_ERROR_CODES)[keyof typeof ZCODE_PLUGIN_MENTION_ERROR_CODES];

export const ZCODE_PLUGIN_MENTION_LIMITS = {
  maxItems: 50,
  idMaxChars: 200,
  labelMaxChars: 120,
  descriptionMaxChars: 500,
  iconMaxChars: 100,
  insertTextMaxChars: 4000,
  queryMaxChars: 1000,
  toolNameMaxChars: 200,
} as const;

export const zcodePluginMentionItemSchema = z
  .object({
    id: z.string().min(1).max(ZCODE_PLUGIN_MENTION_LIMITS.idMaxChars),
    label: z.string().min(1).max(ZCODE_PLUGIN_MENTION_LIMITS.labelMaxChars),
    description: z.string().max(ZCODE_PLUGIN_MENTION_LIMITS.descriptionMaxChars).optional(),
    icon: z.string().min(1).max(ZCODE_PLUGIN_MENTION_LIMITS.iconMaxChars).optional(),
    // 选中后按原文插入提及块并随消息发给模型。
    insertText: z.string().min(1).max(ZCODE_PLUGIN_MENTION_LIMITS.insertTextMaxChars),
  })
  .strict();
export type ZCodePluginMentionItem = z.infer<typeof zcodePluginMentionItemSchema>;
export const zcodePluginMentionItemsSchema = z
  .array(zcodePluginMentionItemSchema)
  .max(ZCODE_PLUGIN_MENTION_LIMITS.maxItems);

export const zcodePluginsMentionItemsParamsSchema = z
  .object({
    sessionId: nonEmptyString,
    pluginId: nonEmptyString,
    /** 插件 MCP server 上的原始工具名，不是模型可见的 `mcp__…` 名。 */
    tool: nonEmptyString.max(ZCODE_PLUGIN_MENTION_LIMITS.toolNameMaxChars),
    /** `@` 后的输入，可以是空串。 */
    query: z.string().max(ZCODE_PLUGIN_MENTION_LIMITS.queryMaxChars),
  })
  .strict();
export type ZCodePluginsMentionItemsParams = z.infer<typeof zcodePluginsMentionItemsParamsSchema>;
export const zcodePluginsMentionItemsResultSchema = z
  .object({ items: zcodePluginMentionItemsSchema })
  .strict();
export type ZCodePluginsMentionItemsResult = z.infer<typeof zcodePluginsMentionItemsResultSchema>;
