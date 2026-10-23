import {
  CompactTimelineStatus,
  SessionEventType,
  buildCompactSummaryMessage,
  buildManualCompactBoundary,
  createCompactBoundaryId,
  createMessageId,
  getUsageTotalTokens,
} from "../deps.js";
import type { CompactTrigger, Model, SessionEvent, TraceContext } from "../deps.js";
import {
  buildPostCompactReadStateReminderEntries,
  buildPostCompactRuntimeEntries,
  countCompactPreservedRuntimeMessages,
  estimateRuntimeEntryTokens,
  readApprovedPlanFileReferenceEntry,
} from "../helpers/index.js";
import { selectPersistedCompactTail } from "../helpers/compact-preservation.js";
import type { CompactTimelineContext } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  legacySyntheticRuntimeMetadata,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import {
  formatCompactSummaryOrThrow,
  persistCompactTimelineEvent,
} from "./compact-active-helpers.js";
import type { CompactSelectionState } from "./compact-active-selection.js";
import type { CompactSummaryAttemptResult } from "./compact-active-request.js";
import {
  filterOutputTokenContinuationEntries,
  preserveCanonicalContextPrefix,
} from "./turn-output-token-continuation.js";

export async function commitActiveCompact(
  this: AgentRuntimeInternal,
  params: {
    abortSignal?: AbortSignal;
    activeEntries: readonly RuntimeMessageEntry[];
    attempt: number;
    autoCompactThreshold?: number;
    compactModel: Model;
    compactTimeline: CompactTimelineContext;
    customInstructions: string | undefined;
    events: SessionEvent[];
    maxAttempts: number;
    preCompactTokenCount: number;
    replaceWithCanonicalPrefix: boolean;
    selection: CompactSelectionState;
    summaryAttempt: CompactSummaryAttemptResult;
    trigger: CompactTrigger;
    turnTraceContext: TraceContext;
    useMidConversationSystem: boolean;
  },
): Promise<{
  displayText: string;
  entries: readonly RuntimeMessageEntry[];
  outcome: "compacted";
  tokenCount: number;
}> {
  const { compactModel, compactTimeline, events, selection, trigger } = params;
  const { result, modelTraceContext, lastSummarizedMessageId } = params.summaryAttempt;
  const summary = formatCompactSummaryOrThrow(this, result);
  const persistedSummary = summary;
  const planFileReferenceEntry = this.fileSystemPort
    ? await readApprovedPlanFileReferenceEntry({
        abortSignal: params.abortSignal,
        fileSystemPort: this.fileSystemPort,
        sessionId: this.sessionId,
        traceContext: modelTraceContext,
        workspaceRoot: this.workspaceRoot,
      })
    : undefined;
  const postCompactReminderEntries = [
    ...(planFileReferenceEntry ? [planFileReferenceEntry] : []),
    ...buildPostCompactReadStateReminderEntries({
      preservedEntries: selection.preservedEntries,
      readFileState: this.readFileState,
    }),
  ];

  const modelCompleteEvent = this.createEvent(
    SessionEventType.ModelComplete,
    {
      content: summary,
      stopReason: result.finishReason,
      usage: result.usage,
      querySource: "compact",
      toolCallCount: 0,
    },
    modelTraceContext,
  );
  await this.appendEvent(modelCompleteEvent, modelTraceContext);
  events.push(modelCompleteEvent);

  const summaryMessageId = createMessageId();
  const summaryMessageContent = buildCompactSummaryMessage(persistedSummary, {
    suppressFollowup: true,
  });
  // Continue 没有对应 Session message；无 store 的统计也不能把它计入保留记录。
  const recordablePreservedEntries = filterOutputTokenContinuationEntries(
    selection.preservedEntries,
  );
  const preservation = this.sessionStore
    ? await selectPersistedCompactTail({
        sessionStore: this.sessionStore,
        sessionId: this.sessionId,
        groupsPreserved: selection.currentSelection.groupsPreserved,
        summaryMessageId,
      })
    : { keptMessageCount: countCompactPreservedRuntimeMessages(recordablePreservedEntries) };
  const postCompactEntries = buildPostCompactRuntimeEntries(
    params.activeEntries,
    {
      message: {
        role: "user",
        content: summaryMessageContent,
      },
      metadata: legacySyntheticRuntimeMetadata(),
    },
    {
      postCompactReminderEntries,
      preservedEntries: selection.preservedEntries,
    },
  );
  const truePostCompactTokenCount = estimateRuntimeEntryTokens(postCompactEntries, {
    useMidConversationSystem: params.useMidConversationSystem,
  });
  const providerPostCompactTokenCount = getUsageTotalTokens(result.usage);
  const compactBoundary = buildManualCompactBoundary({
    boundaryId: createCompactBoundaryId(),
    autoCompactThreshold: params.autoCompactThreshold,
    compactReason: compactTimeline.compactReason,
    customInstructions: params.customInstructions,
    lastSummarizedMessageId,
    phase: compactTimeline.phase,
    postCompactTokenCount: providerPostCompactTokenCount,
    preCompactTokenCount: params.preCompactTokenCount,
    summarizedMessageCount: selection.entriesToSummarize.length,
    summaryMessageId,
    traceContext: params.turnTraceContext,
    trigger,
    ...(selection.currentSelection.groupsPreserved > 0
      ? {
          keptMessageCount: preservation.keptMessageCount,
        }
      : {}),
    preservedSegment: preservation.preservedSegment,
    truePostCompactTokenCount,
    willRetriggerNextTurn:
      params.autoCompactThreshold !== undefined
        ? truePostCompactTokenCount >= params.autoCompactThreshold
        : undefined,
  });

  await this.persistCompactSummary(
    summaryMessageId,
    summaryMessageContent,
    persistedSummary,
    compactBoundary,
    modelTraceContext,
    {
      model: compactModel,
      operationId: compactTimeline.operationId,
      postCompactReminderEntries,
    },
  );

  const compactBoundaryEvent = this.createEvent(
    SessionEventType.CompactBoundary,
    compactBoundary,
    params.turnTraceContext,
  );
  await this.appendEvent(compactBoundaryEvent, params.turnTraceContext);
  events.push(compactBoundaryEvent);

  const compactCompletedPayload = this.buildCompactTimelinePayload(compactTimeline, {
    ...(params.maxAttempts > 1 ? { attempt: params.attempt, maxAttempts: params.maxAttempts } : {}),
    boundaryId: compactBoundary.boundaryId,
    endedAt: Date.now(),
    postCompactTokenCount: providerPostCompactTokenCount,
    replace: true,
    status: CompactTimelineStatus.Completed,
    summaryMessageId,
    tailStartMessageId: lastSummarizedMessageId,
    truePostCompactTokenCount,
  });
  await persistCompactTimelineEvent(
    this,
    SessionEventType.CompactCompleted,
    compactCompletedPayload,
    params.turnTraceContext,
    events,
  );

  this.latestConversationMessageId = summaryMessageId;
  const recordablePostCompactEntries = filterOutputTokenContinuationEntries(postCompactEntries);
  this.messageHistory.replaceMessages(
    params.replaceWithCanonicalPrefix
      ? preserveCanonicalContextPrefix(
          this.messageHistory.borrowReadOnlyRuntimeEntries(),
          recordablePostCompactEntries,
        )
      : recordablePostCompactEntries,
  );
  this.readFileState.clear();
  return {
    displayText: "Compacted",
    entries: postCompactEntries,
    outcome: "compacted",
    tokenCount: providerPostCompactTokenCount,
  };
}
