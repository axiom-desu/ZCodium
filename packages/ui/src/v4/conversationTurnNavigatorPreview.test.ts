import { describe, expect, it } from "vitest";
import type { AssistantTextRow, ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  buildConversationTurnRenderUnits,
  type ConversationTurnRenderUnit,
} from "./conversationTurnRenderUnits.js";
import {
  buildConversationTurnNavigatorItems,
  type BuildConversationTurnNavigatorItemsOptions,
} from "./conversationTurnNavigatorHelpers.js";
import { buildConversationTurnNavigatorPreview } from "./conversationTurnNavigatorPreview.js";
import { ConversationTurnNavigatorPreviewCache } from "./conversationTurnNavigatorPreviewCache.js";

const options: BuildConversationTurnNavigatorItemsOptions = {
  assistantEmptyPreview: "empty",
  assistantRunningPreview: "running",
  userFallbackPreview: "question",
};

// 优化前的 join/正则流水线作为独立 oracle，不让扫描器与测试共享实现。
function referencePreview(
  texts: string[],
  fallback = "fallback",
  maxChars = 220,
  maxParagraphs = 2,
) {
  const paragraphs = texts
    .join("\n\n")
    .trim()
    .split(/\n\s*\n/u)
    .map((p) => p.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .slice(0, Math.max(1, maxParagraphs));
  if (paragraphs.length === 0) return fallback;
  const text = paragraphs.join("\n");
  const limit = Math.max(8, maxChars);
  return text.length <= limit ? text : `${text.slice(0, limit - 3).trimEnd()}...`;
}

function referenceItems(units: readonly ConversationTurnRenderUnit[], o = options) {
  return units.flatMap((unit, unitIndex) => {
    const users = unit.visibleUserInputs.filter((row) => row.origin === "realUser");
    if (unit.timelineOnly || !users.length) return [];
    const preview = (texts: string[], fallback: string) =>
      referencePreview(texts, fallback, o.maxPreviewChars ?? 220, o.maxPreviewParagraphs ?? 2);
    const assistantPreview = unit.assistantTextRows.length
      ? preview(
          unit.assistantTextRows.map((row) => row.text),
          o.assistantEmptyPreview,
        )
      : unit.isRunning
        ? o.assistantRunningPreview
        : o.assistantEmptyPreview;
    const assistantPreviewKind = unit.assistantTextRows.length
      ? "text"
      : unit.isRunning
        ? "running"
        : "empty";
    return users.map((row, queryIndex) => ({
      key: `${unit.key}:query:${row.entityId ?? row.rowId}`,
      turnId: unit.turnId,
      unitIndex,
      rowId: row.rowId,
      userPreview: preview([row.text], o.userFallbackPreview),
      assistantPreview,
      assistantPreviewKind,
      isRunning: unit.isRunning && queryIndex === users.length - 1,
    }));
  });
}

function turnRows(id: number, texts = ["assistant"], running = false): ConversationRow[] {
  const base = { turnId: `turn-${id}`, createdAt: id * 1000, createdAtSeq: id * 100 };
  return [
    {
      ...base,
      kind: "turnHeader",
      rowId: id * 100,
      origin: "userInput",
      state: running ? "running" : "completedSuccess",
      startedAt: id * 1000,
    },
    { ...base, kind: "userInput", rowId: id * 100 + 1, origin: "realUser", text: `question ${id}` },
    ...texts.map(
      (text, index): AssistantTextRow => ({
        ...base,
        kind: "assistantText",
        rowId: id * 100 + 2 + index,
        state: running ? "streaming" : "complete",
        text,
      }),
    ),
  ];
}

function build(
  rows: ConversationRow[],
  cache?: ConversationTurnNavigatorPreviewCache,
  o = options,
) {
  const units = buildConversationTurnRenderUnits(rows, { nowMs: 10000 });
  const result = buildConversationTurnNavigatorItems(units, o, cache);
  expect(result).toEqual(referenceItems(units, o));
  return result;
}

const whitespaceCases = [
  [],
  [""],
  ["  \t\n"],
  [" a\n\nb "],
  ["a\n \nb"],
  ["a\n\u00a0\nb"],
  ["a\r\n\r\nb"],
  ["a\rb"],
  ["a\u2028b\u2029c"],
  ["a\n\n\nb"],
  ["\ufeff\u00a0 a\t b \u00a0\ufeff"],
  ["a\n", "b"],
  ["a", "\nb"],
  ["", " a ", "\n \n", " b ", ""],
  ["中文🙂 \t🚀\n\n尾部"],
  [
    "\u000b\u000c\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u202f\u205f\u3000a\u0085\u180e\u200b\u2060b",
  ],
  ["01234567"],
  ["012345678"],
  ["abcde   f"],
  ["abcdefg\n\nnext"],
];

describe("bounded navigator preview", () => {
  it.each(whitespaceCases.map((texts, index) => ({ index, texts })))(
    "preserves text normalization case $index",
    ({ texts }) => {
      for (const chars of [8, 9, 12, 220, -1, 8.5, NaN, Infinity, -Infinity]) {
        for (const paragraphs of [0, -1, 1, 2, 1.5, NaN, Infinity]) {
          expect(
            buildConversationTurnNavigatorPreview({
              texts,
              fallback: "fallback",
              maxPreviewChars: chars,
              maxPreviewParagraphs: paragraphs,
            }),
          ).toBe(referencePreview(texts, "fallback", chars, paragraphs));
        }
      }
    },
  );

  it("preserves UTF-16 slicing, including a split surrogate", () => {
    for (let limit = 8; limit < 16; limit++) {
      const texts = ["abcde🙂🚀中文longer suffix"];
      expect(
        buildConversationTurnNavigatorPreview({
          texts,
          fallback: "",
          maxPreviewChars: limit,
          maxPreviewParagraphs: 2,
        }),
      ).toBe(referencePreview(texts, "", limit));
    }
  });

  it("stops before reading later sources once truncation is known", () => {
    let laterReads = 0;
    function* texts() {
      yield "Long ordinary text ".repeat(10000);
      laterReads++;
      yield "unnecessary later body";
    }
    expect(
      buildConversationTurnNavigatorPreview({
        texts: texts(),
        fallback: "",
        maxPreviewChars: 220,
        maxPreviewParagraphs: 2,
      }),
    ).toBe(referencePreview(["Long ordinary text ".repeat(10000), "unnecessary later body"], ""));
    expect(laterReads).toBe(0);
  });

  it("only commits pending whitespace when subsequent content proves it", () => {
    for (const text of [
      "12345678   ",
      "12345678   x",
      "12345678\n\nx",
      "12345678\n\n   ",
      "a\n \n b\n\nc",
    ]) {
      for (const paragraphs of [1, 2]) {
        expect(
          buildConversationTurnNavigatorPreview({
            texts: [text],
            fallback: "",
            maxPreviewChars: 8,
            maxPreviewParagraphs: paragraphs,
          }),
        ).toBe(referencePreview([text], "", 8, paragraphs));
      }
    }
  });

  it("matches the old algorithm across seeded Unicode/whitespace/source boundaries", () => {
    let seed = 42;
    const tokens = [
      "a",
      "中文",
      "🙂",
      "\n",
      "\r",
      " ",
      "\t",
      "\u00a0",
      "\ufeff",
      "\u2028",
      "\u200b",
      "`",
      "<",
    ];
    for (let sample = 0; sample < 500; sample++) {
      const texts: string[] = [];
      for (let source = 0; source < 4; source++) {
        let text = "";
        for (let index = 0; index < 35; index++) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          text += tokens[seed % tokens.length];
        }
        texts.push(text);
      }
      const maxPreviewChars = [8, 17, 40, 220, NaN, Infinity][sample % 6]!;
      const maxPreviewParagraphs = [0, 1, 2, 1.5, NaN, Infinity][sample % 6]!;
      expect(
        buildConversationTurnNavigatorPreview({
          texts,
          fallback: "fallback",
          maxPreviewChars,
          maxPreviewParagraphs,
        }),
      ).toBe(referencePreview(texts, "fallback", maxPreviewChars, maxPreviewParagraphs));
    }
  });
});

describe("navigator instance preview cache", () => {
  it("reuses body previews even when every render unit is recreated", () => {
    const cache = new ConversationTurnNavigatorPreviewCache();
    const rows = [...turnRows(1), ...turnRows(2, ["tail"], true)];
    const textRow = rows[2] as AssistantTextRow;
    let reads = 0;
    Object.defineProperty(textRow, "text", {
      get: () => {
        reads++;
        return "historical body";
      },
    });
    Object.defineProperty(rows[1]!, "text", {
      get: () => {
        reads++;
        return "historical question";
      },
    });
    let units = buildConversationTurnRenderUnits(rows);
    buildConversationTurnNavigatorItems(units, options, cache);
    units = buildConversationTurnRenderUnits(rows, { nowMs: 20000 });
    const before = reads;
    buildConversationTurnNavigatorItems(units, options, cache);
    expect(reads).toBe(before);
    build(
      rows.map((row) =>
        row.kind === "assistantText" && row.rowId === 202 ? { ...row, text: "changed tail" } : row,
      ),
      cache,
    );
  });

  it("invalidates user and assistant replacements, reordering, running and localized options", () => {
    const cache = new ConversationTurnNavigatorPreviewCache();
    let rows = turnRows(1, ["first", "second"]);
    build(rows, cache);
    rows = rows.map((row) =>
      row.kind === "userInput"
        ? { ...row, text: "changed question" }
        : row.kind === "assistantText"
          ? { ...row, text: row.text + " changed" }
          : row,
    );
    build(rows, cache);
    build([rows[0]!, rows[1]!, rows[3]!, rows[2]!], cache);
    build(turnRows(1, [], true), cache);
    build(turnRows(1, []), cache);
    build(turnRows(1, []), cache, { ...options, assistantEmptyPreview: "没有回答" });
    build(turnRows(1, []), cache, { ...options, assistantEmptyPreview: "No response" });
    for (const maxPreviewChars of [8, 8.5, NaN, Infinity])
      build(rows, cache, { ...options, maxPreviewChars });
    build(rows, cache, { ...options, maxPreviewChars: Infinity, maxPreviewParagraphs: 1 });
    build(rows, cache, { ...options, maxPreviewChars: Infinity, maxPreviewParagraphs: 2 });
    const emptyQuestion = turnRows(1, [], true).map((row) =>
      row.kind === "userInput" ? { ...row, text: "" } : row,
    );
    build(emptyQuestion, cache, { ...options, userFallbackPreview: "问题" });
    build(emptyQuestion, cache, { ...options, userFallbackPreview: "Question" });
    build(emptyQuestion, cache, { ...options, assistantRunningPreview: "仍在工作" });
  });

  it("rebases indices/IDs after prepend, deletion and reorder on cache hits", () => {
    const cache = new ConversationTurnNavigatorPreviewCache();
    const first = turnRows(1);
    const second = turnRows(2);
    build([...first, ...second], cache);
    const prepended = build([...turnRows(0), ...first, ...second], cache);
    expect(prepended[1]).toMatchObject({ unitIndex: 1, rowId: 101 });
    const reordered = build([...second, ...first], cache);
    expect(reordered[0]).toMatchObject({ unitIndex: 0, rowId: 201 });
    build(first, cache);
    build([], cache);
    build(first, cache);
  });

  it("releases strong entries for removed or filtered units", () => {
    const cache = new ConversationTurnNavigatorPreviewCache();
    const rows = turnRows(1);
    const textRow = rows[2] as AssistantTextRow;
    let reads = 0;
    Object.defineProperty(textRow, "text", {
      get: () => {
        reads++;
        return "body";
      },
    });
    const units = buildConversationTurnRenderUnits(rows);
    buildConversationTurnNavigatorItems(units, options, cache);
    const before = reads;
    buildConversationTurnNavigatorItems([], options, cache);
    buildConversationTurnNavigatorItems(units, options, cache);
    expect(reads).toBeGreaterThan(before);
    const filtered = units.map((unit) => ({ ...unit, timelineOnly: true }));
    expect(buildConversationTurnNavigatorItems(filtered, options, cache)).toEqual([]);
    const after = reads;
    buildConversationTurnNavigatorItems(units, options, cache);
    expect(reads).toBeGreaterThan(after);
  });

  it("preserves query-level guide items and excludes non-real-user turns", () => {
    const cache = new ConversationTurnNavigatorPreviewCache();
    const rows = turnRows(1, ["answer"], true);
    const secondUser: ConversationRow = {
      ...rows[1]!,
      kind: "userInput",
      rowId: 110,
      turnId: "turn-1",
      origin: "realUser",
      guided: true,
      text: "guide",
      createdAt: 110,
      createdAtSeq: 110,
    };
    const items = build([...rows, secondUser], cache);
    expect(items.map((item) => item.isRunning)).toEqual([false, true]);
    expect(items[0]?.assistantPreview).toBe(items[1]?.assistantPreview);
    build(
      rows.map((row) => (row.kind === "userInput" ? { ...row, origin: "synthetic" } : row)),
      cache,
    );
  });

  it("does not mutate inputs or prior outputs and does not share across instances", () => {
    const rows = turnRows(1);
    rows.forEach(Object.freeze);
    Object.freeze(rows);
    const units = buildConversationTurnRenderUnits(rows);
    const first = buildConversationTurnNavigatorItems(
      units,
      options,
      new ConversationTurnNavigatorPreviewCache(),
    );
    const saved = structuredClone(first);
    first.forEach(Object.freeze);
    Object.freeze(first);
    expect(
      buildConversationTurnNavigatorItems(
        units,
        options,
        new ConversationTurnNavigatorPreviewCache(),
      ),
    ).toEqual(saved);
    expect(first).toEqual(saved);
  });

  it("matches oracle through seeded snapshot, tail update, history and option changes", () => {
    const cache = new ConversationTurnNavigatorPreviewCache();
    let rows = [1000, 1001, 1002].flatMap((id) => turnRows(id, [`body ${id}`], id === 1002));
    let seed = 42;
    let next = 1003;
    for (let step = 0; step < 120; step++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      switch (seed % 5) {
        case 0:
          rows = [...rows, ...turnRows(next++, ["new tail"], true)];
          break;
        case 1:
          rows = rows.map((row) =>
            row.kind === "assistantText" ? { ...row, text: `${step}: ${row.text} delta` } : row,
          );
          break;
        case 2:
          rows = rows.map((row) => ({ ...row }));
          break;
        case 3:
          rows = rows.slice(3);
          break;
        case 4:
          rows = [...turnRows(999 - step), ...rows];
          break;
      }
      build(rows, cache, {
        ...options,
        maxPreviewParagraphs: Math.floor(step / 12) % 4,
        maxPreviewChars: [8, 220, Infinity][Math.floor(step / 12) % 3],
      });
    }
  });
});
