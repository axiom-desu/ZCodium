import { describe, expect, it } from "vitest";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";
import {
  isSameConversationLatestTurnSummary,
  resolveConversationLatestTurnSummary,
  splitConversationTimelineLiveTail,
} from "@/v4/conversationTimelineLiveTail.js";

function unit(overrides: Partial<ConversationTurnRenderUnit>): ConversationTurnRenderUnit {
  return {
    key: "turn-1",
    turnId: "turn-1",
    visibleUserInputs: [],
    assistantWorkRows: [],
    assistantHistoryRows: [],
    assistantFollowingRows: [],
    assistantTailRows: [],
    browserTurnEndRows: [],
    hookInvocations: [],
    assistantTextRows: [],
    leadingBoundaryRows: [],
    flowItems: [],
    renderRows: [],
    isLastTurn: true,
    isRunning: false,
    assistantHistoryDefaultOpen: false,
    timelineOnly: false,
    ...overrides,
  };
}

describe("conversation latest turn summary", () => {
  it("returns an empty summary when the timeline has no turns", () => {
    expect(resolveConversationLatestTurnSummary([])).toEqual({
      turnKey: null,
      running: false,
      workDurationMs: undefined,
      answer: null,
    });
  });

  it("reads running state and duration from the same last render unit", () => {
    expect(
      resolveConversationLatestTurnSummary([
        unit({
          key: "turn-1",
          isRunning: true,
          latestAssistantTextRow: {
            kind: "assistantText",
            rowId: 1,
            turnId: "turn-1",
            text: "partial",
            state: "complete",
          } as ConversationTurnRenderUnit["latestAssistantTextRow"],
          workSegments: [
            {
              key: "segment-1",
              flowItems: [],
              assistantWorkRows: [],
              assistantHistoryRows: [],
              assistantFollowingRows: [],
              assistantHistoryDefaultOpen: false,
              workStatus: { state: "running", durationMs: 4200 },
            },
          ],
        }),
      ]),
    ).toEqual({
      turnKey: "turn-1",
      running: true,
      workDurationMs: 4200,
      answer: null,
    });
  });

  it("only exposes a completed non-empty final answer after the turn ends", () => {
    expect(
      resolveConversationLatestTurnSummary([
        unit({
          key: "turn-2",
          latestAssistantTextRow: {
            kind: "assistantText",
            rowId: 7,
            turnId: "turn-2",
            text: "final answer",
            state: "complete",
          } as ConversationTurnRenderUnit["latestAssistantTextRow"],
        }),
      ]),
    ).toEqual({
      turnKey: "turn-2",
      running: false,
      workDurationMs: undefined,
      answer: { rowId: 7, text: "final answer" },
    });
    for (const state of ["streaming", "interrupted", "failed"] as const) {
      expect(
        resolveConversationLatestTurnSummary([
          unit({
            latestAssistantTextRow: {
              kind: "assistantText",
              rowId: 7,
              turnId: "turn-2",
              text: "final answer",
              state,
            } as ConversationTurnRenderUnit["latestAssistantTextRow"],
          }),
        ]).answer,
      ).toBeNull();
    }
    expect(
      resolveConversationLatestTurnSummary([
        unit({
          latestAssistantTextRow: {
            kind: "assistantText",
            rowId: 7,
            turnId: "turn-2",
            text: "   ",
            state: "complete",
          } as ConversationTurnRenderUnit["latestAssistantTextRow"],
        }),
      ]).answer,
    ).toBeNull();
  });

  it("compares summaries by turn, run state, duration and answer identity", () => {
    const base = {
      turnKey: "turn-1",
      running: false,
      workDurationMs: undefined,
      answer: { rowId: 1, text: "done" },
    };
    expect(isSameConversationLatestTurnSummary(base, { ...base })).toBe(true);
    expect(isSameConversationLatestTurnSummary(base, { ...base, turnKey: "turn-2" })).toBe(false);
    expect(isSameConversationLatestTurnSummary(base, { ...base, running: true })).toBe(false);
    expect(isSameConversationLatestTurnSummary(base, { ...base, workDurationMs: 10 })).toBe(false);
    expect(
      isSameConversationLatestTurnSummary(base, { ...base, answer: { rowId: 2, text: "done" } }),
    ).toBe(false);
    expect(
      isSameConversationLatestTurnSummary(base, { ...base, answer: { rowId: 1, text: "other" } }),
    ).toBe(false);
  });

  it("keeps the existing live-tail split for a running final unit", () => {
    const running = unit({ isRunning: true });
    const split = splitConversationTimelineLiveTail([unit({ key: "turn-0" }), running]);
    expect(split.liveUnit).toBe(running);
    expect(split.virtualizedUnits.map((entry) => entry.key)).toEqual(["turn-0"]);
    expect(splitConversationTimelineLiveTail([unit({})])).toEqual({
      virtualizedUnits: [expect.objectContaining({ key: "turn-1" })],
      liveUnit: null,
      liveUnitIndex: null,
    });
  });
});
