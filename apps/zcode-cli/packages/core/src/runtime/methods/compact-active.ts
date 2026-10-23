import { DEFERRED_TOOL_CALL_NAME, TOOL_SEARCH_NAME } from "@zcode/contracts";
import {
  CompactPhase,
  CompactReason,
  CompactTimelineStatus,
  CompactTrigger,
  SessionEventType,
  createMessageId,
  createPartId,
  traceContextToLogContext,
} from "../deps.js";
import type { Model, ModelToolContract, SessionEvent, TraceContext } from "../deps.js";
import type { CompactTimelineContext } from "../types.js";
import type { CompactAttemptOutcome } from "./turn-loop-state.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import { buildToolExposure } from "../../tool/search/exposure.js";
import {
  compactFailureReasonFromError,
  defaultCompactPhaseForTrigger,
  defaultCompactReasonForTrigger,
  estimateRuntimeEntryTokens,
  hasEnoughRuntimeEntriesToCompact,
  isTurnCancellationError,
  throwIfTurnAborted,
} from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { persistCompactTimelineEvent } from "./compact-active-helpers.js";
import { createRuntimeModel } from "./runtime-model.js";
import { commitActiveCompact } from "./compact-active-commit.js";
import { runCompactSummaryAttempts } from "./compact-active-request.js";
import {
  createCompactSelectionState,
  isAutoCompactRetryableError,
  resetCompactSelectionState,
  selectInitialCompactEntriesForActiveConversation,
} from "./compact-active-selection.js";

const AUTO_COMPACT_MAX_ATTEMPTS = 3;
const COMPACT_TOOL_KEEP_MAX_COUNT = 100;

export async function compactActiveConversation(
  this: AgentRuntimeInternal,
  customInstructions: string | undefined,
  turnTraceContext: TraceContext,
  events: SessionEvent[],
  options: {
    abortSignal?: AbortSignal;
    autoCompactThreshold?: number;
    compactReason?: CompactReason;
    initialPromptTooLongCause?: unknown;
    phase?: CompactPhase;
    sourceCommandId?: string;
    trigger?: CompactTrigger;
    model?: Model;
    activeEntries?: readonly RuntimeMessageEntry[];
    getContinuationTools?: () => readonly ModelToolContract[];
  } = {},
): Promise<{
  displayText: string;
  entries: readonly RuntimeMessageEntry[];
  outcome: Extract<CompactAttemptOutcome, "compacted" | "skipped">;
  tokenCount: number;
}> {
  return compactActiveConversationImpl.call(
    this,
    customInstructions,
    turnTraceContext,
    events,
    options,
  );
}

async function compactActiveConversationImpl(
  this: AgentRuntimeInternal,
  customInstructions: string | undefined,
  turnTraceContext: TraceContext,
  events: SessionEvent[],
  options: {
    abortSignal?: AbortSignal;
    autoCompactThreshold?: number;
    compactReason?: CompactReason;
    initialPromptTooLongCause?: unknown;
    phase?: CompactPhase;
    sourceCommandId?: string;
    trigger?: CompactTrigger;
    model?: Model;
    activeEntries?: readonly RuntimeMessageEntry[];
    getContinuationTools?: () => readonly ModelToolContract[];
  } = {},
): Promise<{
  displayText: string;
  entries: readonly RuntimeMessageEntry[];
  outcome: Extract<CompactAttemptOutcome, "compacted" | "skipped">;
  tokenCount: number;
}> {
  throwIfTurnAborted(options.abortSignal);
  const trigger = options.trigger ?? CompactTrigger.Manual;
  const phase = options.phase ?? defaultCompactPhaseForTrigger(trigger);
  const compactReason = options.compactReason ?? defaultCompactReasonForTrigger(trigger);
  const compactModel =
    options.model ??
    createRuntimeModel(this, {
      selection: this.getSessionModelSelection(),
    });
  // Active compact 会跨多个 await 保留这份成员浅快照；它依赖 RuntimeMessageEntry
  // 不可变约定。selection、provider render 和最终 replace 会创建各自拥有的副本，
  // 禁止在 compact 期间原地修改 activeEntries 内共享的 entry/message/content。
  const activeEntries = [
    ...(options.activeEntries ?? this.messageHistory.borrowReadOnlyRuntimeEntries()),
  ];
  const useMidConversationSystem =
    this.config.midConversationSystem?.mode === "force" ||
    compactModel.properties.supportsMidConversationSystem;
  const initialSelection = selectInitialCompactEntriesForActiveConversation({
    activeEntries,
    initialPromptTooLongCause: options.initialPromptTooLongCause,
    trigger,
    useMidConversationSystem,
  });
  const selection = createCompactSelectionState(initialSelection);
  const preCompactTokenCount = estimateRuntimeEntryTokens(activeEntries, {
    useMidConversationSystem,
  });
  const maxAttempts = trigger === CompactTrigger.Auto ? AUTO_COMPACT_MAX_ATTEMPTS : 1;
  let attempt = 1;
  const compactTimeline: CompactTimelineContext = {
    operationId: `cmp_${crypto.randomUUID()}`,
    messageId: createMessageId(),
    partId: createPartId(),
    trigger,
    phase,
    compactReason,
    ...(options.sourceCommandId ? { sourceCommandId: options.sourceCommandId } : {}),
    startedAt: Date.now(),
    preCompactTokenCount,
  };

  if (!hasEnoughRuntimeEntriesToCompact(selection.entriesForSummary)) {
    const skippedPayload = this.buildCompactTimelinePayload(compactTimeline, {
      endedAt: Date.now(),
      replace: true,
      status: CompactTimelineStatus.Skipped,
    });
    // 刚压缩过或历史太少时，/compact 是健康 no-op，不能暴露成系统故障。
    // 上层快速回填 tracker 只能记录真实 boundary，因此必须显式返回 skipped。
    await persistCompactTimelineEvent(
      this,
      SessionEventType.CompactCompleted,
      skippedPayload,
      turnTraceContext,
      events,
    );
    return {
      displayText: "Context is up to date; no compression needed",
      entries: activeEntries,
      outcome: "skipped",
      tokenCount: preCompactTokenCount,
    };
  }

  const compactStartedPayload = this.buildCompactTimelinePayload(compactTimeline, {
    ...(maxAttempts > 1 ? { attempt, maxAttempts } : {}),
    status: CompactTimelineStatus.Started,
  });
  await persistCompactTimelineEvent(
    this,
    SessionEventType.CompactStarted,
    compactStartedPayload,
    turnTraceContext,
    events,
  );
  // 止血原因：massive MCP 工具会把 compact summary request 的 provider context 撑爆。
  // ToolSearch/deferred tools 完成前，仅在工具数超过阈值时让 compact summary 保持无工具。
  await this.initializeMcp(turnTraceContext);
  throwIfTurnAborted(options.abortSignal);
  const runtimeCompactTools = this.getTools(compactModel);
  const registry = this.getToolRegistry();
  // Bug 根因：compact summary 曾直接携带完整工具目录，ToolSearch 关闭时大量 MCP schema
  // 会再次撑爆压缩请求；开启时只保留常驻控制入口和 MCP 候选，由同一 exposure 决策。
  let compactCandidates = runtimeCompactTools.filter(
    (tool) =>
      tool.name === "Read" ||
      tool.name === TOOL_SEARCH_NAME ||
      tool.name === DEFERRED_TOOL_CALL_NAME ||
      registry.get(tool.name)?.metadata.mcpPresentation,
  );
  if (
    !buildToolExposure({
      model: compactModel,
      mode: this.config.toolSearch?.mode,
      tools: compactCandidates,
      registry,
      entries: [],
    }).enabled
  ) {
    // 实际不可启用时恢复普通工具策略；只看 provider 能力会绕过数量保护。
    compactCandidates = runtimeCompactTools.filter(
      (tool) => tool.name !== TOOL_SEARCH_NAME && tool.name !== DEFERRED_TOOL_CALL_NAME,
    );
    if (compactCandidates.length > COMPACT_TOOL_KEEP_MAX_COUNT) compactCandidates = [];
  }

  while (true) {
    try {
      const summaryAttempt = await runCompactSummaryAttempts.call(this, {
        abortSignal: options.abortSignal,
        activeEntries,
        attempt,
        compactModel,
        compactTimeline,
        compactTools: compactCandidates,
        customInstructions,
        events,
        preCompactTokenCount,
        selection,
        trigger,
        turnTraceContext,
        useMidConversationSystem,
      });
      return await commitActiveCompact.call(this, {
        abortSignal: options.abortSignal,
        activeEntries,
        attempt,
        autoCompactThreshold: options.autoCompactThreshold,
        compactModel,
        compactTimeline,
        customInstructions,
        events,
        maxAttempts,
        preCompactTokenCount,
        replaceWithCanonicalPrefix: options.activeEntries !== undefined,
        selection,
        summaryAttempt,
        trigger,
        turnTraceContext,
        useMidConversationSystem,
        getContinuationTools: options.getContinuationTools,
      });
    } catch (error) {
      if (
        trigger === CompactTrigger.Auto &&
        attempt < maxAttempts &&
        !isTurnCancellationError(error, options.abortSignal) &&
        isAutoCompactRetryableError(error)
      ) {
        attempt += 1;
        const retryPayload = this.buildCompactTimelinePayload(compactTimeline, {
          attempt,
          maxAttempts,
          reason: compactFailureReasonFromError(error),
          status: CompactTimelineStatus.Retrying,
        });
        // 自动 compact 的中间失败不能提前落成 failed 横线。
        // 这里在同一个 operation 上发 retrying，直到第 3 次仍失败才写最终 failed。
        await persistCompactTimelineEvent(
          this,
          SessionEventType.CompactStarted,
          retryPayload,
          turnTraceContext,
          events,
        );
        this.logger?.warn("Auto compact retrying", {
          ...traceContextToLogContext(turnTraceContext),
          attempt,
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "compact.auto.retrying",
          maxAttempts,
          module: "core.runtime",
          timelineStatus: CompactTimelineStatus.Retrying,
        });
        resetCompactSelectionState(selection, initialSelection);
        continue;
      }
      await this.finishCompactTimelineFailure({
        abortSignal: options.abortSignal,
        attempt,
        error,
        events,
        maxAttempts: maxAttempts > 1 ? maxAttempts : undefined,
        timeline: compactTimeline,
        traceContext: turnTraceContext,
      });
      throw error;
    }
  }
}
