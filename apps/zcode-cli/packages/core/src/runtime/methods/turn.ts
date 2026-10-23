import { beginLocalTurnPreparation, type LocalTtftDetail } from "@zcode/contracts";
import {
  HookEventName,
  SessionEventType,
  createChildTraceContext,
  createQueryId,
  createMessageId,
  createTurnId,
  runWithContextAsync,
  traceContextToLogContext,
  TurnMachineImpl,
} from "../deps.js";
import type {
  HookRunResult,
  MessageId,
  QueryId,
  SessionEvent,
  SessionGoal,
  TurnState,
} from "../deps.js";
import {
  parseCompactCommand,
  parseRewindCommand,
  createTurnAbortScope,
  throwIfTurnAborted,
  createTurnFailureError,
  appendTurnOutcomeEvent,
  summarizeTurnAttachmentsForEvent,
} from "../helpers/index.js";
import type { ActiveTurnSteeringState, ExecuteTurnOptions, TurnResult } from "../types.js";
import type { ActiveTurnStartReservation } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { createRuntimeCommandId } from "../command-queue.js";
import type { PromptRuntimeCommand } from "../command-queue.js";
import { enqueueCancellableRuntimeCommand } from "./runtime-command-submit.js";
import { runRegularTurnLoop } from "./turn-loop.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { finishOutputTokenRecovery } from "./turn-output-token-continuation.js";
import {
  closeGoalStateChangeReminderDeferral,
  openGoalStateChangeReminderDeferral,
} from "./goal-state-reminder.js";
import { applySubmissionExecutionState, createTurnModel } from "./turn-model.js";
import { applyRegularTurnUserInput } from "./turn-user-input.js";
import { createRegularTurnLoopState } from "./turn-loop-state-create.js";
import { completePreventedTurn, completeRegularTurn } from "./turn-completion.js";
import { cleanupTurnExecution } from "./turn-cleanup.js";
import { failTurnExecution } from "./turn-failure.js";
import { startRegularTurn } from "./turn-start.js";
import { startTargetRunHeartbeat } from "./turn-target-heartbeat.js";

const TARGET_RUN_HEARTBEAT_MS = 15_000;

export async function executeTurn(
  this: AgentRuntimeInternal,
  input: string,
  attachments?: TurnState["attachments"],
  options?: ExecuteTurnOptions,
): Promise<TurnResult> {
  return await enqueueCancellableRuntimeCommand<TurnResult, PromptRuntimeCommand>(this, {
    abortSignal: options?.abortSignal,
    createCommand: ({ reject, resolve }) => ({
      attachments,
      createdAt: new Date(),
      id: createRuntimeCommandId(),
      input,
      mode: "prompt",
      options,
      priority: "next",
      reject,
      resolve,
      traceContext: options?.traceContext ?? this.rootTraceContext,
    }),
  });
}

export async function executeTurnCommand(
  this: AgentRuntimeInternal,
  input: string,
  attachments?: TurnState["attachments"],
  options?: ExecuteTurnOptions,
  startReservation?: ActiveTurnStartReservation,
): Promise<TurnResult> {
  // 普通 Turn 过去在异步初始化完成后才读取 Session Selection/输出样式，
  // 初始化期间发生的切模会越过 admission 边界，错误影响已经开始的 Turn。
  // 这里在任何 await 之前冻结本轮事实；后续配置变化只作用于下一轮。
  const admittedModelSelection = options?.intent?.modelSelection ?? this.getSessionModelSelection();
  const admittedOutputStyle = this.config.outputStyle;
  const compactInstructions = parseCompactCommand(input);
  const rewindCommand = parseRewindCommand(input);
  const turnId = startReservation?.turnId ?? createTurnId();
  const queryId = options?.queryId ?? (options?.inputId as QueryId | undefined) ?? createQueryId();
  const displayInput = options?.displayInput ?? input;
  const turnTraceContext =
    startReservation?.traceContext ??
    createChildTraceContext(options?.traceContext ?? this.rootTraceContext, {
      queryId,
      sessionId: this.sessionId,
      turnId,
      attributes: {
        turnNumber: this.turnNumber,
      },
    });
  const traceId = turnTraceContext.traceId;
  const turnStartedAtMs = Date.now();
  const targetRunInputID = options?.inputId ?? String(turnId);
  const events: SessionEvent[] = [];
  let turnMachine = TurnMachineImpl.create(this.sessionId, this.turnNumber, input, traceId, turnId);
  this.currentTurnFileChanges = new Map();
  if (!startReservation) this.reserveTurnStart(turnId, turnTraceContext, "regular");

  const turnAbortScope = createTurnAbortScope(options?.abortSignal);
  const turnAbortSignal = turnAbortScope.signal;
  let activeTurn: ActiveTurnSteeringState | undefined;
  let startedTarget: SessionGoal | null = null;
  let targetRunHeartbeat: ReturnType<typeof setInterval> | undefined;
  let userMessageId: MessageId | undefined;
  let loopState: RegularTurnLoopState | undefined;
  // 线上“已工作 N 秒”但没有终态的根因候选是：内层 Turn try/catch 之前的 await
  // 拒绝直接穿出。记录当前阶段并区分是否已被内层处理，便于生产日志还原卡点。
  let turnPhase = "queued";
  let turnFailureHandled = false;
  let finishPreparation: () => void = () => {};
  const preparationStages: Record<string, LocalTtftDetail["stage"]> = {
    context_initialization: "context",
    session_start_hooks: "hooks",
    user_prompt_hooks: "hooks",
    session_persistence: "persistence",
    turn_started_event: "persistence",
    target_accounting: "persistence",
  };
  const startTurnPhase = (phase: string): number => {
    const stage = preparationStages[phase];
    finishPreparation =
      stage && stage !== "attempt" && stage !== "retry_wait" && stage !== "user_confirmation"
        ? beginLocalTurnPreparation(turnTraceContext, stage)
        : () => {};
    turnPhase = phase;
    const startedAt = Date.now();
    this.logger?.info("Turn phase started", {
      ...traceContextToLogContext(turnTraceContext),
      event: "turn.phase.started",
      module: "core.runtime",
      phase,
      status: "started",
    });
    return startedAt;
  };
  const completeTurnPhase = (phase: string, startedAt: number): void => {
    finishPreparation();
    this.logger?.info("Turn phase completed", {
      ...traceContextToLogContext(turnTraceContext),
      durationMs: Date.now() - startedAt,
      event: "turn.phase.completed",
      module: "core.runtime",
      phase,
      status: "completed",
    });
  };

  const execute = () =>
    runWithContextAsync(turnTraceContext, async () => {
      const executionStartedAt = performance.timeOrigin + performance.now();
      beginLocalTurnPreparation(turnTraceContext, "execution")();
      throwIfTurnAborted(turnAbortSignal);
      let admittedModel;
      try {
        admittedModel =
          rewindCommand === null
            ? createTurnModel(this, {
                selection: admittedModelSelection,
              })
            : undefined;
      } catch (error) {
        // 同步滞后/模型失效可在内层 Turn try 之前创建失败。只写日志会让已接纳输入
        // 没有终态、桌面与手机都看不到错误；复用 outcome，不等待同步、不改原选择。
        turnFailureHandled = true;
        const coreError = createTurnFailureError(error, turnAbortSignal, "Model creation failed");
        await appendTurnOutcomeEvent(this, {
          coreError,
          events,
          durationMs: Date.now() - turnStartedAtMs,
          turnPhase: "model_creation",
          inputId: options?.inputId,
          traceContext: turnTraceContext,
          fallbackMessage: "Model creation failed",
          logEvent: "turn.failed",
          logLabel: "Turn",
        });
        throw coreError;
      }
      let phaseStartedAt = 0;
      const earlyResult = await startRegularTurn.call(this, {
        admittedModel,
        compactInstructions,
        completePhase: completeTurnPhase,
        input,
        options,
        rewindCommand,
        startPhase: startTurnPhase,
        turnAbortSignal,
        turnId,
        turnTraceContext,
      });
      if (earlyResult) return earlyResult;
      activeTurn = this.beginActiveTurn(
        turnId,
        turnTraceContext,
        "regular",
        true,
        options?.inputId === undefined ? {} : { inputId: options.inputId },
      );
      this.logger?.info("Turn started", {
        ...traceContextToLogContext(turnTraceContext),
        event: "turn.started",
        inputLength: input.length,
        module: "core.runtime",
        status: "started",
      });

      turnMachine = new TurnMachineImpl(turnMachine.start());
      phaseStartedAt = startTurnPhase("session_persistence");
      await this.ensureSessionPersisted(displayInput, turnTraceContext);
      // execution-scoped 临时 Provider拥有本轮自己的模型，不改写
      // Session Selection；普通 Submission 才在真正开跑时应用其原子选择。
      const submissionModel = await applySubmissionExecutionState(
        this,
        options?.intent,
        turnTraceContext,
        options?.modelExecution,
        admittedModel,
      );
      startedTarget = await this.readSessionTargetForContext(turnTraceContext);
      completeTurnPhase("target_read", phaseStartedAt);
      if (startedTarget?.status !== "active") {
        startedTarget = null;
      }
      userMessageId =
        options?.skipInputRecord === true
          ? (options.recordedInputMessageId ?? createMessageId())
          : createMessageId();
      // 附件展示元信息随 TurnStarted 下发（v4 投影 → userInput row.attachments）。
      // workspace checkpoint 挂在 user messageId 上；先生成 id 再发 TurnStarted，
      // v4 投影才能用 turn rowId 找回该轮文件 checkpoint，避免摘要有计数但展开查空。
      const attachmentMetas = summarizeTurnAttachmentsForEvent(attachments);
      const turnStartedEvent = this.createEvent(
        SessionEventType.TurnStarted,
        {
          executionStartedAt,
          turnNumber: this.turnNumber,
          input: displayInput,
          messageId: userMessageId,
          inputId: options?.inputId,
          ...(options?.automationId ? { automationId: options.automationId } : {}),
          foregroundExecutionId: this.activeForegroundExecution?.foregroundExecutionId,
          queryId,
          inputSource: options?.inputSource,
          inputVisibility: options?.inputVisibility,
          originMeta: options?.originMeta,
          ...(options?.epilogueStart === undefined ? {} : { epilogueStart: options.epilogueStart }),
          ...(options?.backgroundSource ? { backgroundSource: options.backgroundSource } : {}),
          targetId: options?.targetId,
          ...(options?.intent ? { intent: options.intent } : {}),
          ...(attachmentMetas ? { attachments: attachmentMetas } : {}),
        },
        turnTraceContext,
      );
      phaseStartedAt = startTurnPhase("turn_started_event");
      await this.appendEvent(turnStartedEvent, turnTraceContext);
      completeTurnPhase("turn_started_event", phaseStartedAt);
      events.push(turnStartedEvent);
      phaseStartedAt = startTurnPhase("target_accounting");
      startedTarget = await this.startTargetTurnAccounting({
        inputID: targetRunInputID,
        startedAtMs: turnStartedAtMs,
        startedTarget,
        traceContext: turnTraceContext,
      });
      completeTurnPhase("target_accounting", phaseStartedAt);
      targetRunHeartbeat = startTargetRunHeartbeat(
        this,
        { inputID: targetRunInputID, startedTarget, traceContext: turnTraceContext },
        TARGET_RUN_HEARTBEAT_MS,
      );

      try {
        phaseStartedAt = startTurnPhase("user_prompt_hooks");
        const userPromptHookResult: HookRunResult = options?.skipUserPromptSubmitHooks
          ? { additionalContexts: [] }
          : await this.runUserPromptSubmitHooks(
              input,
              attachments,
              turnTraceContext,
              turnAbortSignal,
            );
        completeTurnPhase("user_prompt_hooks", phaseStartedAt);
        if (userPromptHookResult.preventContinuation) {
          return await completePreventedTurn.call(this, {
            activeTurn,
            events,
            inputId: options?.inputId,
            response: userPromptHookResult.stopReason ?? "Prompt blocked by UserPromptSubmit hook.",
            startedAtMs: turnStartedAtMs,
            startedTarget,
            targetRunInputID,
            traceId,
            turnId,
            turnMachine,
            turnTraceContext,
          });
        }
        this.injectHookAdditionalContextIntoMessageHistory(
          HookEventName.UserPromptSubmit,
          userPromptHookResult.additionalContexts,
        );
        await applyRegularTurnUserInput.call(this, {
          attachments,
          displayInput,
          input,
          options,
          turnAbortSignal,
          turnId,
          turnTraceContext,
          userMessageId,
        });

        const loopModel = submissionModel ?? admittedModel;
        if (!loopModel) {
          throw new Error("Turn model was not created before execution");
        }
        loopState = createRegularTurnLoopState({
          activeTurn,
          admittedOutputStyle,
          events,
          historyEntries: this.messageHistory.borrowReadOnlyRuntimeEntries(),
          input,
          model: loopModel,
          options,
          traceId,
          turnAbortSignal,
          turnId,
          turnMachine,
          turnTraceContext,
          userMessageId,
        });

        openGoalStateChangeReminderDeferral(activeTurn);
        phaseStartedAt = startTurnPhase("regular_turn_loop");
        try {
          await runRegularTurnLoop.call(this, loopState);
          completeTurnPhase("regular_turn_loop", phaseStartedAt);
        } finally {
          finishOutputTokenRecovery(loopState.turnRequestState);
          await closeGoalStateChangeReminderDeferral.call(this, activeTurn, turnTraceContext);
        }
        turnMachine = loopState.turnMachine;

        return await completeRegularTurn.call(this, {
          events,
          inputId: options?.inputId,
          loopState,
          options,
          startedAtMs: turnStartedAtMs,
          startedTarget,
          targetRunInputID,
          traceId,
          turnId,
          turnTraceContext,
        });
      } catch (error) {
        turnFailureHandled = true;
        return await failTurnExecution.call(this, {
          activeTurn,
          error,
          events,
          loopState,
          options,
          startedAtMs: turnStartedAtMs,
          startedTarget,
          targetRunInputID,
          turnAbortSignal,
          turnId,
          turnMachine,
          turnTraceContext,
          userMessageId,
        });
      }
    }).then(
      (result) => {
        return result;
      },
      (error: unknown) => {
        if (!turnFailureHandled) {
          this.logger?.warn("Turn execution escaped lifecycle handler", {
            ...traceContextToLogContext(turnTraceContext),
            durationMs: Date.now() - turnStartedAtMs,
            errorMessage: error instanceof Error ? error.message : String(error),
            event: "turn.lifecycle.unhandled_rejection",
            module: "core.runtime",
            phase: turnPhase,
            status: "failed",
          });
        }
        throw error;
      },
    );

  return execute().finally(async () => {
    await cleanupTurnExecution.call(this, {
      activeTurn,
      targetRunHeartbeat,
      turnAbortScope,
      turnId,
      turnTraceContext,
    });
  });
}
