// Transcript → SessionEvent 合成（「reduce(transcript) ≡ reduce(events)」）。
//
// 动机：v4 投影是事件溯源，但部分历史突变（纯对话 fork 复制 message 不复制 event、
// rewind 截断只动 message 库）会让 session 的事件日志无法覆盖可见 transcript。冷订阅
// hydration 从事件日志重建拿不到这些历史（「fork-child 历史」）。
//
// 本模块只负责事件序列的所有权：轮号、event seq、去重集合与输出数组。
// 消息事实、part、goal、model、单轮收集分别由相邻 helper 提供，均可单测。
import type {
  EventId,
  MessagePart,
  MessageWithParts,
  ModelSelection,
  SessionEvent,
  SessionId,
  TraceId,
  TurnId,
} from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import { getConversationModelOnlyTurnTriggerSource } from "@zcode/shared";
import { HYDRATION_TRACE_ID } from "./projection-state.js";
import {
  isProviderContextOnlyAssistant,
  isRealUserTurnStarter,
  messageCreatedAtMs,
  textOfMessage,
  workflowLaunchOfMessage,
} from "./transcript-hydration-facts.js";
import {
  attachmentMetasOfMessage,
  executionKindOfMessage,
  epilogueStartOfMessage,
  forkContextOfMessage,
  inputIntentOfMessage,
  isForkTimelineMessage,
} from "./transcript-hydration-shape.js";
import {
  assistantMessageHasSynthesizableContent,
  assistantModelSelectionOf,
  backgroundResultOriginMetaOfMessage,
  hydratedModelKey,
  isLegacyCompactMaintenanceInput,
  modelChangeToModelOf,
  turnModelSelectionOfUserMessage,
} from "./transcript-hydration-model.js";
import {
  collectTurnOutput,
  finishHydratedTurn,
  type FinishTurnInput,
} from "./transcript-hydration-turns.js";
import {
  goalVerificationEntriesFromSessionEntries,
  mergeGoalVerificationEntryFacts,
  pushGoalVerificationFact,
} from "./transcript-hydration-goal.js";
import type {
  GoalVerificationFact,
  HydratedTimelineModel,
  SynthesizeOptions,
} from "./transcript-hydration-types.js";

export type { HydratedGoalVerificationEntry } from "./transcript-hydration-types.js";
export { goalVerificationEntriesFromSessionEntries };

export function synthesizeEventsFromMessages(
  messages: readonly MessageWithParts[],
  options: SynthesizeOptions,
): SessionEvent[] {
  const sessionId = options.sessionId as SessionId;
  const traceId = HYDRATION_TRACE_ID as TraceId;
  let seq = 0;
  const baseMs = options.baseTimestampMs ?? messages[0]?.info.time.created ?? 0;
  const events: SessionEvent[] = [];

  const push = (
    type: SessionEventType,
    payload: unknown,
    turnId?: string,
    sourceTimestampMs?: number,
  ): void => {
    seq += 1;
    events.push({
      id: `hydrate-${seq}` as EventId,
      sessionId,
      turnId: turnId as TurnId | undefined,
      type,
      // source timestamp 仅恢复 row.createdAt 等展示事实；事件全序始终由 sequenceNumber 裁决。
      timestamp: new Date(sourceTimestampMs ?? baseMs + seq),
      traceId,
      sequenceNumber: seq,
      payload,
    });
  };

  // 历史消息不声明模型容量；调用方未知时保持未知，不能合成默认分母。
  const contextWindow = options.contextWindow;
  push(SessionEventType.SessionCreated, {
    mode: "default",
    contextWindow,
  });

  let turnNumber = 0;
  let index = 0;
  const emittedCompactOperations = new Set<string>();
  const durableCompactPartsByOperation = new Map<
    string,
    Extract<MessagePart, { type: "compaction" }>
  >();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "compaction") continue;
      if (!part.timelineStatus && !part.tail_start_id && !part.compactBoundary) continue;
      const operationId = String(
        part.operationId ?? part.boundaryId ?? `legacy-compact-${String(part.id)}`,
      );
      const existing = durableCompactPartsByOperation.get(operationId);
      if (!existing || (!existing.tail_start_id && part.tail_start_id)) {
        durableCompactPartsByOperation.set(operationId, part);
      }
    }
  }
  const emittedGoalVerifications = new Set<string>();
  let lastTurnId: string | undefined;

  const entryFacts = mergeGoalVerificationEntryFacts(options.goalVerificationEntries ?? []);
  const goalVerificationsByAnchor = new Map<string, GoalVerificationFact[]>();
  for (const fact of entryFacts) {
    if (!fact.anchorAssistantMessageId) continue;
    const list = goalVerificationsByAnchor.get(fact.anchorAssistantMessageId) ?? [];
    list.push(fact);
    goalVerificationsByAnchor.set(fact.anchorAssistantMessageId, list);
  }

  // MC-cold：modelChange marker 由投影在 TurnStarted 时
  // 对比 lastTurnModel 与 config 生成；冷恢复按每轮持久化选型事实在 TurnStarted 前
  // 合成 ModelSelected——普通首轮静默，显式 source-less 与后续 A→B 边界恒重建。
  // 该合成事件带 HYDRATION_TRACE_ID，不声明 种子权威（见 onModelSelected）。
  let lastSelectedModelKey: string | null = null;
  let pendingTimelineModel: HydratedTimelineModel | null = null;
  const selectTurnModel = (selection: HydratedTimelineModel | null): void => {
    if (!selection) return;
    const key = hydratedModelKey(selection.modelSelection);
    if (key === lastSelectedModelKey) return;
    lastSelectedModelKey = key;
    push(SessionEventType.ModelSelected, {
      modelSelection: selection.modelSelection,
      ...(selection.previousModelSelection !== undefined
        ? {
            previousModelSelection: selection.previousModelSelection
              ? selection.previousModelSelection
              : null,
          }
        : {}),
    });
  };
  const selectAcceptedTurnModel = (fallback: ModelSelection | null): void => {
    const selected = pendingTimelineModel ?? (fallback ? { modelSelection: fallback } : null);
    pendingTimelineModel = null;
    selectTurnModel(selected);
  };
  const recordTimelineModel = (selection: HydratedTimelineModel): void => {
    pendingTimelineModel = selection;
    selectTurnModel(selection);
  };

  const finishTurn = (input: FinishTurnInput): void => {
    finishHydratedTurn(input, push, contextWindow);
  };

  while (index < messages.length) {
    const message = messages[index]!;
    if (isProviderContextOnlyAssistant(message)) {
      index += 1;
      continue;
    }
    if (isLegacyCompactMaintenanceInput(message, messages[index + 1])) {
      // 旧手动 compact 的 user 宿主只是维护命令，不是 real-user intent；跳过宿主后，
      // 下一条 assistant compact fact 会走 preface model-only 轮并生成 canonical marker。
      index += 1;
      continue;
    }
    if (isForkTimelineMessage(message)) {
      const forkContext = forkContextOfMessage(message);
      if (forkContext) {
        push(SessionEventType.SessionForked, {
          forkPoint: 0,
          originalSessionId: forkContext.parentSessionId,
          restoredFileCount: forkContext.restoredFileCount,
          targetCheckpointId: forkContext.targetCheckpointId,
          targetMessageId: forkContext.targetMessageId,
        });
      }
      index += 1;
      continue;
    }
    const timelineModel = modelChangeToModelOf(message);
    if (timelineModel) {
      // model_change timeline part 是已接受轮的持久边界事实；
      // 宿主消息不能完全跳过、只靠后续 user message model 快照碰巧重建：
      // 快照缺失/滞后时 marker 就会消失，所以先消费显式 toModel，
      // 下一个 TurnStarted 仅使用该权威选型，不再被滞后快照覆盖。
      recordTimelineModel(timelineModel);
      index += 1;
      continue;
    }
    const workflowLaunch = workflowLaunchOfMessage(message);
    if (workflowLaunch) {
      // 中枢直接启动的启动轮：可见 controlOnly 用户轮，冷恢复须与活投影同形——同一 messageId、
      // origin workflowLaunch（由 inputSource 映射）、同一份 workflowLaunch 元数据、无助手输出。
      // 放在 real-user 分支之前，避免这条 synthetic user 被 hiddenSynthetic 跳过。
      turnNumber += 1;
      const turnId = `hydrate-turn-${turnNumber}`;
      lastTurnId = turnId;
      const launchText = textOfMessage(message.parts);
      const turnStartedAtMs = messageCreatedAtMs(message) ?? baseMs + seq;
      selectAcceptedTurnModel(turnModelSelectionOfUserMessage(message));
      push(
        SessionEventType.TurnStarted,
        {
          turnNumber,
          // 文本仍进 userInput.text（旧客户端 / TUI 的降级呈现）；GUI 用元数据画启动卡。
          input: launchText,
          // 持久 messageId 是该轮权威 target，与活投影同用，否则 productTurn 身份冷热分叉。
          messageId: String(message.info.id),
          // 启动轮不执行 Agent（controlOnly，无工时）；source 驱动 origin=workflowLaunch。
          executionKind: "controlOnly",
          inputSource: "workflow_launch",
          workflowLaunch,
        },
        turnId,
        turnStartedAtMs,
      );
      index += 1;
      const collected = collectTurnOutput({
        messages,
        startIndex: index,
        turnId,
        turnStartedAtMs,
        emittedCompactOperations,
        durableCompactPartsByOperation,
        emittedGoalVerifications,
        goalVerificationsByAnchor,
        onModelChange: recordTimelineModel,
        push,
      });
      index = collected.nextIndex;
      finishTurn({
        failure: collected.failure,
        turnId,
        resultType: collected.resultType,
        toolCallCount: collected.toolCallCount,
        historyRoundCount: collected.historyRoundCount,
        turnStartedAtMs,
        turnEndedAtMs: collected.turnEndedAtMs,
      });
      continue;
    }
    if (!isRealUserTurnStarter(message)) {
      // model-only 唤醒轮：background wake /
      // goal continuation 触发的 synthetic user 开独立 model-only 轮（无可见气泡，
      // 通知文本不进 rows），其后 assistant 归本轮——与 live 的 TurnStarted
      // (inputVisibility=model-only) 结构一致，不再并进上一轮。
      const wakeSource = getConversationModelOnlyTurnTriggerSource(message);
      if (wakeSource) {
        turnNumber += 1;
        const turnId = `hydrate-turn-${turnNumber}`;
        lastTurnId = turnId;
        const turnStartedAtMs = messageCreatedAtMs(message) ?? baseMs + seq;
        selectAcceptedTurnModel(turnModelSelectionOfUserMessage(message));
        push(
          SessionEventType.TurnStarted,
          {
            turnNumber,
            // cold hydration 曾把 model-only background wake 的原文清空，
            // 导致 ProductProjection 即使能消费 task-notification，恢复时也拿不到
            // tool-use-id 与失败详情。输入仍是 model-only，不会生成用户气泡。
            input: wakeSource === "background_task" ? textOfMessage(message.parts) : "",
            inputVisibility: "model-only",
            inputSource: wakeSource,
            ...(wakeSource === "background_task"
              ? { originMeta: backgroundResultOriginMetaOfMessage(message) }
              : {}),
            // model-only trigger 同样是持久 user 实体；若不传 messageId，
            // cold 会退化到 hydrate-turn-N，live/cold productTurn 身份再次分叉。
            messageId: String(message.info.id),
          },
          turnId,
          turnStartedAtMs,
        );
        index += 1;
        const collected = collectTurnOutput({
          messages,
          startIndex: index,
          turnId,
          turnStartedAtMs,
          emittedCompactOperations,
          durableCompactPartsByOperation,
          emittedGoalVerifications,
          goalVerificationsByAnchor,
          onModelChange: recordTimelineModel,
          push,
        });
        index = collected.nextIndex;
        finishTurn({
          failure: collected.failure,
          fileChanges: options.fileChangeSummariesByMessageId?.get(String(message.info.id)),
          turnId,
          resultType: collected.resultType,
          toolCallCount: collected.toolCallCount,
          historyRoundCount: collected.historyRoundCount,
          turnStartedAtMs,
          turnEndedAtMs: collected.turnEndedAtMs,
        });
        continue;
      }
      // assistant-head-skip 修复（「assistant 回复整段消失」冷路径向量）：
      // 首条真实用户消息之前的消息不能一律跳过——会话头部是 rewind notice /
      // compact summary 等非真实用户消息时，其后 assistant 回复刷新后会整段消失。
      // 因此为头部 assistant 输出合成 preface model-only 轮（无可见 user 气泡，
      // 内容照常渲染）。user 角色的非触发型 synthetic context 仍按设计不可见，照旧跳过。
      if (message.info.role !== "assistant" || !assistantMessageHasSynthesizableContent(message)) {
        index += 1;
        continue;
      }
      turnNumber += 1;
      const turnId = `hydrate-turn-${turnNumber}`;
      lastTurnId = turnId;
      const turnStartedAtMs = messageCreatedAtMs(message) ?? baseMs + seq;
      selectAcceptedTurnModel(assistantModelSelectionOf(message));
      push(
        SessionEventType.TurnStarted,
        { turnNumber, input: "", inputVisibility: "model-only" },
        turnId,
        turnStartedAtMs,
      );
      const collected = collectTurnOutput({
        messages,
        startIndex: index,
        turnId,
        turnStartedAtMs,
        emittedCompactOperations,
        durableCompactPartsByOperation,
        emittedGoalVerifications,
        goalVerificationsByAnchor,
        onModelChange: recordTimelineModel,
        push,
      });
      index = collected.nextIndex;
      finishTurn({
        failure: collected.failure,
        turnId,
        resultType: collected.resultType,
        toolCallCount: collected.toolCallCount,
        historyRoundCount: collected.historyRoundCount,
        turnStartedAtMs,
        turnEndedAtMs: collected.turnEndedAtMs,
      });
      continue;
    }

    turnNumber += 1;
    const turnId = `hydrate-turn-${turnNumber}`;
    lastTurnId = turnId;
    const userText = textOfMessage(message.parts);
    const attachments = attachmentMetasOfMessage(message.parts);
    const intent = inputIntentOfMessage(message);
    const executionKind = executionKindOfMessage(message);
    const epilogueStart = epilogueStartOfMessage(message);
    const turnStartedAtMs = messageCreatedAtMs(message) ?? baseMs + seq;
    // timeline part 与下一个 accepted turn 之间可以夹着 legacy synthetic
    // context，不能靠「紧邻前一条」猜测；持有显式边界直到真正开轮。
    selectAcceptedTurnModel(turnModelSelectionOfUserMessage(message));
    push(
      SessionEventType.TurnStarted,
      {
        turnNumber,
        input: userText,
        ...(epilogueStart === undefined ? {} : { epilogueStart }),
        // 根因：cold hydration 过去只重建可见 user row，遗漏持久 messageId，导致
        // 同一条历史消息在 UI 中可见却无法被 edit/rewind 命令寻址。真实 user
        // transcript message 就是该 row 的权威 target，必须与 live TurnStarted
        // 使用同一个 messageId 字段进入 ProductProjection。
        messageId: String(message.info.id),
        ...(executionKind ? { executionKind } : {}),
        ...(message.info.anchor?.sourceCommandId
          ? { inputId: message.info.anchor.sourceCommandId }
          : {}),
        ...(intent ? { intent } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      },
      turnId,
      turnStartedAtMs,
    );
    index += 1;

    const collected = collectTurnOutput({
      messages,
      startIndex: index,
      turnId,
      turnStartedAtMs,
      emittedCompactOperations,
      durableCompactPartsByOperation,
      emittedGoalVerifications,
      goalVerificationsByAnchor,
      onModelChange: recordTimelineModel,
      push,
    });
    index = collected.nextIndex;
    finishTurn({
      failure: collected.failure,
      fileChanges: options.fileChangeSummariesByMessageId?.get(String(message.info.id)),
      turnId,
      resultType: collected.resultType,
      toolCallCount: collected.toolCallCount,
      historyRoundCount: collected.historyRoundCount,
      turnStartedAtMs,
      turnEndedAtMs: collected.turnEndedAtMs,
    });
  }

  // anchor 缺失或指向未在 transcript 中出现的消息的 entry 事实：落到已知时间线末尾
  //（已按 key 去重，锚定成功的在上面循环里已发射；不猜 timestamp，不静默丢）。
  for (const fact of entryFacts) {
    pushGoalVerificationFact(fact, emittedGoalVerifications, push, lastTurnId);
  }

  return events;
}
