import { CoreErrorType } from "../deps.js";
import type { MessageId, SessionEvent, SessionGoal, TraceContext, TurnId } from "../deps.js";
import { appendTurnOutcomeEvent, createTurnFailureError } from "../helpers/index.js";
import type { ExecuteTurnOptions } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { recordTurnUsageFact } from "./usage-observability.js";

/** Turn 失败收口：保留 accepted queue、owner/lease 与 stale run 判定原分支。 */
export async function failTurnExecution(
  this: AgentRuntimeInternal,
  params: {
    activeTurn: RegularTurnLoopState["activeTurn"];
    error: unknown;
    events: SessionEvent[];
    loopState: RegularTurnLoopState | undefined;
    options?: ExecuteTurnOptions;
    startedAtMs: number;
    startedTarget: SessionGoal | null;
    targetRunInputID: string;
    turnAbortSignal: AbortSignal;
    turnId: TurnId;
    turnMachine: RegularTurnLoopState["turnMachine"];
    turnTraceContext: TraceContext;
    userMessageId: MessageId | undefined;
  },
): Promise<never> {
  const {
    activeTurn,
    events,
    loopState,
    options,
    turnAbortSignal,
    turnId,
    turnMachine,
    turnTraceContext,
    userMessageId,
  } = params;
  const coreError = createTurnFailureError(params.error, turnAbortSignal, "Turn execution failed");
  const preserveQueueAutoDrainOnCancel =
    coreError.type === CoreErrorType.TurnCancelled &&
    this.activeForegroundExecution?.preserveQueueAutoDrainOnCancel === true;
  let startedTarget = params.startedTarget;
  const finishedTarget = await this.finishTargetTurnAccounting({
    endedAtMs: Date.now(),
    inputID: params.targetRunInputID,
    startedTarget,
    status: coreError.type === CoreErrorType.TurnCancelled ? "paused" : undefined,
    traceContext: turnTraceContext,
  });
  if (finishedTarget?.targetID === startedTarget?.targetID) {
    startedTarget = finishedTarget;
  }
  if (coreError.type === CoreErrorType.TurnCancelled) {
    await this.pauseActiveTargetForCancellation(turnTraceContext);
    if (activeTurn) {
      await this.fallbackPendingGuidesToQueue({
        activeTurn,
        events,
        reasonCode: "guide.turnInterrupted",
        traceContext: turnTraceContext,
      });
    }
  }
  // 普通 TurnError 只结束当前 turn，不撤销已经 accepted 的 future input。
  // V4 TurnError 投影将队列切成 error-paused，runtime 同步关闭行内 drain，
  // 保留排队输入，等待用户显式继续。
  if (activeTurn && coreError.type !== CoreErrorType.TurnCancelled) {
    const pendingInputs = (await this.rebuildProjection()).pendingSteerInputs;
    if (pendingInputs.length > 0) {
      this.queueAutoDrain = false;
      this.queueExternalDrainActive = false;
    }
  } else if (
    activeTurn &&
    coreError.type === CoreErrorType.TurnCancelled &&
    !preserveQueueAutoDrainOnCancel &&
    activeTurn.pendingInputs.length > 0
  ) {
    // runtime 授权位与投影同步：投影在 TurnComplete(cancelled)+queue>0 时把
    // queue.autoDrain 置 false（held），runtime 的 drain 门也必须同步翻转，
    // 否则 held 期间新起的 turn 会把后续入队项 drain 掉，与投影语义分叉。
    this.queueAutoDrain = false;
    this.queueExternalDrainActive = false;
  }

  // background wake 可能在 loopState 初始化前取消；此时仍要保留已 dequeue 的结果事实。
  const backgroundSubagentResultConsumed =
    options?.backgroundSubagentResultConsumed === true ||
    loopState?.backgroundSubagentResultConsumed === true;
  const workflowResultConsumed =
    options?.workflowResultConsumed === true || loopState?.workflowResultConsumed === true;
  await appendTurnOutcomeEvent(this, {
    coreError,
    events,
    durationMs: Date.now() - turnMachine.state.startedAt.getTime(),
    turnPhase: turnMachine.state.phase,
    inputId: options?.inputId,
    traceContext: turnTraceContext,
    fallbackMessage: "Turn execution failed",
    logEvent: "turn.failed",
    logLabel: "Turn",
    preserveQueueAutoDrainOnCancel,
    backgroundSubagentResultConsumed,
    workflowResultConsumed,
    historyRoundCount: loopState?.historyRoundCount,
  });
  await recordTurnUsageFact(this, {
    completedAt: Date.now(),
    error: coreError,
    events,
    startedAt: params.startedAtMs,
    status: coreError.type === CoreErrorType.TurnCancelled ? "cancelled" : "error",
    traceContext: turnTraceContext,
    turnId,
    userMessageId,
  });
  throw coreError;
}
