import {
  SessionEventType,
  TurnMachineImpl,
  createModelUsageSummaryFromEvents,
  traceContextToLogContext,
} from "../deps.js";
import type { SessionEvent, SessionGoal, TraceContext, TurnId } from "../deps.js";
import { scheduleProjectMemoryExtraction } from "../helpers/project-memory-extraction.js";
import type { TurnResult, ExecuteTurnOptions } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { appendBrowserTurnScreenshot } from "./browser-turn-screenshot.js";
import { persistStableForkCompletionBoundary } from "./stable-fork-boundary.js";
import { recordTurnUsageFact } from "./usage-observability.js";

export async function completePreventedTurn(
  this: AgentRuntimeInternal,
  params: {
    activeTurn: RegularTurnLoopState["activeTurn"];
    events: SessionEvent[];
    inputId?: string;
    response: string;
    startedAtMs: number;
    startedTarget: SessionGoal | null;
    targetRunInputID: string;
    traceId: TraceContext["traceId"];
    turnId: TurnId;
    turnMachine: RegularTurnLoopState["turnMachine"];
    turnTraceContext: TraceContext;
  },
): Promise<TurnResult> {
  if (params.activeTurn) params.activeTurn.steerable = false;
  const turnMachine = new TurnMachineImpl(params.turnMachine.complete(params.response, "success"));
  const turnUsage = createModelUsageSummaryFromEvents(params.events);
  const completeEvent = this.createEvent(
    SessionEventType.TurnComplete,
    {
      response: params.response,
      tokenCount: 0,
      usage: turnUsage,
      toolCallCount: 0,
      duration: Date.now() - turnMachine.state.startedAt.getTime(),
      resultType: "success",
      cacheStats: this.messageHistory.getCacheStats(),
      inputId: params.inputId,
    },
    params.turnTraceContext,
  );
  await this.appendEvent(completeEvent, params.turnTraceContext);
  params.events.push(completeEvent);
  await recordTurnUsageFact(this, {
    completedAt: Date.now(),
    events: params.events,
    startedAt: params.startedAtMs,
    status: "completed",
    traceContext: params.turnTraceContext,
    turnId: params.turnId,
  });
  this.turnNumber++;
  const projection = await this.rebuildProjection();
  await this.accountTargetTurnCompletion({
    inputID: params.targetRunInputID,
    startedAtMs: params.startedAtMs,
    startedTarget: params.startedTarget,
    traceContext: params.turnTraceContext,
    usage: turnUsage,
  });
  return {
    response: params.response,
    turnId: params.turnId,
    traceId: params.traceId,
    usage: turnUsage,
    events: params.events,
    projection,
  };
}

export async function completeRegularTurn(
  this: AgentRuntimeInternal,
  params: {
    events: SessionEvent[];
    inputId?: string;
    loopState: RegularTurnLoopState;
    options?: ExecuteTurnOptions;
    startedAtMs: number;
    startedTarget: SessionGoal | null;
    targetRunInputID: string;
    traceId: TraceContext["traceId"];
    turnId: TurnId;
    turnTraceContext: TraceContext;
  },
): Promise<TurnResult> {
  const { events, loopState, options, turnTraceContext } = params;
  const turnUsage = createModelUsageSummaryFromEvents(events);
  // goal usage/active-run 先结算，再固定 exact goal/verifier boundary；只有两者都
  // 已持久化，TurnComplete 才能让 projection/UI 开放最终 assistant fork。
  await this.accountTargetTurnCompletion({
    inputID: params.targetRunInputID,
    startedAtMs: params.startedAtMs,
    startedTarget: params.startedTarget,
    traceContext: turnTraceContext,
    usage: turnUsage,
  });
  if (loopState.stableProductStartMessageId && loopState.stableBoundaryAssistantMessageId) {
    await persistStableForkCompletionBoundary(this, {
      boundaryMessageId: loopState.stableBoundaryAssistantMessageId,
      startMessageId: loopState.stableProductStartMessageId,
      historyRoundCount: loopState.historyRoundCount,
      traceContext: turnTraceContext,
    });
  }
  if (loopState.stableBoundaryAssistantMessageId) {
    await appendBrowserTurnScreenshot(this, loopState, loopState.stableBoundaryAssistantMessageId);
  }
  const completeEvent = this.createEvent(
    SessionEventType.TurnComplete,
    {
      response: loopState.modelResponse,
      tokenCount: loopState.tokenCount,
      usage: turnUsage,
      toolCallCount: loopState.toolCallCount,
      historyRoundCount: loopState.historyRoundCount,
      duration: Date.now() - loopState.turnMachine.state.startedAt.getTime(),
      resultType: "success",
      ...(loopState.backgroundSubagentResultConsumed
        ? { backgroundSubagentResultConsumed: true }
        : {}),
      ...(loopState.workflowResultConsumed ? { workflowResultConsumed: true } : {}),
      cacheStats: this.messageHistory.getCacheStats(),
      inputId: params.inputId,
    },
    turnTraceContext,
  );
  await this.appendEvent(completeEvent, turnTraceContext);
  events.push(completeEvent);
  await recordTurnUsageFact(this, {
    completedAt: Date.now(),
    events,
    startedAt: params.startedAtMs,
    status: "completed",
    traceContext: turnTraceContext,
    turnId: params.turnId,
    userMessageId: loopState.userMessageId,
  });
  this.turnNumber++;

  const projection = await this.rebuildProjection();
  this.logger?.info("Turn completed", {
    ...traceContextToLogContext(turnTraceContext),
    durationMs: Date.now() - loopState.turnMachine.state.startedAt.getTime(),
    event: "turn.completed",
    module: "core.runtime",
    status: "completed",
    toolCallCount: loopState.toolCallCount,
  });
  // 单轮执行策略只抑制本次成功 Turn 的后台提取，不修改 Session Memory 配置。
  if (options?.modelExecution?.memoryExtraction !== "skip") {
    scheduleProjectMemoryExtraction(this, {
      model: loopState.model,
      traceContext: turnTraceContext,
    });
  }

  return {
    response: loopState.modelResponse,
    turnId: params.turnId,
    traceId: params.traceId,
    usage: turnUsage,
    events,
    projection,
  };
}
