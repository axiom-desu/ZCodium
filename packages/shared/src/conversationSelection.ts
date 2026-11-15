// 会话选区引用（上游 3.18 `packages/shared/src/conversationSelection.ts`）。
//
// 结构化的“选中哪段历史 / 用户对该段的批注”作为一次用户输入的 metadata 传输，
// 不再写进可见正文：正文属于用户自己，引用属于模型材料。
// 这里只放线格式与上限；渲染到模型边界由 CLI core 的 `withConversationQuotes` 负责，
// UI 侧选择器自己的锚点（sourceSessionId / sourceRowId）不跨进程传输。
import { z } from "zod";

const CONVERSATION_SELECTION_MAX_TEXT_LENGTH = 8_000;
const CONVERSATION_SELECTION_MAX_COUNT = 8;
const CONVERSATION_SELECTION_MAX_TOTAL_LENGTH = 16_000;
const CONVERSATION_SELECTION_MAX_COMMENT_LENGTH = 2_000;
const CONVERSATION_SELECTION_MAX_AGENT_LENGTH = 200;

export const conversationQuoteSchema = z
  .object({
    text: z.string().max(CONVERSATION_SELECTION_MAX_TEXT_LENGTH),
    path: z.string().optional(),
    senderName: z.string().optional(),
    senderId: z.string().optional(),
    messageId: z.string().optional(),
    sentAt: z.string().datetime({ offset: true }).optional(),
    /** 用户对这段选区的批注；只有“批注”动作写入，普通引用缺省。 */
    comment: z.string().max(CONVERSATION_SELECTION_MAX_COMMENT_LENGTH).optional(),
    /** 选区来自子 agent 输出时记录 agent 类型，让模型区分主对话与子 agent 的回答。 */
    agent: z.string().max(CONVERSATION_SELECTION_MAX_AGENT_LENGTH).optional(),
    // 与上游差异（有意）：这里 strict，未声明字段不能借选区通道混进模型材料。
  })
  .strict();

export const conversationQuotesSchema = z
  .array(conversationQuoteSchema)
  .max(CONVERSATION_SELECTION_MAX_COUNT)
  .refine(
    (quotes) =>
      quotes.reduce((sum, quote) => sum + quote.text.length, 0) <=
      CONVERSATION_SELECTION_MAX_TOTAL_LENGTH,
  );
