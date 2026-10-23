import {
  CompactPhase,
  CompactReason,
  CompactTrigger,
  CoreErrorType,
  SessionEventType,
  createModelUsageSummaryFromEvents,
  runWithContextAsync,
  traceContextToLogContext,
  estimateMessageTokens,
  hasEnoughMessagesToCompact,
  shouldAutoCompact,
} from "../deps.js";
import type { AutoCompactPolicyConfig, SessionEvent, TraceContext, TurnId } from "../deps.js";
import {
  throwIfTurnAborted,
  createTurnFailureError,
  isTurnCancellationError,
  appendTurnOutcomeEvent,
  buildRuntimeProviderRequestMessages,
} from "../helpers/index.js";
import type { TurnResult } from "../types.js";
import type { Model } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { autoCompactDecisionLogContext } from "./compact-log-context.js";
import { resolveNormalRequestMaxOutputTokens } from "./model-token-limits.js";
import type {
  AutoCompactLoopContext,
  AutoCompactOutcome,
  CompactAttemptOutcome,
  ReactiveCompactLoopContext,
} from "./turn-loop-state.js";
import { recordTurnUsageFact } from "./usage-observability.js";
import {
  buildProviderUsageTokenOverride,
  estimateCurrentModelInputTokens,
} from "./compact-input-token-estimate.js";

// Compact 预算估算的实现已按职责提取；保留原 export 路径，供 turn-model-step 等既有调用方使用。
export { estimateCurrentModelInputTokens } from "./compact-input-token-estimate.js";

export async function executeManualCompact(
  this: AgentRuntimeInternal,
  input: string,
  customInstructions: string | undefined,
  turnId: TurnId,
  turnTraceContext: TraceContext,
  abortSignal?: AbortSignal,
  inputId?: string,
  model?: Model,
): Promise<TurnResult> {
  const events: SessionEvent[] = [];
  const startedAt = Date.now();
  const activeTurn = this.beginActiveTurn(turnId, turnTraceContext, "compact", false);
  return runWithContextAsync(turnTraceContext, async () => {
    this.logger?.info("Compact started", {
      ...traceContextToLogContext(turnTraceContext),
      event: "compact.started",
      inputLength: input.length,
      module: "core.runtime",
      status: "started",
    });

    await this.ensureSessionPersisted(input, turnTraceContext);

    const turnStartedEvent = this.createEvent(
      SessionEventType.TurnStarted,
      {
        turnNumber: this.turnNumber,
        input,
        inputId,
        // 手动 /compact 是维护命令，不是用户真实 query。
        // 事件仍保留 raw input 便于恢复/排查，但 v4 投影不能把它渲染成 user bubble。
        inputVisibility: "model-only",
      },
      turnTraceContext,
    );
    await this.appendEvent(turnStartedEvent, turnTraceContext);
    events.push(turnStartedEvent);

    try {
      throwIfTurnAborted(abortSignal);
      const compactResult = await this.compactActiveConversation(
        customInstructions,
        turnTraceContext,
        events,
        {
          abortSignal,
          compactReason: CompactReason.UserRequested,
          phase: CompactPhase.StandaloneTurn,
          ...(inputId ? { sourceCommandId: inputId } : {}),
          ...(model ? { model } : {}),
        },
      );
      throwIfTurnAborted(abortSignal);

      const turnUsage = createModelUsageSummaryFromEvents(events);
      const completeEvent = this.createEvent(
        SessionEventType.TurnComplete,
        {
          response: compactResult.displayText,
          tokenCount: compactResult.tokenCount,
          usage: turnUsage,
          toolCallCount: 0,
          historyRoundCount: 1,
          duration: Date.now() - startedAt,
          resultType: "success",
          cacheStats: this.messageHistory.getCacheStats(),
          inputId,
        },
        turnTraceContext,
      );
      await this.appendEvent(completeEvent, turnTraceContext);
      events.push(completeEvent);
      await recordTurnUsageFact(this, {
        completedAt: Date.now(),
        events,
        startedAt,
        status: "completed",
        traceContext: turnTraceContext,
        turnId,
      });

      this.turnNumber++;
      const projection = await this.rebuildProjection();
      this.logger?.info("Compact completed", {
        ...traceContextToLogContext(turnTraceContext),
        durationMs: Date.now() - startedAt,
        event: "compact.completed",
        module: "core.runtime",
        status: "completed",
      });

      return {
        response: compactResult.displayText,
        turnId,
        traceId: turnTraceContext.traceId,
        usage: turnUsage,
        events,
        projection,
      };
    } catch (error) {
      const coreError = createTurnFailureError(error, abortSignal, "Compact failed");
      const preserveQueueAutoDrainOnCancel =
        coreError.type === CoreErrorType.TurnCancelled &&
        this.activeForegroundExecution?.preserveQueueAutoDrainOnCancel === true;
      if (coreError.type === CoreErrorType.TurnCancelled && !preserveQueueAutoDrainOnCancel) {
        // Stop compact 与普通 Stop 语义一致：队列重新暂停，外层 FIFO 恢复窗口同时关闭。
        this.queueAutoDrain = false;
        this.queueExternalDrainActive = false;
      }
      await appendTurnOutcomeEvent(this, {
        coreError,
        events,
        durationMs: Date.now() - startedAt,
        turnPhase: "compact",
        inputId,
        traceContext: turnTraceContext,
        fallbackMessage: "Compact failed",
        logEvent: "compact.failed",
        logLabel: "Compact",
        preserveQueueAutoDrainOnCancel,
      });
      await recordTurnUsageFact(this, {
        completedAt: Date.now(),
        error: coreError,
        events,
        startedAt,
        status: coreError.type === CoreErrorType.TurnCancelled ? "cancelled" : "error",
        traceContext: turnTraceContext,
        turnId,
      });

      throw coreError;
    }
  }).finally(() => {
    this.finishActiveTurn(activeTurn);
  });
}

export async function autoCompactIfNeeded(
  this: AgentRuntimeInternal,
  turnTraceContext: TraceContext,
  events: SessionEvent[],
  abortSignal: AbortSignal | undefined,
  context: AutoCompactLoopContext,
): Promise<AutoCompactOutcome> {
  throwIfTurnAborted(abortSignal);

  const config: AutoCompactPolicyConfig = {
    contextWindow: context.model.properties.contextWindow,
    ...this.config.compact,
    maxOutputTokens: resolveNormalRequestMaxOutputTokens({
      modelMaxOutputTokens: context.model.optionSpecs.maxOutputTokens.max,
    }),
    modelContextBudgetStrategy: this.config.modelContextBudgetStrategy,
  };
  const activeEntries = context.turnRequestState.entries;
  const activeProjection = buildRuntimeProviderRequestMessages(this, {
    entries: activeEntries,
    applyCacheControl: false,
    model: context.model,
  });
  const { messages: activeMessages, sourceEntries } = activeProjection;
  const tokenOverride = buildProviderUsageTokenOverride(activeMessages, sourceEntries);
  const decision = shouldAutoCompact({
    messages: activeMessages,
    config,
    consecutiveFailures: this.autoCompactConsecutiveFailures,
    tokenOverride,
  });

  if (!decision.shouldCompact) {
    this.logger?.debug("Auto compact skipped", {
      ...traceContextToLogContext(turnTraceContext),
      event: "compact.auto.skipped",
      module: "core.runtime",
      compactReason: context.compactReason,
      modelStepIndex: context.modelStepIndex,
      phase: context.phase,
      reason: decision.reason,
      ...autoCompactDecisionLogContext(decision),
    });
    return "skipped";
  }

  if (context.rapidRefill.shouldBlock) {
    this.logger?.warn("Autocompact rapid-refill breaker tripped", {
      ...traceContextToLogContext(turnTraceContext),
      event: "compact.rapid_refill_breaker",
      compactReason: context.compactReason,
      consecutiveRapidRefills: context.rapidRefill.consecutiveRapidRefills,
      modelStepIndex: context.modelStepIndex,
      module: "core.runtime",
      phase: context.phase,
      status: "failed",
      toolTurnsSinceCompact: context.rapidRefill.toolTurnsSinceCompact,
      trigger: CompactTrigger.Auto,
      ...autoCompactDecisionLogContext(decision),
    });
    return "rapid_refill_blocked";
  }

  this.logger?.info("Auto compact started", {
    ...traceContextToLogContext(turnTraceContext),
    event: "compact.auto.started",
    compactReason: context.compactReason,
    modelStepIndex: context.modelStepIndex,
    module: "core.runtime",
    phase: context.phase,
    ...autoCompactDecisionLogContext(decision),
  });

  try {
    const compactResult = await this.compactActiveConversation(
      undefined,
      turnTraceContext,
      events,
      {
        abortSignal,
        autoCompactThreshold: decision.threshold,
        compactReason: context.compactReason,
        phase: context.phase,
        trigger: CompactTrigger.Auto,
        activeEntries,
        getContinuationTools: context.getContinuationTools,
        ...(context.model ? { model: context.model } : {}),
      },
    );
    if (compactResult.outcome === "skipped") {
      return "skipped";
    }
    context.turnRequestState.entries = compactResult.entries;
    this.autoCompactConsecutiveFailures = 0;
    this.logger?.info("Auto compact completed", {
      ...traceContextToLogContext(turnTraceContext),
      event: "compact.auto.completed",
      compactReason: context.compactReason,
      modelStepIndex: context.modelStepIndex,
      module: "core.runtime",
      phase: context.phase,
      ...autoCompactDecisionLogContext(decision),
    });
    return "compacted";
  } catch (error) {
    if (isTurnCancellationError(error, abortSignal)) {
      throw error;
    }
    this.autoCompactConsecutiveFailures++;
    this.logger?.warn("Auto compact failed", {
      ...traceContextToLogContext(turnTraceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "compact.auto.failed",
      failureCount: this.autoCompactConsecutiveFailures,
      compactReason: context.compactReason,
      modelStepIndex: context.modelStepIndex,
      module: "core.runtime",
      phase: context.phase,
      ...autoCompactDecisionLogContext(decision),
    });
    return "failed";
  }
}

export async function reactiveCompactAfterContextExceeded(
  this: AgentRuntimeInternal,
  originalError: unknown,
  turnTraceContext: TraceContext,
  events: SessionEvent[],
  abortSignal: AbortSignal | undefined,
  context: ReactiveCompactLoopContext,
): Promise<CompactAttemptOutcome> {
  throwIfTurnAborted(abortSignal);

  if (this.config.compact?.enabled === false) {
    this.logger?.warn("Reactive compact skipped because compact is disabled", {
      ...traceContextToLogContext(turnTraceContext),
      errorMessage: originalError instanceof Error ? originalError.message : String(originalError),
      event: "compact.reactive.skipped",
      modelStepIndex: context.modelStepIndex,
      module: "core.runtime",
      rapidRefillCount: context.rapidRefillCount,
      reason: "disabled",
    });
    return "skipped";
  }

  const activeEntries = context.activeEntries ?? context.turnRequestState.entries;
  const activeProjection = buildRuntimeProviderRequestMessages(this, {
    entries: activeEntries,
    applyCacheControl: false,
    model: context.model,
  });
  const { messages: activeMessages } = activeProjection;
  if (!hasEnoughMessagesToCompact(activeMessages)) {
    this.logger?.warn("Reactive compact skipped because there is not enough history", {
      ...traceContextToLogContext(turnTraceContext),
      errorMessage: originalError instanceof Error ? originalError.message : String(originalError),
      event: "compact.reactive.skipped",
      messageCount: activeMessages.length,
      modelStepIndex: context?.modelStepIndex,
      module: "core.runtime",
      rapidRefillCount: context?.rapidRefillCount,
      reason: "not_enough_messages",
    });
    return "skipped";
  }

  this.logger?.warn("Reactive compact started after model context overflow", {
    ...traceContextToLogContext(turnTraceContext),
    errorMessage: originalError instanceof Error ? originalError.message : String(originalError),
    event: "compact.reactive.started",
    messageCount: activeMessages.length,
    modelStepIndex: context?.modelStepIndex,
    module: "core.runtime",
    rapidRefillCount: context?.rapidRefillCount,
    tokenCount: estimateMessageTokens(activeMessages),
  });

  try {
    const compactResult = await this.compactActiveConversation(
      undefined,
      turnTraceContext,
      events,
      {
        abortSignal,
        compactReason: CompactReason.ProviderOverflow,
        initialPromptTooLongCause: originalError,
        phase: CompactPhase.Reactive,
        trigger: CompactTrigger.Reactive,
        activeEntries,
        getContinuationTools: context.getContinuationTools,
        model: context.model,
      },
    );
    if (compactResult.outcome === "skipped") {
      return "skipped";
    }
    context.turnRequestState.entries = compactResult.entries;
    this.autoCompactConsecutiveFailures = 0;
    this.logger?.info("Reactive compact completed; retrying model request", {
      ...traceContextToLogContext(turnTraceContext),
      event: "compact.reactive.completed",
      modelStepIndex: context?.modelStepIndex,
      module: "core.runtime",
      rapidRefillCount: context?.rapidRefillCount,
    });
    return "compacted";
  } catch (error) {
    if (isTurnCancellationError(error, abortSignal)) {
      throw error;
    }
    this.autoCompactConsecutiveFailures++;
    this.logger?.warn("Reactive compact failed after model context overflow", {
      ...traceContextToLogContext(turnTraceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "compact.reactive.failed",
      failureCount: this.autoCompactConsecutiveFailures,
      modelStepIndex: context?.modelStepIndex,
      module: "core.runtime",
      rapidRefillCount: context?.rapidRefillCount,
    });
    return "failed";
  }
}
