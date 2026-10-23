import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MessageWithParts } from "../src/runtime/deps.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import * as sessionFork from "../src/runtime/methods/session-fork.js";
import * as steering from "../src/runtime/methods/steering.js";
import * as fileRewind from "../src/runtime/methods/file-rewind.js";
import * as turn from "../src/runtime/methods/turn.js";
import * as compactActive from "../src/runtime/methods/compact-active.js";
import {
  resolveCheckpointAfterContent,
  resolveTargetCheckpoints,
} from "../src/runtime/methods/file-rewind-checkpoints.js";
import {
  canUseCompactSummaryTruncationFallback,
  capCompactSummaryMaxOutputTokens,
  createCompactSelectionState,
  reselectCompactEntriesAfterPromptTooLong,
  resetCompactSelectionState,
  selectInitialCompactEntriesForActiveConversation,
} from "../src/runtime/methods/compact-active-selection.js";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";
import { createRegularTurnLoopState } from "../src/runtime/methods/turn-loop-state-create.js";
import { firstInlineGuideIndex } from "../src/runtime/methods/steering-turn-lifecycle.js";

const traceContext = { traceId: "trace", spanId: "span" } as never;

function message(input: {
  id: string;
  role: "user" | "assistant";
  parentID?: string;
  synthetic?: boolean;
  visibility?: string;
  source?: string;
  summary?: boolean;
  parts?: unknown[];
}): MessageWithParts {
  return {
    info: {
      id: input.id,
      sessionID: "session",
      role: input.role,
      time: { created: 0 },
      ...(input.parentID ? { parentID: input.parentID } : {}),
      ...(input.synthetic === undefined ? {} : { synthetic: input.synthetic }),
      ...(input.visibility ? { visibility: input.visibility } : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(input.summary === undefined ? {} : { summary: input.summary }),
    },
    parts: input.parts ?? [],
  } as unknown as MessageWithParts;
}

function compactionBoundary(id: string, parentID?: string): MessageWithParts {
  return message({
    id,
    role: "user",
    ...(parentID ? { parentID } : {}),
    summary: true,
    parts: [{ type: "compaction", compactBoundary: { boundaryId: id } }],
  });
}

describe("runtime coordination export contract", () => {
  it("keeps the original fork exports and arity", () => {
    assert.equal(typeof sessionFork.createSelectionSideConversation, "function");
    assert.equal(sessionFork.createSelectionSideConversation.length, 1);
    assert.equal(sessionFork.createForkedSession.length, 2);
    assert.equal(sessionFork.forkConversationFromMessage.length, 1);
    assert.equal(sessionFork.forkStableConversationAtMessage.length, 1);
    assert.equal(sessionFork.forkConversationBeforeMessage.length, 1);
    assert.equal(sessionFork.copyGoalStateForFork.length, 1);
    assert.equal(sessionFork.forkSourceMessagesForSession.length, 2);
    assert.equal(sessionFork.resolveForkHistoryEndIndex.length, 3);
    assert.equal(sessionFork.buildForkHistoryMessages.length, 4);
  });

  it("keeps the original steering exports and arity", () => {
    assert.equal(steering.steerTurn.length, 1);
    assert.equal(steering.enqueueDeferredInput.length, 1);
    assert.equal(steering.beginActiveTurn.length, 5);
    assert.equal(steering.reserveTurnStart.length, 3);
    assert.equal(steering.releaseTurnStart.length, 1);
    assert.equal(steering.finishActiveTurn.length, 1);
    assert.equal(steering.createPendingInputId.length, 1);
    assert.equal(steering.rejectTurnSteer.length, 2);
    assert.equal(steering.hasPendingInput.length, 1);
    assert.equal(steering.hasInlineGuidePendingInput.length, 1);
    assert.equal(steering.fallbackPendingGuidesToQueue.length, 1);
    assert.equal(steering.drainPendingInput.length, 1);
    assert.equal(steering.discardPendingInput.length, 1);
    assert.equal(steering.discardPersistedPendingSteerInputs.length, 1);
    assert.equal(steering.removePendingInputById.length, 1);
    assert.equal(steering.discardHeldPendingInputById.length, 3);
    assert.equal(steering.clearAllPendingInputs.length, 1);
    assert.equal(steering.editPendingInputById.length, 1);
    assert.equal(steering.reorderPendingInput.length, 1);
    assert.equal(steering.setQueueAutoDrain.length, 1);
    assert.equal(steering.completeExternalQueueDrain.length, 0);
    assert.equal(steering.setFollowupMode.length, 1);
    assert.equal(steering.emitModelSelected.length, 1);
    assert.equal(steering.emitModeChanged.length, 1);
  });

  it("keeps the original rewind, turn and compact exports and arity", () => {
    assert.equal(fileRewind.previewWorkspaceFileRewind.length, 0);
    assert.equal(fileRewind.applyWorkspaceFileRewind.length, 0);
    assert.equal(turn.executeTurn.length, 3);
    assert.equal(turn.executeTurnCommand.length, 4);
    assert.equal(compactActive.compactActiveConversation.length, 3);
  });
});

describe("fork history selection", () => {
  it("expands only contiguous assistant siblings of the same parent", () => {
    const messages = [
      message({ id: "u0", role: "user" }),
      message({ id: "a1", role: "assistant", parentID: "u0" }),
      message({ id: "a2", role: "assistant", parentID: "u0" }),
      message({ id: "u1", role: "user" }),
    ];
    assert.equal(sessionFork.resolveForkHistoryEndIndex(messages, 1, true), 3);
    assert.equal(sessionFork.resolveForkHistoryEndIndex(messages, 1, false), 2);
    assert.equal(sessionFork.resolveForkHistoryEndIndex(messages, 0, true), 1);
  });

  it("restores the compacted real parent input ahead of the compact boundary", () => {
    const parentUser = message({ id: "u0", role: "user" });
    const summary = compactionBoundary("boundary");
    const target = message({ id: "a1", role: "assistant", parentID: "u0" });
    const forkHistory = sessionFork.buildForkHistoryMessages(
      [parentUser, summary, target],
      [summary, target],
      1,
      2,
    );
    assert.deepEqual(
      forkHistory.map((item) => item.info.id),
      ["u0", "boundary", "a1"],
    );
  });

  it("does not reinsert a parent that is already part of the fork history", () => {
    const parentUser = message({ id: "u0", role: "user" });
    const target = message({ id: "a1", role: "assistant", parentID: "u0" });
    const forkHistory = sessionFork.buildForkHistoryMessages(
      [parentUser, target],
      [parentUser, target],
      1,
      2,
    );
    assert.deepEqual(
      forkHistory.map((item) => item.info.id),
      ["u0", "a1"],
    );
  });
});

describe("steering queue auto-drain ownership", () => {
  it("flips the runtime gate before the authoritative event is appended", async () => {
    const appended: unknown[] = [];
    const snapshots: Array<{ autoDrain: boolean; externalDrain: boolean }> = [];
    const runtime = {
      sessionId: "session",
      rootTraceContext: traceContext,
      queueAutoDrain: false,
      queueExternalDrainActive: false,
      appendEvent: async (event: unknown) => {
        snapshots.push({
          autoDrain: runtime.queueAutoDrain,
          externalDrain: runtime.queueExternalDrainActive,
        });
        appended.push(event);
      },
    } as unknown as AgentRuntimeInternal;
    await steering.setQueueAutoDrain.call(runtime, {
      autoDrain: true,
      traceContext,
    });
    assert.deepEqual(snapshots, [{ autoDrain: true, externalDrain: true }]);
    await steering.setQueueAutoDrain.call(runtime, {
      autoDrain: false,
      traceContext,
    });
    assert.deepEqual(snapshots[1], { autoDrain: false, externalDrain: false });
    assert.equal(appended.length, 2);
  });
});

describe("rewind preview without adapters", () => {
  it("reports the missing checkpoint store instead of attempting a partial apply", async () => {
    const runtime = {
      rootTraceContext: traceContext,
      eventStore: { getEvents: async () => [] },
    } as unknown as AgentRuntimeInternal;
    const preview = await fileRewind.previewWorkspaceFileRewind.call(runtime, {
      traceContext,
    });
    assert.equal(preview.canApply, false);
    assert.equal(preview.unsafeFiles.length, 1);
    assert.equal(preview.unsafeFiles[0]?.reason, "checkpoint_unreadable");
    assert.equal(preview.safeFiles.length, 0);
  });
});

describe("rewind checkpoint planning", () => {
  it("applies a structured patch when afterContent is absent", () => {
    const after = resolveCheckpointAfterContent({
      path: "src/a.ts",
      existedBefore: true,
      beforeContent: "a\n",
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: ["-a", "+b"],
        },
      ],
    });
    assert.equal(after, "b\n");
  });

  it("returns undefined for an unsupported empty create checkpoint", () => {
    assert.equal(
      resolveCheckpointAfterContent({
        path: "src/new.ts",
        existedBefore: false,
        beforeContent: null,
        structuredPatch: [],
      }),
      undefined,
    );
  });

  it("selects workspace checkpoints by runtime turn id", () => {
    const events = [
      {
        type: "checkpoint_created",
        turnId: "turn-1",
        payload: { scope: "workspace", checkpointId: "cp-1", snapshotRef: "ref-1" },
      },
      {
        type: "checkpoint_created",
        turnId: "turn-1~q",
        payload: { scope: "workspace", checkpointId: "cp-2", snapshotRef: "ref-2" },
      },
      {
        type: "checkpoint_created",
        turnId: "turn-1",
        payload: { scope: "conversation", checkpointId: "cp-3" },
      },
    ] as never;
    const checkpoints = resolveTargetCheckpoints(events, { targetTurnId: "turn-1" as never });
    assert.deepEqual(
      checkpoints.map((checkpoint) => checkpoint.checkpointId),
      ["cp-1"],
    );
  });
});

describe("compact selection policy", () => {
  it("keeps truncation fallback only for manual/follow-up triggers", () => {
    assert.equal(canUseCompactSummaryTruncationFallback("manual" as never), true);
    assert.equal(canUseCompactSummaryTruncationFallback("auto" as never), false);
    assert.equal(canUseCompactSummaryTruncationFallback("reactive" as never), false);
  });

  it("caps the summary output by both the model and summary limits", () => {
    assert.equal(
      capCompactSummaryMaxOutputTokens({
        optionSpecs: { maxOutputTokens: { max: 4_000 } },
      } as never),
      4_000,
    );
  });

  it("resets the prompt-too-long attempt counter with the selection on a new attempt", () => {
    // 旧实现每次 attempt 重新初始化 counter；跨 attempt 复用的 state 必须在 reset 时清零。
    const entries = Array.from({ length: 5 }, (_, index) => [
      { message: { role: "assistant" as const, content: `answer ${index}` } },
      { message: { role: "user" as const, content: `question ${index}` } },
    ]).flat() as RuntimeMessageEntry[];
    const initialSelection = selectInitialCompactEntriesForActiveConversation({
      activeEntries: entries,
      trigger: "auto" as never,
    });
    const state = createCompactSelectionState(initialSelection);
    assert.equal(state.compactPromptTooLongAttempts, 0);
    assert.equal(state.currentSelection.groupsPreserved, initialSelection.groupsPreserved);

    const reselected = reselectCompactEntriesAfterPromptTooLong(state, {
      entries,
      promptTooLongCause: new Error("prompt too long"),
      trigger: "auto" as never,
    });
    assert.equal(reselected, true);
    assert.equal(state.compactPromptTooLongAttempts, 1);
    assert.notEqual(state.currentSelection.groupsPreserved, initialSelection.groupsPreserved);
    assert.notEqual(state.entriesForSummary, initialSelection.entriesForSummary);

    resetCompactSelectionState(state, initialSelection);
    assert.equal(state.compactPromptTooLongAttempts, 0);
    assert.equal(state.currentSelection.groupsPreserved, initialSelection.groupsPreserved);
    assert.deepEqual(state.preservedEntries, initialSelection.preservedEntries);
    assert.deepEqual(state.entriesForSummary, initialSelection.entriesForSummary);
    assert.deepEqual(state.entriesToSummarize, state.entriesForSummary);
  });
});

describe("regular turn loop state", () => {
  it("copies the admitted facts and keeps a single request-state entry snapshot", () => {
    const activeTurn = {
      kind: "regular",
      pendingInputs: [],
      steerable: true,
      traceContext,
      turnId: "turn-1",
      goalStateChangeReminderDeferralOpen: false,
    } as never;
    const entry = { message: { role: "user", content: { type: "text", text: "hi" } } };
    const historyEntries = [entry] as never;
    const state = createRegularTurnLoopState({
      activeTurn,
      admittedOutputStyle: undefined,
      events: [],
      historyEntries,
      input: "hi",
      model: { providerId: "p", modelId: "m" } as never,
      options: {
        automationId: "automation-1",
        modelExecution: { selectionScope: "execution" },
      } as never,
      traceId: "trace" as never,
      turnAbortSignal: new AbortController().signal,
      turnId: "turn-1" as never,
      turnMachine: {} as never,
      turnTraceContext: traceContext,
      userMessageId: "message-1" as never,
    });
    assert.equal(state.automationId, "automation-1");
    assert.equal(state.modelSelectionScope, "execution");
    assert.equal(state.modelResponse, "");
    assert.equal(state.anomalyWarningsInjected, 0);
    assert.equal(state.turnRequestState.entries.length, 1);
    assert.notEqual(state.turnRequestState.entries, historyEntries);
  });
});

describe("guide lane selection", () => {
  it("skips ordinary queue entries and returns the earliest inline guide", () => {
    const activeTurn = {
      pendingInputs: [
        { id: "queue-1", input: "q", delivery: "queue" },
        { id: "guide-1", input: "g1", delivery: "guide" },
        { id: "guide-2", input: "g2", delivery: "guide" },
      ],
    } as never;
    assert.equal(firstInlineGuideIndex(activeTurn), 1);
  });

  it("keeps compact and goal commands out of the inline guide lane", () => {
    const activeTurn = {
      pendingInputs: [
        { id: "compact", input: "/compact", delivery: "guide", commandKind: "compact" },
        { id: "goal", input: "/goal", delivery: "guide", commandKind: "sendGoalCommand" },
      ],
    } as never;
    assert.equal(firstInlineGuideIndex(activeTurn), -1);
  });
});
