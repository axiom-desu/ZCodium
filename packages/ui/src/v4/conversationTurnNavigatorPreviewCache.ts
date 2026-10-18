import type { AssistantTextRow, UserInputRow } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationTurnRenderUnit } from "./conversationTurnRenderUnits.js";
import type {
  BuildConversationTurnNavigatorItemsOptions,
  ConversationTurnNavigatorAssistantPreviewKind,
} from "./conversationTurnNavigatorHelpers.js";

type Options = Required<BuildConversationTurnNavigatorItemsOptions>;
type AssistantPreview = Readonly<{
  assistantPreview: string;
  assistantPreviewKind: ConversationTurnNavigatorAssistantPreviewKind;
}>;

/** 仅属当前 Navigator 的可丢弃派生值；不拥有会话事实。 */
export class ConversationTurnNavigatorPreviewCache {
  private options?: Options;
  private userPreviews = new WeakMap<UserInputRow, string>();
  private readonly assistantPreviews = new Map<
    string,
    {
      rows: readonly AssistantTextRow[];
      isRunning: boolean;
      preview: AssistantPreview;
    }
  >();
  private readonly usedTurns = new Set<string>();

  beginBuild(options: Options): void {
    this.usedTurns.clear();
    const previous = this.options;
    if (
      previous &&
      previous.assistantEmptyPreview === options.assistantEmptyPreview &&
      previous.assistantRunningPreview === options.assistantRunningPreview &&
      previous.userFallbackPreview === options.userFallbackPreview &&
      Object.is(previous.maxPreviewChars, options.maxPreviewChars) &&
      Object.is(previous.maxPreviewParagraphs, options.maxPreviewParagraphs)
    )
      return;
    this.options = { ...options };
    this.userPreviews = new WeakMap();
    this.assistantPreviews.clear();
  }

  userPreview(row: UserInputRow, create: () => string): string {
    const cached = this.userPreviews.get(row);
    if (cached !== undefined) return cached;
    const preview = create();
    this.userPreviews.set(row, preview);
    return preview;
  }

  assistantPreview(
    unit: ConversationTurnRenderUnit,
    create: () => AssistantPreview,
  ): AssistantPreview {
    this.usedTurns.add(unit.key);
    const cached = this.assistantPreviews.get(unit.key);
    // turn builder 可重建 unit/数组但复用不可变 row；按 unit 引用缓存会漏掉计时帧。
    if (
      cached &&
      cached.isRunning === unit.isRunning &&
      cached.rows.length === unit.assistantTextRows.length &&
      cached.rows.every((row, index) => row === unit.assistantTextRows[index])
    )
      return cached.preview;
    const preview = create();
    this.assistantPreviews.set(unit.key, {
      rows: unit.assistantTextRows,
      isRunning: unit.isRunning,
      preview,
    });
    return preview;
  }

  finishBuild(): void {
    // 快照替换/删除/过滤后不继续强持有旧行；用户摘要的 WeakMap 不延长行的生命周期。
    for (const key of this.assistantPreviews.keys()) {
      if (!this.usedTurns.has(key)) this.assistantPreviews.delete(key);
    }
  }
}
