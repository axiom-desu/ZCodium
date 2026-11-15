// 会话选区引用 → 模型材料（上游 3.18.2 `helpers/conversation-quotes.ts` 的本仓子集）。
//
// 引用只在模型边界转为材料：canonical 用户正文保持原样，不能被引用内容污染，
// 也不能把引用里出现的 `/stop` 一类文本当成控制命令。
import type { TurnInputIntentMetadata } from "../deps.js";

const QUOTE_COMMENT_GUIDANCE =
  "Each conversation_quote item with a `comment` field is a user annotation on that exact quoted text: treat the comment as the user's question or instruction about that passage. An `agent` field names the subagent that produced the quoted text.";

/**
 * 把选区引用附在正文之后；没有引用时原样返回，保证旧会话字节不变。
 * 纯函数：不修改传入数组，不读写会话状态，不做 IO。
 */
export function withConversationQuotes(
  text: string,
  quotes: TurnInputIntentMetadata["conversationQuotes"],
): string {
  const parts = [text];
  if (quotes?.length)
    parts.push(`<conversation_quote>\n${JSON.stringify(quotes)}\n</conversation_quote>`);
  // 批注只是 JSON 字段时，模型容易把它当成引用原文的一部分；单独说明它是用户针对该段的要求。
  if (quotes?.some((quote) => quote.comment?.trim())) parts.push(QUOTE_COMMENT_GUIDANCE);
  return parts.filter(Boolean).join("\n\n");
}
