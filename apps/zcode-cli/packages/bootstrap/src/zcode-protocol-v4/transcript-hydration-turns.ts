// 单轮 assistant 输出收集：从轮边界之后聚合 part、错误、模型切换与 goal 事实。
// 返回纯结果对象；轮号、事件序号和去重集合仍由 synthesizeEventsFromMessages 持有。
import type { MessagePart, MessageWithParts } from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import {
  assistantErrorData,
  isProviderContextOnlyAssistant,
  isPersistedAssistantCancellation,
  isPersistedStreamRecoveryDiscard,
  messageCreatedAtMs,
  messageEndAtMs,
  normalizeTurnResult,
  persistedErrorAttribution,
  textOfMessage,
} from "./transcript-hydration-facts.js";
import {
  forkContextOfMessage,
  isForkTimelineMessage,
  inputIntentOfMessage,
} from "./transcript-hydration-shape.js";
import {
  isTurnBoundaryStarter,
  modelChangeToModelOf,
  steerDeliveryOfMessage,
} from "./transcript-hydration-model.js";
import { pushGoalVerificationFact } from "./transcript-hydration-goal.js";
import { synthesizeAssistantParts } from "./transcript-hydration-parts.js";
import type {
  GoalVerificationFact,
  HydratedTimelineModel,
  PushEvent,
  TurnOutputCollection,
  TurnResultForHydration,
} from "./transcript-hydration-types.js";

/** 收集一轮的 assistant 输出（直到下一个轮边界）；普通轮与 preface 轮共用。 */
export function collectTurnOutput(options: {
  messages: readonly MessageWithParts[];
  startIndex: number;
  turnId: string;
  turnStartedAtMs: number;
  emittedCompactOperations: Set<string>;
  durableCompactPartsByOperation: ReadonlyMap<string, Extract<MessagePart, { type: "compaction" }>>;
  emittedGoalVerifications: Set<string>;
  goalVerificationsByAnchor: ReadonlyMap<string, GoalVerificationFact[]>;
  onModelChange: (selection: HydratedTimelineModel) => void;
  push: PushEvent;
}): TurnOutputCollection {
  const { messages, turnId, push } = options;
  let index = options.startIndex;
  let resultType: TurnResultForHydration = "success";
  let failure: TurnOutputCollection["failure"];
  // 被 stream recovery 作废的 tail 若是本轮最后一条 assistant，说明恢复请求没有落盘
  //（进程在重发前退出），本轮按 interrupted 收口；后续 assistant 出现则由它决定结果。
  let awaitingStreamRecovery = false;
  let toolCallCount = 0;
  let historyRoundCount = 0;
  let turnEndedAtMs = options.turnStartedAtMs;
  while (index < messages.length && !isTurnBoundaryStarter(messages[index]!)) {
    const message = messages[index]!;
    if (isProviderContextOnlyAssistant(message)) {
      // selection side chat 会把继承的 assistant 历史标成 model-only，
      // 旧 cold hydration 却只隐藏 user carrier，随后把 assistant 当作 preface/上一轮输出合成，
      // 导致副屏首次打开和冷恢复都泄漏父时间线。统一服从 projection policy，整条跳过。
      index += 1;
      continue;
    }
    if (isForkTimelineMessage(message)) {
      const forkContext = forkContextOfMessage(message);
      if (forkContext) {
        push(
          SessionEventType.SessionForked,
          {
            forkPoint: 0,
            originalSessionId: forkContext.parentSessionId,
            restoredFileCount: forkContext.restoredFileCount,
            targetCheckpointId: forkContext.targetCheckpointId,
            targetMessageId: forkContext.targetMessageId,
          },
          turnId,
        );
      }
      index += 1;
      continue;
    }
    // guide steer：内联进当前轮——合成 TurnSteerDrained（带 drainedInputs），
    // 投影按 delivery=guide 走内联 userInput 行，与 live 同一归约入口。
    if (message.info.role === "user" && steerDeliveryOfMessage(message) === "guide") {
      const intent = inputIntentOfMessage(message);
      // cold guide 过去只凭 messageId 临时拼 pendingInputId，且没有把
      // transcript 中已持久化的 ConversationInputIntent 带回事件；恢复后 row 会丢
      // sourceCommandId/clientId/attachments，命令去重与展示也不再和 live 等价。
      // 新数据优先复用原 queueItemId，legacy 才使用可诊断的 hydration fallback。
      const pendingInputId = intent?.queueItemId ?? `hydrate-steer-${String(message.info.id)}`;
      push(
        SessionEventType.TurnSteerDrained,
        {
          pendingInputIds: [pendingInputId],
          injectedMessageIds: [String(message.info.id)],
          drainedInputs: [
            {
              pendingInputId,
              messageId: String(message.info.id),
              text: textOfMessage(message.parts),
              delivery: "guide",
              ...(intent ? { intent } : {}),
            },
          ],
          targetTurnId: turnId,
        },
        turnId,
        messageCreatedAtMs(message),
      );
      index += 1;
      continue;
    }
    if (message.info.role !== "assistant") {
      index += 1;
      continue;
    }
    awaitingStreamRecovery =
      message.info.error !== undefined && isPersistedStreamRecoveryDiscard(message.info.error);
    if (
      message.info.error &&
      !isPersistedAssistantCancellation(message.info.error) &&
      !awaitingStreamRecovery
    ) {
      const data = assistantErrorData(message.info.error);
      const attribution = persistedErrorAttribution(data);
      failure = {
        type: message.info.error.name,
        message: (typeof data?.message === "string" && data.message) || message.info.error.name,
        // 旧 cold hydration 只把归因留在 data 内，TurnError 投影无法读取，重启后退化成 runtime。
        ...(attribution ? { attribution } : {}),
        ...(typeof data?.retryable === "boolean" ? { retryable: data.retryable } : {}),
        ...(message.info.error.data !== undefined ? { data: message.info.error.data } : {}),
      };
    }
    const timelineModel = modelChangeToModelOf(message);
    if (timelineModel) {
      options.onModelChange(timelineModel);
      index += 1;
      continue;
    }
    // Host 不能从 toolCallCount 或裁剪后的 history 长度反推模型轮次。
    // 新 transcript 在最终 assistant anchor 固化精确值；旧 transcript 才按独立
    // assistant history 条目做兼容计数。
    historyRoundCount = message.info.anchor?.historyRoundCount ?? historyRoundCount + 1;
    const messageEnd = messageEndAtMs(message);
    if (messageEnd !== undefined) {
      turnEndedAtMs = Math.max(turnEndedAtMs, messageEnd);
    }
    const synthesized = synthesizeAssistantParts(
      message,
      options.emittedCompactOperations,
      options.durableCompactPartsByOperation,
      options.emittedGoalVerifications,
      push,
      turnId,
    );
    resultType = normalizeTurnResult(resultType, synthesized.resultType);
    toolCallCount += synthesized.toolCallCount;
    if (
      message.info.role === "assistant" &&
      message.info.finish?.trim().toLowerCase() === "length" &&
      synthesized.toolCallCount === 0
    ) {
      // live ProductProjection 能从逐请求 ModelComplete 识别 output-token
      // Continue，但 cold transcript 过去只在整轮末尾合成一次 end_turn，导致刷新后
      // 同一句又退化成多条 assistant row。持久化 finish 是请求终止事实；用零 usage
      // 的 hydration-only ModelComplete 恢复资格，不重复累计 token 或注入 Continue user。
      push(
        SessionEventType.ModelComplete,
        {
          content: "",
          stopReason: "length",
          querySource: "main_turn",
          toolCallCount: 0,
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        },
        turnId,
        messageEnd,
      );
    }
    // session_entry 源的 goal verify：锚定本条 assistant 的事实紧随其后落位
    //（与 timeline part 同 key 去重，先到先得）。
    const anchored = options.goalVerificationsByAnchor.get(String(message.info.id));
    if (anchored) {
      for (const fact of anchored) {
        pushGoalVerificationFact(fact, options.emittedGoalVerifications, push, turnId);
      }
    }
    index += 1;
  }
  if (awaitingStreamRecovery) {
    resultType = normalizeTurnResult(resultType, "cancelled");
  }
  return {
    ...(failure ? { failure } : {}),
    nextIndex: index,
    resultType,
    toolCallCount,
    historyRoundCount,
    turnEndedAtMs,
  };
}

/**
 * 把 transcript（按时间/parentID 顺序的 MessageWithParts）合成为归约等价的 SessionEvent 序列。
 * 轮次分组：user message 开一轮，紧随其后的 assistant message（同轮输出）直到下一个 user message。
 */

export interface FinishTurnInput {
  failure?: TurnOutputCollection["failure"];
  fileChanges?: import("@zcode/contracts").TurnFileChangeSummary;
  turnId: string;
  resultType: TurnResultForHydration;
  toolCallCount: number;
  historyRoundCount: number;
  turnStartedAtMs: number;
  turnEndedAtMs: number;
}

export function finishHydratedTurn(
  input: FinishTurnInput,
  push: PushEvent,
  contextWindow: number | undefined,
): void {
  if (input.failure) {
    // provider 首字前失败只持久化在 assistant.info.error，旧 cold 路径
    // 折成 TurnComplete(error_during_execution)，导致 lastError 的 code/message 全丢。
    // 这里复用 live 的 TurnError 状态机，避免另建 cold-only 错误 reducer。
    push(
      SessionEventType.TurnError,
      { error: input.failure, turnPhase: "model" },
      input.turnId,
      input.turnEndedAtMs,
    );
    return;
  }
  push(
    SessionEventType.ModelComplete,
    {
      content: "",
      stopReason: "end_turn",
      querySource: "main_turn",
      // 冷恢复曾把合成事件的窗口固定成 20 万，覆盖同一模型在
      // workspace provider registry 中的 1M 能力；这里沿用调用方解析出的当前模型真值。
      contextWindow,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      ...(input.fileChanges ? { fileChanges: input.fileChanges } : {}),
    },
    input.turnId,
    input.turnEndedAtMs,
  );
  push(
    SessionEventType.TurnComplete,
    {
      response: "",
      tokenCount: 0,
      toolCallCount: input.toolCallCount,
      historyRoundCount: input.historyRoundCount,
      // 冷恢复是从 message transcript 反向合成事件，不能像 live
      // 事件一样依赖运行时 startedAt；固定 0 会让历史轮次显示成 1 秒。
      duration: Math.max(0, input.turnEndedAtMs - input.turnStartedAtMs),
      resultType: input.resultType,
    },
    input.turnId,
    input.turnEndedAtMs,
  );
}
