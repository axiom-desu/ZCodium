interface PreviewOptions {
  texts: Iterable<string>;
  fallback: string;
  maxPreviewChars: number;
  maxPreviewParagraphs: number;
}

function truncatePreview(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 3).trimEnd()}...`;
}

export function buildConversationTurnNavigatorPreview({
  texts,
  fallback,
  maxPreviewChars,
  maxPreviewParagraphs,
}: PreviewOptions): string {
  // 原 slice 的段数会取整；NaN 产生空段列表，不能误当成无限段数。
  const paragraphLimit = Math.trunc(Math.max(1, maxPreviewParagraphs));
  if (!paragraphLimit) return fallback;
  const charLimit = Math.max(8, maxPreviewChars);
  const result: string[] = [];
  let length = 0;
  let paragraphs = 0;
  let pendingWhitespace = false;
  let pendingNewlines = 0;
  let firstSource = true;

  // 旧实现先 join/规范化全部正文再截短；仅消费能确定预览的前缀，避免流式更新
  // 重扫长历史。空白必须等后续正文出现才提交，否则会误判末尾空白为截断。
  for (const text of texts) {
    if (!firstSource) {
      pendingWhitespace = true;
      pendingNewlines = 2; // texts.join("\n\n") 的逻辑分隔符，不复制正文。
    }
    firstSource = false;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      const whitespace =
        code === 32 || (code >= 9 && code <= 13) || (code > 127 && /\s/u.test(text[index]!));
      if (whitespace) {
        pendingWhitespace = true;
        if (code === 10) pendingNewlines = Math.min(2, pendingNewlines + 1);
        continue;
      }
      if (paragraphs === 0) {
        paragraphs = 1;
      } else if (pendingWhitespace) {
        if (pendingNewlines >= 2) {
          if (paragraphs >= paragraphLimit) return result.join("");
          paragraphs++;
          result.push("\n");
        } else {
          result.push(" ");
        }
        length++;
      }
      pendingWhitespace = false;
      pendingNewlines = 0;
      result.push(text[index]!);
      length++;
      // UTF-16 长度/slice 与原规则一致，包括 NaN 和分数上限。
      if (Number.isNaN(charLimit) || length > charLimit) {
        return truncatePreview(result.join(""), charLimit);
      }
    }
  }
  return paragraphs === 0 ? fallback : result.join("");
}
