import { describe, expect, it } from "vitest";
import type { AssistantTextRow, UserInputRow } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";
import {
  buildConversationFindIndex,
  createConversationFindIndexBuilder,
  findConversationMatchIndexByKey,
  getConversationFindMatchKey,
  resolveConversationFindActiveIndex,
  resolveSearchResultHighlightMatch,
} from "@/v4/conversationFindIndex.js";

function userRow(rowId: number, text: string): UserInputRow {
  return { rowId, kind: "userInput", text } as unknown as UserInputRow;
}

function assistantRow(rowId: number, text: string, state = "complete"): AssistantTextRow {
  return { rowId, kind: "assistantText", text, state } as unknown as AssistantTextRow;
}

function unit(
  key: string,
  rows: { user?: UserInputRow[]; assistant?: AssistantTextRow[]; running?: boolean } = {},
): ConversationTurnRenderUnit {
  return {
    key,
    visibleUserInputs: rows.user ?? [],
    assistantTextRows: rows.assistant ?? [],
    latestAssistantTextRow: rows.assistant?.at(-1),
    isRunning: rows.running ?? false,
  } as unknown as ConversationTurnRenderUnit;
}

describe("conversationFindIndex", () => {
  it("保持大小写/空白归一化与匹配顺序", () => {
    const units = [
      unit("t1", { user: [userRow(1, "  Alpha BETA alpha  ")] }),
      unit("t2", { assistant: [assistantRow(2, "alpha")] }),
    ];
    const index = buildConversationFindIndex(units, " ALPHA ");
    expect(index.query).toBe("alpha");
    expect(index.matches.map((match) => [match.rowId, match.rowMatchIndex])).toEqual([
      [1, 0],
      [1, 1],
      [2, 0],
    ]);
    expect(index.matches.map((match) => match.globalIndex)).toEqual([0, 1, 2]);
    expect(index.matchCount).toBe(3);
    expect(index.loadedRowCount).toBe(2);
  });

  it("空查询只统计行数，不产生匹配", () => {
    const index = buildConversationFindIndex(
      [unit("t1", { user: [userRow(1, "a")], assistant: [assistantRow(2, "b")] })],
      "   ",
    );
    expect(index.matches).toEqual([]);
    expect(index.loadedRowCount).toBe(2);
  });

  it("builder 复用不可变 row 的投影与归一化文本", () => {
    let textReads = 0;
    const row = {
      rowId: 1,
      kind: "userInput",
      get text() {
        textReads += 1;
        return "Alpha alpha";
      },
    } as unknown as UserInputRow;
    const build = createConversationFindIndexBuilder();
    const units = [unit("t1", { user: [row] })];
    const first = build(units, "alpha");
    expect(first.matchCount).toBe(2);
    const readsAfterFirst = textReads;
    expect(readsAfterFirst).toBeGreaterThan(0);
    const second = build(units, "alp");
    expect(second.matchCount).toBe(2);
    // 第二次查询不再读 row.text（不重复投影/转小写）；匹配结果仍然正确。
    expect(textReads).toBe(readsAfterFirst);
  });

  it("active index 与 match key 保持稳定", () => {
    const index = buildConversationFindIndex(
      [unit("t1", { user: [userRow(1, "a"), userRow(2, "a")] })],
      "a",
    );
    expect(resolveConversationFindActiveIndex(index, 0)).toBe(0);
    expect(resolveConversationFindActiveIndex(index, 1)).toBe(1);
    expect(resolveConversationFindActiveIndex(index, 9)).toBe(0);
    expect(resolveConversationFindActiveIndex({ ...index, matchCount: 0 }, 0)).toBe(-1);
    expect(index.matches[resolveConversationFindActiveIndex(index, 1)]?.rowId).toBe(2);

    const key = getConversationFindMatchKey(index.matches[1]!);
    expect(key).toEqual({ rowId: 2, rowKind: "userInput", rowMatchIndex: 0 });
    expect(findConversationMatchIndexByKey(index, key)).toBe(1);
    expect(findConversationMatchIndexByKey(index, null)).toBe(-1);
  });

  it("搜索跳转按 snippet 命中，否则回退到 snippetIndex", () => {
    const index = buildConversationFindIndex(
      [unit("t1", { user: [userRow(1, "first snippet"), userRow(2, "second target")] })],
      "s",
    );
    const bySnippet = resolveSearchResultHighlightMatch(index, {
      query: "s",
      snippet: "...second tar...",
      snippetIndex: 0,
    } as Parameters<typeof resolveSearchResultHighlightMatch>[1]);
    expect(bySnippet?.rowId).toBe(2);
    const lastMatchIndex = index.matches.findLastIndex((match) => match.rowId === 2);
    const byIndex = resolveSearchResultHighlightMatch(index, {
      query: "s",
      snippet: "missing text",
      snippetIndex: lastMatchIndex,
    } as Parameters<typeof resolveSearchResultHighlightMatch>[1]);
    expect(byIndex?.rowId).toBe(2);
  });
});
