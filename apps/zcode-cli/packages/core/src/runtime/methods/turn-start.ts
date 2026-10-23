import { HookEventName } from "../deps.js";
import { parseCompactCommand, parseRewindCommand, throwIfTurnAborted } from "../helpers/index.js";
import type { Model, TraceContext, TurnId } from "../deps.js";
import type { ExecuteTurnOptions, TurnResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { applySubmissionExecutionState } from "./turn-model.js";
import { rebuildContextPrefix } from "./context-refresh.js";

/**
 * Turn 启动阶段：Context 投影 → SessionStart hooks → compact/rewind 命令分流。
 * 早退命令返回结果；普通 Turn 返回 undefined 后由原调用点继续 beginActiveTurn。
 */
export async function startRegularTurn(
  this: AgentRuntimeInternal,
  params: {
    admittedModel: Model | undefined;
    compactInstructions: ReturnType<typeof parseCompactCommand>;
    input: string;
    options?: ExecuteTurnOptions;
    rewindCommand: ReturnType<typeof parseRewindCommand>;
    turnAbortSignal: AbortSignal;
    turnId: TurnId;
    turnTraceContext: TraceContext;
    startPhase: (phase: string) => number;
    completePhase: (phase: string, startedAt: number) => void;
  },
): Promise<TurnResult | undefined> {
  const { admittedModel, input, options, turnAbortSignal, turnId, turnTraceContext } = params;
  let phaseStartedAt = params.startPhase("context_initialization");
  if (this.contextInitialized) {
    // 每个后续 model step 都按该步骤实际持有的 Model 重新投影 Context；
    // Session Selection 只决定未来创建哪个 Model，不能充当执行事实。
    rebuildContextPrefix(this, { model: admittedModel });
  } else {
    // 首轮初始化已经用 admitted Model 构造并安装完整 Context，随后再 rebuild
    // 会把同一 Prefix 连续构造两次。未初始化与已初始化分支互斥，每个 model step 只构造一次。
    await this.ensureContextInitialized(turnTraceContext, admittedModel);
  }
  params.completePhase("context_initialization", phaseStartedAt);
  throwIfTurnAborted(turnAbortSignal);
  phaseStartedAt = params.startPhase("session_start_hooks");
  const sessionStartHookResult = await this.runSessionStartHooks(
    "startup",
    turnTraceContext,
    turnAbortSignal,
    admittedModel,
  );
  params.completePhase("session_start_hooks", phaseStartedAt);
  this.injectHookAdditionalContextIntoMessageHistory(
    HookEventName.SessionStart,
    sessionStartHookResult.additionalContexts,
  );

  if (params.compactInstructions !== null) {
    const compactModel = await applySubmissionExecutionState(
      this,
      options?.intent,
      turnTraceContext,
      options?.modelExecution,
      admittedModel,
    );
    return this.executeManualCompact(
      input,
      params.compactInstructions,
      turnId,
      turnTraceContext,
      turnAbortSignal,
      options?.inputId,
      compactModel,
    );
  }
  if (params.rewindCommand !== null) {
    return this.executeRewindCommand(
      input,
      params.rewindCommand,
      turnId,
      turnTraceContext,
      turnAbortSignal,
      options?.inputId,
    );
  }
  return undefined;
}
