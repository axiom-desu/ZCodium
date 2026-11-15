import {
  CompactTimelineStatus,
  SessionEventType,
  buildCompactSummaryMessage,
  buildManualCompactBoundary,
  createCompactBoundaryId,
  createMessageId,
  getUsageTotalTokens,
} from "../deps.js";
import type {
  CompactTrigger,
  Model,
  ModelToolContract,
  SessionEvent,
  TraceContext,
} from "../deps.js";
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
import { supersedeContextComposition } from "../context-composition/state.js";
import { resetProjectMemoryRecall } from "../helpers/project-memory-recall.js";
import {
  legacySyntheticRuntimeMetadata,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import { buildToolSearchAnnouncement } from "../../tool/search/exposure.js";
import { collectDiscoveredTools, compactDiscoveryMetadata } from "../../tool/search/history.js";
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
import { clearPromptSnapshot } from "../helpers/prompt-snapshot.js";
import { rollOverTotalTokensBudget } from "../helpers/total-tokens-budget.js";
import { latestContextTokens } from "./turn-model-step-usage.js";
import { rebuildContextPrefix } from "./context-refresh.js";
import {
  applyRereadInstructionSources,
  rereadInstructionSources,
} from "./context-instruction-reread.js";

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
    getContinuationTools?: () => readonly ModelToolContract[];
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
  // 成功 compact 才写发现检查点；名字来自已提交引用与上一条有效边界，失败/取消不产生发现。
  const preCompactDiscoveredTools = collectDiscoveredTools(params.activeEntries);
  const discovery = compactDiscoveryMetadata({
    boundaryId: createCompactBoundaryId(),
    preCompactDiscoveredTools: [...preCompactDiscoveredTools],
  });
  // 新检查点尚未提交；公告使用同一候选分类，避免把即将提升的工具重新公告为待加载。
  const toolAnnouncement = buildToolSearchAnnouncement(
    {
      model: compactModel,
      mode: this.config.toolSearch?.mode,
      tools: params.getContinuationTools?.() ?? this.getTools(compactModel),
      registry: this.getToolRegistry(),
      entries: selection.preservedEntries,
    },
    preCompactDiscoveredTools,
  );
  const postCompactReminderEntries = [
    ...(planFileReferenceEntry ? [planFileReferenceEntry] : []),
    ...buildPostCompactReadStateReminderEntries({
      preservedEntries: selection.preservedEntries,
      readFileState: this.readFileState,
    }),
    ...(toolAnnouncement ? [toolAnnouncement] : []),
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
      metadata: { ...legacySyntheticRuntimeMetadata(), compactBoundary: discovery },
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
    boundaryId: discovery.boundaryId,
    preCompactDiscoveredTools: discovery.preCompactDiscoveredTools,
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
  // compact 重建了 provider 窗口：Recall 的 manifest conversation、prefetch 与字符计数全部作废。
  resetProjectMemoryRecall(this);
  // compact 替换了历史：最近一次请求组成作废，查询改为预演（子 spec §2.1）。
  supersedeContextComposition(this, "compact");
  // 指令文件与 Memory 索引在压缩提交后重读：会话中途改过的 AGENTS.md / MEMORY.md
  // 以"after the conversation was compacted"的增量公告交给模型（上游 3.18.2 F1）。
  const instructionReread = await rereadInstructionSources.call(
    this,
    params.turnTraceContext,
    params.abortSignal,
  );
  if (instructionReread) {
    applyRereadInstructionSources.call(this, instructionReread, compactModel);
  }
  // total_tokens 预算按压缩前上下文结转：压缩后不回到满额（上游 3.18.2 F2）。
  this.totalTokensBudget = rollOverTotalTokensBudget(
    this.totalTokensBudget,
    latestContextTokens(params.activeEntries),
  );
  // compaction 之后的窗口按当前代码重新组装 system：清掉 prompt 快照，并重建历史与
  // 本轮请求的前缀，下一次主循环请求重新记录（上游 3.18.2 F3）。
  // 不重建时旧 system 会被当成新快照记下来。
  const clearedPromptSnapshot = await clearPromptSnapshot(this, params.turnTraceContext);
  const entries = clearedPromptSnapshot
    ? rebuildContextPrefix(this, {
        model: compactModel,
        turnRequestEntries: recordablePostCompactEntries,
      })
    : postCompactEntries;
  return {
    displayText: "Compacted",
    entries,
    outcome: "compacted",
    tokenCount: providerPostCompactTokenCount,
  };
}
