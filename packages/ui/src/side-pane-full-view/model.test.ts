import { describe, expect, it } from "vitest";
import {
  DEFAULT_FLOATING_ANCHOR,
  FLOATING_ANCHORS,
  FLOATING_EXPANDED_MAX_HEIGHT_PX,
  FLOATING_MARGIN_PX,
  FLOATING_MINIMIZED_SIZE_PX,
  FLOATING_WIDTH_PX,
  clampFloatingPosition,
  dismissFloatingAnswerBubble,
  parseFloatingAnchor,
  rebaselineFloatingAnswerBubbles,
  reduceFloatingAnswerBubbles,
  resolveFloatingAnswerPreview,
  resolveEffectiveSidePaneFullView,
  resolveFloatingFrameMetrics,
  resolveFloatingHeaderVisible,
  resolveFloatingPosition,
  resolveFloatingTransformOrigin,
  resolveNearestFloatingAnchor,
  resolveSidePaneFullViewHostMode,
  shouldClearSidePaneFullViewOnPaneClose,
  SIDE_PANE_FULL_VIEW_ENTER_STATE,
} from "./model.js";
import type { FloatingAnswerBubbleState, SidePaneFullViewState } from "./contract.js";

const slot = { left: 100, top: 50, width: 1000, height: 800 };
const size = { width: 300, height: 200 };
const state = (
  surface: "conversation" | "side-pane",
  floating: "collapsed" | "expanded" | "minimized",
): SidePaneFullViewState => ({
  surface,
  floating,
});

describe("floating anchors", () => {
  it("keeps exactly the seven upstream positions with a bottom-right default", () => {
    expect(FLOATING_ANCHORS).toEqual([
      "top-left",
      "top-right",
      "left-center",
      "right-center",
      "bottom-left",
      "bottom-center",
      "bottom-right",
    ]);
    expect(DEFAULT_FLOATING_ANCHOR).toBe("bottom-right");
  });

  it("places every anchor against the slot edges with a 16px margin", () => {
    const m = FLOATING_MARGIN_PX;
    expect(resolveFloatingPosition("top-left", slot, size)).toEqual({
      left: slot.left + m,
      top: slot.top + m,
    });
    expect(resolveFloatingPosition("top-right", slot, size)).toEqual({
      left: slot.left + slot.width - m - size.width,
      top: slot.top + m,
    });
    expect(resolveFloatingPosition("left-center", slot, size)).toEqual({
      left: slot.left + m,
      top: slot.top + (slot.height - size.height) / 2,
    });
    expect(resolveFloatingPosition("right-center", slot, size)).toEqual({
      left: slot.left + slot.width - m - size.width,
      top: slot.top + (slot.height - size.height) / 2,
    });
    expect(resolveFloatingPosition("bottom-left", slot, size)).toEqual({
      left: slot.left + m,
      top: slot.top + slot.height - m - size.height,
    });
    expect(resolveFloatingPosition("bottom-center", slot, size)).toEqual({
      left: slot.left + (slot.width - size.width) / 2,
      top: slot.top + slot.height - m - size.height,
    });
    expect(resolveFloatingPosition("bottom-right", slot, size)).toEqual({
      left: slot.left + slot.width - m - size.width,
      top: slot.top + slot.height - m - size.height,
    });
  });

  it("clamps a dragged position inside the slot", () => {
    expect(clampFloatingPosition({ left: -500, top: 9999 }, slot, size)).toEqual({
      left: slot.left,
      top: slot.top + slot.height - size.height,
    });
  });

  it("snaps a dropped position to the nearest resting anchor", () => {
    expect(resolveNearestFloatingAnchor({ left: 690, top: 590 }, slot, size)).toBe("bottom-right");
    expect(resolveNearestFloatingAnchor({ left: 16, top: 16 }, slot, size)).toBe("top-left");
    expect(resolveNearestFloatingAnchor({ left: 420, top: 300 }, slot, size)).toBe("left-center");
    expect(resolveNearestFloatingAnchor({ left: 450, top: 700 }, slot, size)).toBe("bottom-center");
  });

  it("scales minimized transitions from the anchor corner", () => {
    expect(resolveFloatingTransformOrigin("top-left")).toBe("left top");
    expect(resolveFloatingTransformOrigin("right-center")).toBe("right center");
    expect(resolveFloatingTransformOrigin("bottom-right")).toBe("right bottom");
  });

  it("parses only the seven known anchors", () => {
    for (const anchor of FLOATING_ANCHORS) expect(parseFloatingAnchor(anchor)).toBe(anchor);
    expect(parseFloatingAnchor("middle")).toBeNull();
    expect(parseFloatingAnchor(null)).toBeNull();
    expect(parseFloatingAnchor(3)).toBeNull();
  });
});

describe("floating frame metrics", () => {
  it("clips the collapsed frame to the measured composer dock", () => {
    expect(
      resolveFloatingFrameMetrics({
        slot,
        floating: "collapsed",
        headerVisible: false,
        composerDockHeightPx: 60,
      }),
    ).toEqual({
      width: FLOATING_WIDTH_PX,
      height: 60,
      paneHeight: FLOATING_EXPANDED_MAX_HEIGHT_PX - 40,
      clipHeight: 60,
      drawerHeight: 16,
    });
  });

  it("adds the toolbar height and stretches the drawer while the header is visible", () => {
    expect(
      resolveFloatingFrameMetrics({
        slot,
        floating: "collapsed",
        headerVisible: true,
        composerDockHeightPx: 60,
      }),
    ).toEqual({
      width: FLOATING_WIDTH_PX,
      height: 100,
      paneHeight: 600,
      clipHeight: 60,
      drawerHeight: 100,
    });
  });

  it("expands to the capped height minus the toolbar", () => {
    const metrics = resolveFloatingFrameMetrics({
      slot,
      floating: "expanded",
      headerVisible: true,
      composerDockHeightPx: 60,
    });
    expect(metrics).toEqual({
      width: FLOATING_WIDTH_PX,
      height: FLOATING_EXPANDED_MAX_HEIGHT_PX,
      paneHeight: FLOATING_EXPANDED_MAX_HEIGHT_PX - 41,
      clipHeight: FLOATING_EXPANDED_MAX_HEIGHT_PX - 41,
      drawerHeight: FLOATING_EXPANDED_MAX_HEIGHT_PX,
    });
  });

  it("minimizes to a square regardless of dock height", () => {
    expect(
      resolveFloatingFrameMetrics({
        slot,
        floating: "minimized",
        headerVisible: false,
        composerDockHeightPx: 400,
      }),
    ).toEqual({
      width: FLOATING_MINIMIZED_SIZE_PX,
      height: FLOATING_MINIMIZED_SIZE_PX,
      paneHeight: FLOATING_MINIMIZED_SIZE_PX,
      clipHeight: FLOATING_MINIMIZED_SIZE_PX,
      drawerHeight: 0,
    });
  });

  it("shrinks inside a narrow slot", () => {
    const narrow = resolveFloatingFrameMetrics({
      slot: { left: 0, top: 0, width: 400, height: 200 },
      floating: "collapsed",
      headerVisible: false,
      composerDockHeightPx: 60,
    });
    expect(narrow.width).toBe(400 - FLOATING_MARGIN_PX * 2);
    // slot 只有 200 高：可用高度 168，浮窗内容高度被外层高度夹住，裁剪高度不超过它。
    expect(narrow.paneHeight).toBe(200 - FLOATING_MARGIN_PX * 2 - 40);
    expect(narrow.clipHeight).toBe(60);
  });
});

describe("full view derivation", () => {
  it("activates only when enabled, open and recorded", () => {
    const stored = state("side-pane", "collapsed");
    expect(resolveEffectiveSidePaneFullView({ enabled: true, isSidePaneOpen: true, stored })).toBe(
      stored,
    );
    expect(
      resolveEffectiveSidePaneFullView({ enabled: false, isSidePaneOpen: true, stored }),
    ).toBeNull();
    expect(
      resolveEffectiveSidePaneFullView({ enabled: true, isSidePaneOpen: false, stored }),
    ).toBeNull();
    expect(
      resolveEffectiveSidePaneFullView({ enabled: true, isSidePaneOpen: true, stored: null }),
    ).toBeNull();
  });

  it("maps surface to the host mode", () => {
    expect(resolveSidePaneFullViewHostMode(null)).toBe("normal");
    expect(resolveSidePaneFullViewHostMode(state("conversation", "collapsed"))).toBe(
      "conversation",
    );
    expect(resolveSidePaneFullViewHostMode(state("side-pane", "expanded"))).toBe("floating");
    expect(resolveSidePaneFullViewHostMode(SIDE_PANE_FULL_VIEW_ENTER_STATE)).toBe("floating");
  });

  it("clears the record only when the same owner closes the pane", () => {
    expect(
      shouldClearSidePaneFullViewOnPaneClose({
        previousScope: "ws::task",
        scope: "ws::task",
        wasSidePaneOpen: true,
        isSidePaneOpen: false,
        hasRecord: true,
      }),
    ).toBe(true);
    // 切换 owner 时面板开合随 owner 恢复，不代表用户关闭。
    expect(
      shouldClearSidePaneFullViewOnPaneClose({
        previousScope: "ws::task-a",
        scope: "ws::task-b",
        wasSidePaneOpen: true,
        isSidePaneOpen: false,
        hasRecord: true,
      }),
    ).toBe(false);
    expect(
      shouldClearSidePaneFullViewOnPaneClose({
        previousScope: "ws::task",
        scope: "ws::task",
        wasSidePaneOpen: false,
        isSidePaneOpen: false,
        hasRecord: true,
      }),
    ).toBe(false);
    expect(
      shouldClearSidePaneFullViewOnPaneClose({
        previousScope: "ws::task",
        scope: "ws::task",
        wasSidePaneOpen: true,
        isSidePaneOpen: false,
        hasRecord: false,
      }),
    ).toBe(false);
  });

  it("shows the toolbar when expanded, focused, menu-open or dragging", () => {
    const base = {
      floating: "collapsed" as const,
      focusWithin: false,
      menuOpen: false,
      dragging: false,
    };
    expect(resolveFloatingHeaderVisible(base)).toBe(false);
    expect(resolveFloatingHeaderVisible({ ...base, focusWithin: true })).toBe(true);
    expect(resolveFloatingHeaderVisible({ ...base, menuOpen: true })).toBe(true);
    expect(resolveFloatingHeaderVisible({ ...base, dragging: true })).toBe(true);
    expect(resolveFloatingHeaderVisible({ ...base, floating: "expanded" })).toBe(true);
    expect(
      resolveFloatingHeaderVisible({ ...base, floating: "minimized", focusWithin: true }),
    ).toBe(false);
  });
});

describe("floating answer bubbles", () => {
  const status = (
    ownerKey: string,
    turnKey: string | null,
    running: boolean,
    answer: { rowId: number; text: string } | null = null,
  ) => ({ ownerKey, latestTurn: { turnKey, running, answer } });

  it("baselines the first completed turn without showing a bubble", () => {
    const next = reduceFloatingAnswerBubbles(
      new Map(),
      status("task-a", "turn-1", false, {
        rowId: 1,
        text: "done",
      }),
    );
    expect(next.get("task-a")).toEqual({ seenTurnKey: "turn-1", answer: null });
  });

  it("shows the first completed turn when the baseline was running", () => {
    let bubbles = reduceFloatingAnswerBubbles(new Map(), status("task-a", "turn-1", true));
    expect(bubbles.get("task-a")).toEqual({ seenTurnKey: null, answer: null });
    bubbles = reduceFloatingAnswerBubbles(
      bubbles,
      status("task-a", "turn-1", false, {
        rowId: 1,
        text: "done",
      }),
    );
    expect(bubbles.get("task-a")).toEqual({
      seenTurnKey: "turn-1",
      answer: { rowId: 1, text: "done" },
    });
  });

  it("replaces the bubble only for a new finished turn", () => {
    let bubbles: ReadonlyMap<string, FloatingAnswerBubbleState> = new Map([
      ["task-a", { seenTurnKey: "turn-1", answer: { rowId: 1, text: "old" } }],
    ]);
    bubbles = reduceFloatingAnswerBubbles(bubbles, status("task-a", "turn-2", true));
    expect(bubbles.get("task-a")).toEqual({
      seenTurnKey: "turn-1",
      answer: { rowId: 1, text: "old" },
    });
    bubbles = reduceFloatingAnswerBubbles(
      bubbles,
      status("task-a", "turn-2", false, {
        rowId: 2,
        text: "new",
      }),
    );
    expect(bubbles.get("task-a")).toEqual({
      seenTurnKey: "turn-2",
      answer: { rowId: 2, text: "new" },
    });
    // 同一回合重复上报不覆盖新回答。
    bubbles = reduceFloatingAnswerBubbles(
      bubbles,
      status("task-a", "turn-2", false, {
        rowId: 3,
        text: "duplicate",
      }),
    );
    expect(bubbles.get("task-a")?.answer).toEqual({ rowId: 2, text: "new" });
  });

  it("keeps owners isolated and ignores turns without a key or final answer", () => {
    const before: ReadonlyMap<string, FloatingAnswerBubbleState> = new Map([
      ["task-a", { seenTurnKey: "turn-a", answer: null }],
      ["task-b", { seenTurnKey: "turn-b0", answer: null }],
    ]);
    const baselined = reduceFloatingAnswerBubbles(before, status("task-b", "turn-b", false, null));
    expect(baselined.get("task-a")).toEqual({ seenTurnKey: "turn-a", answer: null });
    expect(baselined.get("task-b")).toEqual({ seenTurnKey: "turn-b0", answer: null });
    const after = reduceFloatingAnswerBubbles(
      before,
      status("task-b", "turn-b", false, {
        rowId: 9,
        text: "b",
      }),
    );
    expect(after.get("task-a")).toEqual({ seenTurnKey: "turn-a", answer: null });
    expect(after.get("task-b")).toEqual({
      seenTurnKey: "turn-b",
      answer: { rowId: 9, text: "b" },
    });
    expect(reduceFloatingAnswerBubbles(before, status("task-a", null, false, null))).toBe(before);
    expect(reduceFloatingAnswerBubbles(new Map(), status("task-c", "turn-c", false, null))).toEqual(
      new Map([["task-c", { seenTurnKey: "turn-c", answer: null }]]),
    );
  });

  it("dismisses one bubble without moving the baseline, and rebaselines all on leaving", () => {
    const bubbles = new Map([
      ["task-a", { seenTurnKey: "turn-1", answer: { rowId: 1, text: "old" } }],
      ["task-b", { seenTurnKey: "turn-2", answer: null }],
    ]);
    const dismissed = dismissFloatingAnswerBubble(bubbles, "task-a");
    expect(dismissed.get("task-a")).toEqual({ seenTurnKey: "turn-1", answer: null });
    expect(dismissed.get("task-b")).toBe(bubbles.get("task-b"));
    expect(dismissFloatingAnswerBubble(dismissed, "task-a")).toBe(dismissed);
    const rebaselined = rebaselineFloatingAnswerBubbles(dismissed);
    expect(rebaselined.get("task-a")).toEqual({ seenTurnKey: undefined, answer: null });
    expect(rebaselined.get("task-b")).toEqual({ seenTurnKey: undefined, answer: null });
    expect(rebaselineFloatingAnswerBubbles(rebaselined)).toBe(rebaselined);
  });

  it("renders only the first two lines of plain text", () => {
    expect(resolveFloatingAnswerPreview("## Title\n\n**bold** and `code`\n- item\n[link](x)")).toBe(
      "Title bold and code item link",
    );
    expect(resolveFloatingAnswerPreview("```ts\nsecret\n```\nvisible")).toBe("visible");
    expect(resolveFloatingAnswerPreview("snake_case stays")).toBe("snake_case stays");
  });
});
