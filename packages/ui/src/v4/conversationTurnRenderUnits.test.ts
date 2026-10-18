import { describe, expect, it } from "vitest";
import type {
  AssistantTextRow,
  ConversationRow,
  SessionPhase,
  ToolCallRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import { deriveLogicalUiInstances, type PluginUiRowPinResolver } from "@/plugin-ui/index.js";
import { ConversationTurnRenderUnitCache } from "./conversationTurnRenderUnitCache.js";
import {
  buildConversationTurnRenderUnits,
  type BuildConversationTurnRenderUnitsOptions,
} from "./conversationTurnRenderUnits.js";

function turn(id: number, running = false): ConversationRow[] {
  const base = { turnId: `turn-${id}`, createdAt: id * 1000, createdAtSeq: id * 3 };
  const header: TurnHeaderRow = {
    ...base,
    kind: "turnHeader",
    rowId: id * 3,
    origin: "userInput",
    state: running ? "running" : "completedSuccess",
    startedAt: id * 1000,
    ...(running ? {} : { endedAt: id * 1000 + 500 }),
  };
  const user: UserInputRow = {
    ...base,
    kind: "userInput",
    rowId: id * 3 + 1,
    origin: "realUser",
    text: `question ${id}`,
  };
  const assistant: AssistantTextRow = {
    ...base,
    kind: "assistantText",
    rowId: id * 3 + 2,
    state: running ? "streaming" : "complete",
    text: `answer ${id}`,
  };
  return [header, user, assistant];
}

function pluginRow(id: number, turnId: string): ToolCallRow {
  return {
    kind: "toolCall",
    rowId: id,
    turnId,
    createdAt: id,
    createdAtSeq: id,
    toolCallId: `call-${id}`,
    toolName: "mcp__fixture__edit",
    status: "success",
    inputText: "{}",
    display: {
      kind: "mcp_tool",
      serverName: "fixture",
      toolName: "edit",
      ui: { pluginId: "fixture", resourceUri: "ui://fixture", surface: "panel" },
    },
  };
}

function fixture() {
  const cache = new ConversationTurnRenderUnitCache();
  return (
    rows: readonly ConversationRow[],
    options: BuildConversationTurnRenderUnitsOptions = {},
  ) => {
    const result = buildConversationTurnRenderUnits(rows, options, cache);
    expect(result).toEqual(buildConversationTurnRenderUnits(rows, options));
    return result;
  };
}

describe("conversation turn render cache", () => {
  it("reuses unchanged historical units across immutable tail deltas", () => {
    const build = fixture();
    const rows = [...turn(0), ...turn(1), ...turn(2, true)];
    const before = build(rows, { nowMs: 3000 });
    const after = build(
      rows.map((row) =>
        row.rowId === 8 && row.kind === "assistantText"
          ? { ...row, text: row.text + " delta" }
          : row,
      ),
      { nowMs: 3000 },
    );
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).not.toBe(before[2]);
    expect(build([...rows], { nowMs: 3000 })[0]).toBe(before[0]);
  });

  it("updates running durations without invalidating completed turns", () => {
    const build = fixture();
    const rows = [...turn(0), ...turn(1, true)];
    const before = build(rows, { nowMs: 2000 });
    const after = build(rows, { nowMs: 3000 });
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(after[1]?.workStatus?.durationMs).toBe(2000);
    expect(after[1]?.workSegments?.[0]?.workStatus?.durationMs).toBe(2000);
  });

  it("normalizes position after append, prepend, removal and filtering", () => {
    const build = fixture();
    const first = turn(1);
    const second = turn(2, true);
    const emptyHeader = turn(3)[0]!;
    const original = build(first);
    const appended = build([...first, ...second]);
    expect(appended[0]?.isLastTurn).toBe(false);
    expect(appended[1]?.isLastTurn).toBe(true);
    expect(build([...turn(0), ...first, ...second])[1]).toBe(appended[0]);
    const filtered = build([...first, emptyHeader]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.isLastTurn).toBe(true);
    expect(build([...first, emptyHeader])[0]).toBe(filtered[0]);
    expect(build(first)).toEqual(original);
    build([]);
    expect(build(first)[0]).not.toBe(filtered[0]);
  });

  it("preserves screenshot-only segment folding when the last turn changes", () => {
    const build = fixture();
    const rows = turn(0);
    const screenshot: ToolCallRow = {
      ...pluginRow(20, "turn-0"),
      display: { kind: "node_repl_images", source: "browser_turn_end" },
    };
    const screenshotRows = [rows[0]!, rows[1]!, screenshot];
    const before = build(screenshotRows);
    expect(before[0]?.browserTurnEndRows).toEqual([screenshot]);
    expect(before[0]?.workSegments?.[0]?.assistantHistoryDefaultOpen).toBe(false);
    const after = build([...screenshotRows, ...turn(1)]);
    expect(after[0]?.workSegments?.[0]?.assistantHistoryDefaultOpen).toBe(false);
    build(screenshotRows);
  });

  it("does not mutate previously published rows or units during position changes", () => {
    const build = fixture();
    const rows = turn(0);
    rows.forEach(Object.freeze);
    Object.freeze(rows);
    const before = build(rows);
    before.forEach((unit) => {
      unit.workSegments?.forEach(Object.freeze);
      Object.freeze(unit.workSegments);
      Object.freeze(unit);
    });
    const after = build([...rows, ...turn(1, true)], { nowMs: 2000 });
    expect(before[0]?.isLastTurn).toBe(true);
    expect(after[0]?.isLastTurn).toBe(false);
  });

  it("invalidates replaced, removed, reordered and non-contiguous rows", () => {
    const build = fixture();
    const first = turn(0);
    const second = turn(1);
    build([...first, ...second]);
    build([first[0]!, second[0]!, first[1]!, second[1]!, first[2]!, second[2]!]);
    build([first[0]!, first[2]!, first[1]!, ...second]);
    build([first[1]!, first[2]!, ...second]);
    build([...first.map((row) => ({ ...row })), ...second]);
    build([first[0]!, first[1]!, ...second]);
  });

  it.each<SessionPhase>(["completedSuccess", "completedInterrupted", "error"])(
    "respects headerless phase changes to %s and restored authoritative headers",
    (sessionPhase) => {
      const build = fixture();
      const rows = turn(0, true);
      build(rows.slice(1), { nowMs: 1000 });
      build(rows.slice(1), { sessionPhase, nowMs: 2000 });
      build(rows, { sessionPhase, nowMs: 2000 });
      const header = rows[0] as TurnHeaderRow;
      build([{ ...header, state: "completedInterrupted" }, ...rows.slice(1)], { nowMs: 3000 });
      build([{ ...header, state: "failed" }, ...rows.slice(1)], { nowMs: 4000 });
    },
  );

  it("preserves guide segments, durations and action anchors", () => {
    const build = fixture();
    const rows = turn(0, true);
    const header = rows[0] as TurnHeaderRow;
    const assistant = rows[2] as AssistantTextRow;
    const guided: UserInputRow = {
      ...(rows[1] as UserInputRow),
      rowId: 4,
      entityId: "guide",
      guided: true,
      createdAt: 500,
      text: "steer",
    };
    const fixtureRows: ConversationRow[] = [
      {
        ...header,
        workSegments: [
          { segmentId: "a", startedAt: 0, activeMs: 500 },
          { segmentId: "b", triggerEntityId: "guide", startedAt: 500 },
        ],
      },
      rows[1]!,
      { ...assistant, state: "complete" },
      guided,
      { ...assistant, rowId: 5, actions: { canFork: true } },
    ];
    const before = build(fixtureRows, { nowMs: 1000 });
    const after = build(fixtureRows, { nowMs: 2000 });
    expect(after[0]?.workSegments).toHaveLength(2);
    expect(after[0]?.workSegments?.[0]?.workStatus?.durationMs).toBe(500);
    expect(after[0]?.workSegments?.[1]?.workStatus?.durationMs).toBe(1500);
    expect(after[0]).not.toBe(before[0]);
  });

  it("uses effective plugin pin results, not resolver function identity", () => {
    const build = fixture();
    const first = turn(0);
    const tool = pluginRow(20, "turn-0");
    const rows = [first[0]!, first[1]!, tool, first[2]!, ...turn(1)];
    const resolver =
      (manualPinned: boolean): PluginUiRowPinResolver =>
      () => ({ manualPinned });
    const before = build(rows, { pluginUiPinResolver: resolver(true) });
    const equivalent = build(rows, { pluginUiPinResolver: resolver(true) });
    expect(equivalent[0]).toBe(before[0]);
    const after = build(rows, { pluginUiPinResolver: resolver(false) });
    expect(after[0]).not.toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[0]?.assistantHistoryRows).toContain(tool);
  });

  it("invalidates cross-turn plugin supersession and recent-turn eligibility", () => {
    const build = fixture();
    const withPlugin = (id: number) => {
      const rows = turn(id);
      return [rows[0]!, rows[1]!, pluginRow(100 + id, `turn-${id}`), rows[2]!];
    };
    const derive = (rows: ConversationRow[]) => {
      const derivation = deriveLogicalUiInstances(rows);
      return build(rows, {
        pluginUiPinResolver: (id) => ({ disposition: derivation.byToolCallId[id] }),
      });
    };
    const first = withPlugin(0);
    const before = derive(first);
    const after = derive([...first, ...withPlugin(1)]);
    expect(after[0]?.assistantHistoryRows).toContain(first[2]);
    expect(after[0]).not.toBe(before[0]);
    derive([...first, ...turn(1), ...turn(2), ...turn(3)]);
    derive([...first, ...turn(1)]);
  });

  it.each(["error", "cancelled", "isError"])("handles plugin failure %s", (failure) => {
    const build = fixture();
    const rows = turn(0);
    const tool = pluginRow(20, "turn-0");
    build([rows[0]!, rows[1]!, tool, rows[2]!]);
    const failed: ToolCallRow =
      failure === "isError"
        ? {
            ...tool,
            display: {
              ...tool.display!,
              kind: "mcp_tool",
              serverName: "fixture",
              toolName: "edit",
              ui: { pluginId: "fixture", resourceUri: "ui://fixture", isError: true },
            },
          }
        : { ...tool, status: failure as "error" | "cancelled" };
    build([rows[0]!, rows[1]!, failed, rows[2]!], {
      pluginUiPinResolver: () => ({ manualPinned: true }),
    });
  });

  it("does not share units across cache instances", () => {
    const rows = turn(0);
    expect(fixture()(rows)[0]).not.toBe(fixture()(rows)[0]);
  });

  it("matches the oracle across seeded delta/replay/clock/history sequences", () => {
    const build = fixture();
    let seed = 42;
    let nextTurn = 4;
    let rows = [0, 1, 2, 3].flatMap((id) => turn(id, id === 3));
    for (let step = 0; step < 160; step++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      switch (seed % 6) {
        case 0:
          rows = [...rows, ...turn(nextTurn++, true)];
          break;
        case 1:
          rows = rows.map((row) =>
            row.kind === "assistantText" && row.turnId === rows.at(-1)?.turnId
              ? { ...row, text: row.text + " delta" }
              : row,
          );
          break;
        case 2:
          rows = rows.map((row) => ({ ...row }));
          break;
        case 3:
          rows = rows.slice(3);
          break;
        case 4:
          rows = [...turn(-step - 1), ...rows];
          break;
      }
      build(rows, { nowMs: 100000 + step * 1000 });
    }
  });
});
