import { beginLocalTurnPreparation } from "@zcode/contracts";
import {
  CompactPhase,
  CompactReason,
  createMessageId,
  traceContextToLogContext,
  TurnMachineImpl,
} from "../deps.js";
import {
  buildRuntimeModeReminderBody,
  buildPlanModeExitReminderBody,
  buildRuntimeOutputStyleReminderBody,
  buildTodoReminderBody,
  buildRuntimeProviderRequestMessages,
  prepareRuntimeProviderRequest,
  createCompactRapidRefillError,
  throwIfTurnAborted,
  shouldBuildTodoReminder,
} from "../helpers/index.js";
import {
  isRuntimeAttachmentEntry,
  systemReminderAttachmentEntry,
  todoReminderRuntimeMetadata,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import type { DrainedPendingInputDiagnostics } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { buildToolSearchAnnouncement } from "../../tool/search/exposure.js";
import {
  appendEnvironmentAnnouncement,
  appendInstructionAnnouncement,
} from "./context-refresh.js";
import { formatTotalTokensReminder } from "../../context/total-tokens.js";
import {
  consumeTotalTokensBudget,
  decideTotalTokensReminder,
  reanchorTotalTokensBudget,
  type InputAttachmentCollectionReason,
} from "../helpers/total-tokens-budget.js";
import { recordPromptSnapshot } from "../helpers/prompt-snapshot.js";
import { recordSessionFeatureFromToolSearchExposure } from "../session-features/contract.js";
import { isRealUserPrompt } from "../helpers/provider-entry-origins.js";
import { latestContextTokens, querySourceForTask } from "./turn-model-step-usage.js";
import { runModelBackedTurnStep } from "./turn-model-step.js";
import {
  evaluateRapidRefill,
  MAX_CONSECUTIVE_RAPID_REFILLS,
  RAPID_REFILL_TOOL_TURN_THRESHOLD,
  recordCompactHistoryRound,
  recordCompactSuccess,
} from "./turn-loop-state.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { buildTurnDisallowedTools, getTurnTools } from "./turn-tool-visibility.js";
import {
  appendTurnRequestEntries,
  commitTurnRequestEntries,
  filterOutputTokenContinuationEntries,
} from "./turn-output-token-continuation.js";
import { consumeSettledProjectMemoryRecall } from "../helpers/project-memory-recall.js";
import { consumePendingProjectMemoryUpdate } from "../helpers/project-memory-dream.js";
import { ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH } from "../../memory/project-memory-retrieval-branch.js";

export async function runRegularTurnLoop(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
): Promise<void> {
  while (true) {
    throwIfTurnAborted(state.turnAbortSignal);
    const outputTokenRecoveryActive = state.turnRequestState.outputTokenContinuationCount > 0;
    // guide 只允许由完整 tool result batch 设置这个一次性诊断；普通 queue 不在
    // model roundtrip 起点消费，避免把未来 turn 错并入当前 product turn。
    const drainedSteerForNextRequest = state.drainedSteerForNextRequest;
    state.drainedSteerForNextRequest = undefined;

    if (state.modelStepCount > 0 && !outputTokenRecoveryActive) {
      const drainedRuntimeCommands = await this.drainPendingRuntimeCommandsForActiveLoop();
      state.backgroundSubagentResultConsumed ||=
        drainedRuntimeCommands.backgroundSubagentResultConsumed;
      state.workflowResultConsumed ||= drainedRuntimeCommands.workflowResultConsumed;
      appendTurnRequestEntries(state.turnRequestState, drainedRuntimeCommands.runtimeEntries);
      if (drainedRuntimeCommands.drained > 0) {
        state.repeatedToolCallSignature = undefined;
        state.repeatedToolCallStreakCount = 0;
      }
      // 完整真实 tool-result batch 且 queued 输入已 drain 后：Recall prefetch 只在此边界消费一次，
      // selector 未完成时不等待；Dream 的 memory_update 同样只注入一次。
      // 两者都是 per-request 提醒（不写入 canonical history），与上游 turn request entries 语义一致。
      const recallEntry = consumeSettledProjectMemoryRecall(
        this,
        ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH,
      );
      appendTurnRequestEntries(
        state.turnRequestState,
        [recallEntry, consumePendingProjectMemoryUpdate(this)].filter(
          (entry): entry is RuntimeMessageEntry => entry !== undefined,
        ),
      );
    }

    const compactPhase =
      state.modelStepCount === 0 ? CompactPhase.PreRequest : CompactPhase.MidTurn;
    await this.microcompactIfNeeded(state.turnTraceContext, state.events, state.turnAbortSignal, {
      model: state.model,
      modelStepIndex: state.modelStepCount,
      phase: compactPhase,
      turnRequestState: state.turnRequestState,
    });
    throwIfTurnAborted(state.turnAbortSignal);

    const rapidRefill = evaluateRapidRefill(state.compactTracking);
    const autoCompactOutcome = await this.autoCompactIfNeeded(
      state.turnTraceContext,
      state.events,
      state.turnAbortSignal,
      {
        compactReason: CompactReason.ContextLimit,
        modelStepIndex: state.modelStepCount,
        phase: compactPhase,
        rapidRefill,
        model: state.model,
        turnRequestState: state.turnRequestState,
        getContinuationTools: () => getTurnTools(this, state),
      },
    );
    if (autoCompactOutcome === "rapid_refill_blocked") {
      throw createCompactRapidRefillError({
        consecutiveRapidRefills: rapidRefill.consecutiveRapidRefills,
        maxConsecutiveRapidRefills: MAX_CONSECUTIVE_RAPID_REFILLS,
        toolTurnThreshold: RAPID_REFILL_TOOL_TURN_THRESHOLD,
        toolTurnsSinceCompact: rapidRefill.toolTurnsSinceCompact,
      });
    }
    if (autoCompactOutcome === "compacted") {
      recordCompactSuccess(state, rapidRefill);
      recordCompactHistoryRound(state);
    }
    throwIfTurnAborted(state.turnAbortSignal);

    const finishMcp = beginLocalTurnPreparation(state.turnTraceContext, "mcp");
    await this.initializeMcp(state.turnTraceContext);
    // tools/list_changed 只在回合开始前生效。
    await this.refreshMcpToolsIfChanged(state.turnTraceContext);
    finishMcp();
    throwIfTurnAborted(state.turnAbortSignal);
    const finishTools = beginLocalTurnPreparation(state.turnTraceContext, "tools");
    const turnDisallowedTools = buildTurnDisallowedTools(state);
    // automation 派发到已 active 会话或重试恢复时，入口 metadata 可能没有带到
    // loop state；但 queryId 仍是 automation-*。provider 请求边界必须按 queryId 再硬过滤
    // automation 写工具，否则模型会先看到并创建、修改或删除任务定义。
    const tools = state.automationCreateLimitReached
      ? []
      : turnDisallowedTools
        ? this.getTools(state.model).filter((tool) => !turnDisallowedTools.has(tool.name))
        : this.getTools(state.model);
    finishTools();
    if (!outputTokenRecoveryActive && this.needsPlanModeExitReminder) {
      this.needsPlanModeExitReminder = false;
      commitTurnRequestEntries(this, state.turnRequestState, [
        systemReminderAttachmentEntry("plan_mode_exit", buildPlanModeExitReminderBody()),
      ]);
    }
    const runtimeModeReminderBody = outputTokenRecoveryActive
      ? null
      : buildRuntimeModeReminderBody(
          state.turnRequestState.entries,
          this.getMode(),
          this.getPlanEnabled(),
        );
    if (runtimeModeReminderBody) {
      commitTurnRequestEntries(this, state.turnRequestState, [
        systemReminderAttachmentEntry("runtime_mode", runtimeModeReminderBody),
      ]);
    }
    if (
      !outputTokenRecoveryActive &&
      tools.some((tool) => tool.name === "TodoWrite") &&
      shouldBuildTodoReminder(state.turnRequestState.entries)
    ) {
      const currentTodos = await this.readSessionTodosForContext(state.turnTraceContext);
      const reminderBody = buildTodoReminderBody(currentTodos);
      commitTurnRequestEntries(this, state.turnRequestState, [
        systemReminderAttachmentEntry("todo_reminder", reminderBody),
      ]);
      await this.persistSyntheticUserNoticeForSession({
        messageID: createMessageId(),
        metadata: { runtimeMessage: todoReminderRuntimeMetadata() },
        sessionId: this.sessionId,
        source: "todo_reminder",
        text: reminderBody,
        traceContext: state.turnTraceContext,
      });
    }
    const outputStyleReminderBody =
      state.modelStepCount === 0
        ? buildRuntimeOutputStyleReminderBody(state.turnOutputStyle)
        : null;
    if (outputStyleReminderBody) {
      // output_style 是 provider-visible 的当前 turn runtime attachment，
      // 需要进入内存历史参与后续 request 的增量轨迹；但不把它落 session。
      commitTurnRequestEntries(this, state.turnRequestState, [
        systemReminderAttachmentEntry("output_style", outputStyleReminderBody),
      ]);
    }
    // 公告只由正常提醒收集和 compact 重建产生；纯 Continue 沿用快照，不重复追加。
    if (!outputTokenRecoveryActive) {
      const announcement = buildToolSearchAnnouncement({
        model: state.model,
        mode: this.config.toolSearch?.mode,
        tools,
        registry: this.getToolRegistry(),
        entries: state.turnRequestState.entries,
      });
      if (announcement?.kind === "attachment") {
        // 公告正文与增量事实必须在同一处落盘：否则 fork/resume 会把已公告工具当成首次出现。
        await this.persistSyntheticUserNoticeForSession({
          messageID: createMessageId(),
          metadata: {
            runtimeMessage: {
              source: "tool_search_announcement",
              toolSearchAnnouncement: announcement.metadata.toolSearchAnnouncement,
            },
          },
          sessionId: this.sessionId,
          source: "tool_search_announcement",
          text: announcement.content,
          traceContext: state.turnTraceContext,
        });
        commitTurnRequestEntries(this, state.turnRequestState, [announcement]);
      }
      // 指令文件增量公告（F1）：只有文件内容或集合变化时才追加，不重发整份。
      await appendInstructionAnnouncement(this, state.turnRequestState, state.turnTraceContext);
      // 环境公告（3.18.2）：system 的 # Environment 被 prompt 快照冻结，变化只能靠这里补。
      await appendEnvironmentAnnouncement(this, state.turnRequestState, state.turnTraceContext);
      // token 预算倒数（F2）：数值来自 runtime 计数器与最近一条带 usage 的 assistant。
      await appendTotalTokensReminder(this, state, drainedSteerForNextRequest);
    }
    // （2026-09-12）：原"回合开始注入 plugin_ui_state reminder"已删除，插件给模型的信息
    // 一律走 ui/update-model-context。
    const providerEntries = [...state.turnRequestState.entries];
    const requestEntries = providerEntries;
    // 唯一一次 ToolSearch 请求准备：先用完整作用域目录决定启用/发现集合，再向投影与发送方
    // 提供配套的 tools/引用；provider-visible user ordering 会改变 latest user 落点，
    // cache-control 必须在 projection 后统一设置，避免 raw synthetic entry 抢占缓存锚点。
    const prepared = prepareRuntimeProviderRequest(this, {
      model: state.model,
      tools,
      registry: this.getToolRegistry(),
      entries: requestEntries,
      applyCacheControl: true,
    });
    // 主会话没有可用的 prompt 快照时，按本次请求的前缀记录 system（F3）。
    await recordPromptSnapshot(this, {
      entries: requestEntries,
      model: state.model,
      modelSelectionScope: state.modelSelectionScope,
      traceContext: state.turnTraceContext,
    });
    this.logger?.debug("ToolSearch request exposure", {
      event: "tool.search.exposure",
      enabled: prepared.toolSearch.enabled,
      mode: prepared.toolSearch.mode,
      reason: prepared.reason,
      catalogSize: prepared.toolSearch.catalog.length,
      schemaCount: prepared.request.tools.length,
    });
    // 能力标签取本次主循环请求的生效模式，在模型调用前打，本次请求就带上。
    recordSessionFeatureFromToolSearchExposure.call(
      this,
      prepared.toolSearch,
      state.turnTraceContext,
    );
    const providerProjection = prepared.projection;
    const { messages } = prepared.request;
    const recordableEntries = filterOutputTokenContinuationEntries(prepared.entries);
    const recordableProjection =
      recordableEntries === prepared.entries
        ? providerProjection
        : buildRuntimeProviderRequestMessages(this, {
            entries: recordableEntries,
            loadedToolCallIds: prepared.loadedToolCallIds,
            applyCacheControl: true,
            model: state.model,
          });
    state.turnMachine = new TurnMachineImpl(
      state.turnMachine.startModelRequest(
        `${state.model.providerId}/${state.model.modelId}`,
        recordableProjection.messages,
      ),
    );

    // 生产包需要知道 Turn 是否已经跨过 provider 边界；这里只记录请求元数据，
    // 不记录 prompt、消息内容或 streaming chunk，避免泄露内容并控制日志量。
    this.logger?.info("Model request started", {
      ...traceContextToLogContext(state.turnTraceContext),
      event: "model.request.started",
      module: "core.runtime",
      status: "started",
      messageCount: messages.length,
      iteration: state.toolCallCount === 0 ? 0 : Math.ceil(state.toolCallCount / 10),
    });

    const result = await runModelBackedTurnStep.call(this, state, {
      drainedSteerForNextRequest,
      latestRealUserMessageIndex: providerProjection.diagnostics.latestRealUserMessageIndex,
      messages,
      sourceEntries: providerProjection.sourceEntries,
      requestEntries,
      recordedMessages: recordableProjection.messages,
      tools: prepared.request.tools,
      toolSearch: prepared.toolSearch,
    });

    if (result === "break") {
      break;
    }
  }
}

/**
 * token 预算倒数：数值来自 runtime 计数器与最近一条带 usage 的 assistant。
 * 先算出新状态再提交附件，最后才更新计数器：附件没进请求时不推进已用量。
 * 只进 turn request entries，不落 session——预算本身不持久化，落库的倒数会与恢复后的计数器矛盾。
 */
async function appendTotalTokensReminder(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  drainedSteer: DrainedPendingInputDiagnostics | undefined,
): Promise<void> {
  const entries = state.turnRequestState.entries;
  const reason = resolveInputAttachmentCollectionReason(state, drainedSteer);
  const decision = decideTotalTokensReminder({
    fromUser: inputFromUser(entries, reason, drainedSteer),
    mainSession: querySourceForTask(runtime.config.taskType) === "main_turn",
    reason,
  });
  if (!decision.emit) return;
  const context = latestContextTokens(entries);
  const budget = decision.reanchor
    ? reanchorTotalTokensBudget(runtime.totalTokensBudget, context)
    : runtime.totalTokensBudget;
  const consumed = consumeTotalTokensBudget(budget, context);
  appendTurnRequestEntries(state.turnRequestState, [
    systemReminderAttachmentEntry(
      "total_tokens_reminder",
      formatTotalTokensReminder(consumed.remaining),
    ),
  ]);
  runtime.totalTokensBudget = consumed.state;
}

/** 本次请求的输入附件收集原因：轮首、完整工具批次之后、文本回复后续上 guide。 */
function resolveInputAttachmentCollectionReason(
  state: RegularTurnLoopState,
  drainedSteer: DrainedPendingInputDiagnostics | undefined,
): InputAttachmentCollectionReason {
  if (state.modelStepCount === 0) return "turn_input";
  return drainedSteer ? "text_guide" : "tool_batch";
}

/** 触发本次收集的输入是否出自用户本人：轮首看最新输入，guide 看本次取出的 steer 是否用户亲手输入。 */
function inputFromUser(
  entries: readonly RuntimeMessageEntry[],
  reason: InputAttachmentCollectionReason,
  drainedSteer: DrainedPendingInputDiagnostics | undefined,
): boolean {
  if (reason === "text_guide") {
    return (drainedSteer?.runtimeEntries ?? []).some(
      (entry) => entry.metadata?.inputPresentation === "user_steer",
    );
  }
  const latestMessage = entries.findLast((entry) => !isRuntimeAttachmentEntry(entry));
  return latestMessage !== undefined && isRealUserPrompt(latestMessage);
}
