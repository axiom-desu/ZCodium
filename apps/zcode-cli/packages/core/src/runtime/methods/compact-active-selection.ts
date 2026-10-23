import { CompactTrigger, MAX_OUTPUT_TOKENS_FOR_SUMMARY, isCoreError } from "../deps.js";
import type { Logger, Model, TraceContext } from "../deps.js";
import {
  getRuntimeEntriesToSummarize,
  selectCompactEntries,
  selectCompactEntriesAfterPromptTooLong,
  selectCompactEntriesForInitialPromptTooLong,
  truncateCompactSummaryRequestEntriesAfterPromptTooLong,
  type CompactEntrySelection,
} from "../helpers/index.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import { resolveNormalRequestMaxOutputTokens } from "./model-token-limits.js";

export interface CompactSelectionState {
  currentSelection: CompactEntrySelection;
  preservedEntries: RuntimeMessageEntry[];
  entriesForSummary: RuntimeMessageEntry[];
  entriesToSummarize: RuntimeMessageEntry[];
  compactPromptTooLongAttempts: number;
}

export function createCompactSelectionState(
  initialSelection: CompactEntrySelection,
): CompactSelectionState {
  return {
    currentSelection: initialSelection,
    preservedEntries: initialSelection.preservedEntries,
    entriesForSummary: initialSelection.entriesForSummary,
    entriesToSummarize: getRuntimeEntriesToSummarize(initialSelection.entriesForSummary),
    compactPromptTooLongAttempts: 0,
  };
}

export function resetCompactSelectionState(
  state: CompactSelectionState,
  initialSelection: CompactEntrySelection,
): void {
  state.currentSelection = initialSelection;
  state.preservedEntries = initialSelection.preservedEntries;
  state.entriesForSummary = initialSelection.entriesForSummary;
  state.entriesToSummarize = getRuntimeEntriesToSummarize(initialSelection.entriesForSummary);
  // 旧 compact-active.ts 在外层 while(true){try{...}} 的每次 attempt 内部重新初始化 counter；
  // 拆出跨 attempt 复用的 CompactSelectionState 后，这里必须一并重置，避免上一 attempt 的
  // prompt-too-long 计数泄漏到下一次 autoCompact 重试的 ModelRequest/usage 归因。
  state.compactPromptTooLongAttempts = 0;
}

function applyCompactSelection(
  state: CompactSelectionState,
  selection: CompactEntrySelection,
): void {
  state.currentSelection = selection;
  state.preservedEntries = selection.preservedEntries;
  state.entriesForSummary = selection.entriesForSummary;
  state.entriesToSummarize = getRuntimeEntriesToSummarize(selection.entriesForSummary);
}

export function reselectCompactEntriesAfterPromptTooLong(
  state: CompactSelectionState,
  input: {
    entries: readonly RuntimeMessageEntry[];
    promptTooLongCause: unknown;
    trigger: CompactTrigger;
    useMidConversationSystem?: boolean;
  },
): boolean {
  const reselected = selectCompactEntriesAfterPromptTooLong({
    currentGroupsPreserved: state.currentSelection.groupsPreserved,
    entries: input.entries,
    promptTooLongCause: input.promptTooLongCause,
    trigger: input.trigger,
    useMidConversationSystem: input.useMidConversationSystem,
  });
  if (!reselected) return false;

  state.compactPromptTooLongAttempts += 1;
  applyCompactSelection(state, reselected);
  return true;
}

export function truncateCompactSummaryEntriesAfterPromptTooLong(
  state: CompactSelectionState,
  input: {
    cause: unknown;
    logger?: Logger;
    traceContext: TraceContext;
    trigger: CompactTrigger;
    useMidConversationSystem?: boolean;
  },
): boolean {
  if (!canUseCompactSummaryTruncationFallback(input.trigger)) return false;

  const truncated = truncateCompactSummaryRequestEntriesAfterPromptTooLong({
    attempt: state.compactPromptTooLongAttempts,
    cause: input.cause,
    entriesForSummary: state.entriesForSummary,
    logger: input.logger,
    traceContext: input.traceContext,
    useMidConversationSystem: input.useMidConversationSystem,
  });
  if (!truncated) return false;

  state.compactPromptTooLongAttempts += 1;
  state.entriesForSummary = truncated;
  state.entriesToSummarize = getRuntimeEntriesToSummarize(truncated);
  return true;
}

export function selectInitialCompactEntriesForActiveConversation(input: {
  activeEntries: readonly RuntimeMessageEntry[];
  initialPromptTooLongCause?: unknown;
  trigger: CompactTrigger;
  useMidConversationSystem?: boolean;
}): CompactEntrySelection {
  const baseSelection = selectCompactEntries({
    entries: input.activeEntries,
    trigger: input.trigger,
  });
  if (input.initialPromptTooLongCause === undefined) {
    return baseSelection;
  }

  return (
    selectCompactEntriesForInitialPromptTooLong({
      entries: input.activeEntries,
      promptTooLongCause: input.initialPromptTooLongCause,
      trigger: input.trigger,
      useMidConversationSystem: input.useMidConversationSystem,
    }) ?? baseSelection
  );
}

export function isAutoCompactRetryableError(error: unknown): boolean {
  return isCoreError(error) ? error.retryable : true;
}

export function canUseCompactSummaryTruncationFallback(trigger: CompactTrigger): boolean {
  return trigger !== CompactTrigger.Auto && trigger !== CompactTrigger.Reactive;
}

export function capCompactSummaryMaxOutputTokens(model: Model): number {
  // Compact 是独立执行链，在这里显式选择模型上限与 summary 20K 上限中的较小值。
  const desired = Math.min(
    resolveNormalRequestMaxOutputTokens({
      modelMaxOutputTokens: model.optionSpecs.maxOutputTokens.max,
    }),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  );
  return Math.min(desired, model.optionSpecs.maxOutputTokens.max);
}
