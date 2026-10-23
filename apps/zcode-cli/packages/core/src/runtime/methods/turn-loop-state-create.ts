import type { OutputStylePromptConfig } from "../deps.js";
import type { MessageId, Model, SessionEvent, TraceContext, TurnId } from "../deps.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { ExecuteTurnOptions } from "../types.js";
import type { ActiveTurnSteeringState } from "../types.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";

/**
 * 普通 Turn 的 loop state 工厂：只复制调用方显式传入的本轮事实，
 * `turnRequestState` 仍持有唯一 provider-local 成员快照。
 */
export function createRegularTurnLoopState(params: {
  activeTurn: ActiveTurnSteeringState;
  admittedOutputStyle: OutputStylePromptConfig | undefined;
  events: SessionEvent[];
  historyEntries: readonly RuntimeMessageEntry[];
  input: string;
  model: Model;
  options?: ExecuteTurnOptions;
  traceId: TraceContext["traceId"];
  turnAbortSignal: AbortSignal;
  turnId: TurnId;
  turnMachine: RegularTurnLoopState["turnMachine"];
  turnTraceContext: TraceContext;
  userMessageId: MessageId;
}): RegularTurnLoopState {
  const { options } = params;
  return {
    activeTurn: params.activeTurn,
    ...(options?.automationId ? { automationId: options.automationId } : {}),

    anomalyWarningsInjected: 0,
    backgroundSubagentResultConsumed: options?.backgroundSubagentResultConsumed === true,
    workflowResultConsumed: options?.workflowResultConsumed === true,
    currentUserMessageId: params.userMessageId,
    events: params.events,
    input: params.input,
    modelResponse: "",
    model: params.model,
    ...(options?.modelExecution?.selectionScope === "execution"
      ? { modelSelectionScope: "execution" as const }
      : {}),
    ...(options?.modelExecution?.subagents && options.intent?.modelSelection
      ? {
          subagentModelOverride: {
            selection: options.intent.modelSelection,
            background: options.modelExecution.subagents.background,
          },
        }
      : {}),
    modelStepCount: 0,
    historyRoundCount: 0,
    reactiveCompactAttemptedInCurrentModelStep: false,
    repeatedToolCallSignature: undefined,
    repeatedToolCallStreakCount: 0,
    stopHookContinuationCount: 0,
    streamRecoveryRetryCount: 0,
    tokenCount: 0,
    toolCallCount: 0,
    turnRequestState: {
      // Turn 只借一次 canonical 成员集合，之后由显式 commit 推进；entry 本身
      // 遵循 MessageHistory 的不可变约定。
      entries: [...params.historyEntries],
      outputTokenContinuationCount: 0,
    },
    toolDisallowlist: options?.toolDisallowlist,
    traceId: params.traceId,
    turnAbortSignal: params.turnAbortSignal,
    turnId: params.turnId,
    turnMachine: params.turnMachine,
    turnOutputStyle: params.admittedOutputStyle,
    turnTraceContext: params.turnTraceContext,
    userMessageId: params.userMessageId,
  };
}
