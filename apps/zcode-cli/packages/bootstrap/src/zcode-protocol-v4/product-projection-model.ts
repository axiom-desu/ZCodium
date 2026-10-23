import type {
  ModelCompletePayload,
  ModelSelectedPayload,
  ModelUsage,
  SessionEvent,
} from "@zcode/contracts";
import { getModelUsageContextTokens } from "@zcode/contracts";
import type { ProjectionState } from "./product-projection-state.js";
import {
  openTextRow,
  closeTextRow,
  openReasoningRow,
  closeReasoningRow,
} from "./product-projection-stream.js";
import {
  appendStreamingToolInput,
  finalizeStreamingToolInput,
  flushStreamingToolInput,
  openToolRow,
} from "./product-projection-tool-rows.js";
import {
  cloneSparseModelSelection,
  positiveInteger,
  sameSparseModelSelection,
} from "./product-projection-model-facts.js";
import type { ConversationDelta } from "@zcode/shared/zcode-protocol-v4";
import type { CanonicalAssistantSegmentFact } from "./event-normalizer.js";
import { HYDRATION_TRACE_ID } from "./projection-state.js";
import { findRow, isRunning, turnIdOf } from "./product-projection-primitives.js";
import { acceptsActiveModelEvent, setApiRetry } from "./product-projection-stream-recovery.js";

export function onModelStreaming(
  state: ProjectionState,
  fact: CanonicalAssistantSegmentFact,
): ConversationDelta[] {
  const event = fact.event;
  // 迟到终态不复活：非运行期到达的流式事件一律拒收。
  // assistant 守恒：正文类拒收不是无害丢弃——投影建立晚于
  // TurnStarted（订阅中途建 publisher）时，整段回复会静默消失直到刷新
  // （「回复整段消失」的 live 向量）。计数暴露给 gateway：置 stale 标记，
  // 下次订阅强制重新 hydration 从持久事实补齐。
  if (!isRunning(state)) {
    const dropped = fact.stream;
    if (
      dropped.kind === "text_start" ||
      dropped.kind === "text_delta" ||
      dropped.kind === "reasoning_start" ||
      dropped.kind === "reasoning_delta"
    ) {
      state.droppedContentStreamEventCount += 1;
    }
    return [];
  }
  const payload = fact.stream;
  switch (payload.kind) {
    case "text_start":
      return openTextRow(state, event, fact);
    case "text_delta": {
      const open = state.streamingTextRowId === null ? openTextRow(state, event, fact) : [];
      return [
        ...open,
        {
          op: "row.delta",
          rowId: state.streamingTextRowId as number,
          path: "text",
          append: payload.delta,
        },
      ];
    }
    case "text_end":
      return closeTextRow(state, "complete");
    case "reasoning_start":
      return openReasoningRow(state, event, fact);
    case "reasoning_delta": {
      const open =
        state.streamingReasoningRowId === null ? openReasoningRow(state, event, fact) : [];
      return [
        ...open,
        {
          op: "row.delta",
          rowId: state.streamingReasoningRowId as number,
          path: "text",
          append: payload.delta,
        },
      ];
    }
    case "reasoning_end":
      return closeReasoningRow(state);
    case "tool_input_start":
      return openToolRow(state, event, payload, fact.entityId);
    case "tool_input_delta": {
      return appendStreamingToolInput(state, event, payload);
    }
    case "tool_input_end":
      return flushStreamingToolInput(state, String(payload.toolCallId ?? ""));
    case "tool_call":
      return finalizeStreamingToolInput(state, event, payload);
    default:
      return [];
  }
}

// ── config / usage ──

export function onModelSelected(
  state: Pick<
    ProjectionState,
    | "configModelTouchedByEvent"
    | "configThoughtLevelsTouchedByEvent"
    | "contextWindowState"
    | "lastTurnModel"
    | "snapshot"
  >,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as ModelSelectedPayload;
  // Bug 原因：把 fresh child 身份另存为 pending side state 后，原子投影 clone/adopt
  // 漏复制该字段，实时 marker 会消失。显式 null 直接复用模型基线表达 ∅→X，
  // 公共投影不再识别 Subagent 身份；后续选型只更新 config，不覆盖上一轮实际模型。
  if (payload.previousModelSelection === null) {
    state.lastTurnModel = { kind: "sourceLess" };
  }
  const prev = state.snapshot.config;
  const provider = payload.modelSelection.providerId;
  const model = payload.modelSelection.modelId;
  const thought =
    payload.effectiveReasoningLevel ?? payload.modelSelection.options?.reasoningLevel ?? "";
  const modelSelection = cloneSparseModelSelection(payload.modelSelection);
  const thoughtLevels = payload.supportedThoughtLevels
    ? [...payload.supportedThoughtLevels]
    : prev.thoughtLevels;
  const contextWindow =
    payload.contextWindow === null
      ? null
      : payload.contextWindow !== undefined
        ? positiveInteger(payload.contextWindow, 0) || undefined
        : undefined;
  // Bug 原因：旧事件只更新 config，runtime 虽已切到新模型，历史 usage 的 maxTokens
  // 仍停在源模型，直到下一次 ModelComplete 才偶然校准。窗口属于已应用模型能力，
  // 必须在同一个 ModelSelected 中提交；usedTokens 仍保留历史上下文事实。
  if (contextWindow !== undefined) {
    state.contextWindowState.touchedByEvent = true;
    state.contextWindowState.maxTokens =
      contextWindow !== null && contextWindow > 0 ? contextWindow : null;
  }
  const previousContextWindow = state.snapshot.usage.contextWindow;
  if (previousContextWindow) {
    state.contextWindowState.usedTokens = previousContextWindow.usedTokens;
  }
  const contextWindowChanged =
    contextWindow !== undefined &&
    (contextWindow === null
      ? previousContextWindow !== null
      : previousContextWindow === null || previousContextWindow.maxTokens !== contextWindow);
  // 日志事件触碰过模型选型后，种子不再覆盖（同值 return 也算触碰）。
  // 冷恢复合成的 ModelSelected（HYDRATION_TRACE_ID）例外：它只是从 message 事实
  // 重建历史选型供 modelChange marker 使用，不是权威选型动作；重放后 seedConfig
  // 仍以 runtime 真值（resume 已回写的上次/草稿选型）收口。
  if (String(event.traceId) !== HYDRATION_TRACE_ID) {
    state.configModelTouchedByEvent = true;
    if (payload.supportedThoughtLevels !== undefined) {
      state.configThoughtLevelsTouchedByEvent = true;
    }
  }
  // 选型事件只更新 config，不在选型时落 modelChange
  // marker——切换动作是意向，marker 归 onTurnStarted 按「与上一轮实际选型不同」
  // 裁决（见彼处注释与 Bug 背景）。
  const configChanged = !(
    prev.provider === provider &&
    prev.model === model &&
    sameSparseModelSelection(prev.modelSelection, modelSelection) &&
    prev.thought === thought &&
    prev.thoughtLevels.length === thoughtLevels.length &&
    prev.thoughtLevels.every((value, index) => value === thoughtLevels[index])
  );
  const modelTransition =
    payload.origin === "registryFallback" &&
    payload.previousModelSelection != null &&
    (payload.previousModelSelection.providerId !== provider ||
      payload.previousModelSelection.modelId !== model)
      ? {
          eventId: String(event.id),
          origin: payload.origin,
          from: {
            provider: payload.previousModelSelection.providerId,
            model: payload.previousModelSelection.modelId,
          },
          to: { provider, model },
        }
      : undefined;
  if (!configChanged && !contextWindowChanged && modelTransition === undefined) {
    return [];
  }
  return [
    {
      op: "state.updated",
      patch: {
        ...(configChanged
          ? { config: { ...prev, modelSelection, provider, model, thought, thoughtLevels } }
          : {}),
        // Bug 原因：仅投影 config 会丢失“由 registry fallback 触发”的来源，
        // renderer 无法安全地区分自动恢复和显式/历史切换。保留事件 ID 与起止身份，
        // 具体 toast 仍只由客户端在实时 online delivery 边界触发。
        ...(modelTransition ? { modelTransition } : {}),
        ...(contextWindowChanged
          ? {
              usage: {
                ...state.snapshot.usage,
                // Bug 原因：null 是 registry 清除显式窗口的权威事件，必须清空整个
                // usage.contextWindow；字段缺失才保留旧事件兼容语义。
                contextWindow:
                  contextWindow === null
                    ? null
                    : previousContextWindow
                      ? { ...previousContextWindow, maxTokens: contextWindow }
                      : {
                          usedTokens: state.contextWindowState.usedTokens,
                          maxTokens: contextWindow,
                          autoCompactThresholdTokens: null,
                        },
              },
            }
          : {}),
      },
    },
  ];
}

export function onModelComplete(state: ProjectionState, event: SessionEvent): ConversationDelta[] {
  const payload = event.payload as ModelCompletePayload;
  const retryClearDeltas = acceptsActiveModelEvent(state, event) ? setApiRetry(state, null) : [];
  // 与旧 reducer 同一裁决：只有主会话往返才能覆盖 context 水位。
  const isMainTurn =
    payload.querySource !== undefined
      ? payload.querySource === "main_turn"
      : payload.stopReason !== "tool_internal";
  if (isMainTurn) state.outputContinuationTextRowId = null;
  if (
    isMainTurn &&
    payload.stopReason?.trim().toLowerCase() === "length" &&
    payload.toolCallCount === 0
  ) {
    const lastVisibleRow = state.snapshot.rows.window.at(-1);
    if (
      lastVisibleRow?.kind === "assistantText" &&
      lastVisibleRow.turnId === turnIdOf(state, event) &&
      lastVisibleRow.state === "complete"
    ) {
      state.outputContinuationTextRowId = lastVisibleRow.rowId;
    }
  }
  // subagent ModelComplete 的 usage 仍不是主会话水位，但它携带的
  // fileChanges 是 child session 自己的 workspace 事实，必须独立投影到 child turn header。
  const supportsFileChangeSummary = isMainTurn || payload.querySource === "subagent";
  const deltas: ConversationDelta[] = [];
  if (supportsFileChangeSummary && payload.fileChanges && payload.fileChanges.files > 0) {
    const turnId = turnIdOf(state, event);
    const headerRowId = state.turnHeaderRowIdByTurnId.get(turnId);
    const headerRow = headerRowId !== undefined ? findRow(state, headerRowId) : undefined;
    if (headerRow?.kind === "turnHeader") {
      deltas.push({
        op: "row.upserted",
        row: {
          ...headerRow,
          fileChanges: {
            additions: payload.fileChanges.additions,
            deletions: payload.fileChanges.deletions,
            files: payload.fileChanges.files,
            state: "active",
          },
        },
      });
    }
  }
  if (!isMainTurn) return [...deltas, ...retryClearDeltas];
  const usage = payload.usage as ModelUsage;
  const usedTokens = getModelUsageContextTokens(usage) ?? 0;
  state.contextWindowState.usedTokens = usedTokens;
  const maxTokens = payload.contextWindow ?? state.contextWindowState.maxTokens;
  const cumulative = state.snapshot.usage.cumulative;
  deltas.push({
    op: "state.updated",
    patch: {
      usage: {
        // Bug 原因：registry 已显式清除窗口时，缺少 contextWindow 的 ModelComplete
        // 过去会用 0 重建对象，破坏未知容量语义。token 继续在侧状态和累计值中更新。
        contextWindow:
          maxTokens === null
            ? null
            : {
                usedTokens,
                maxTokens,
                autoCompactThresholdTokens:
                  state.snapshot.usage.contextWindow?.autoCompactThresholdTokens ?? null,
                ...(payload.cacheHit ? { cache: payload.cacheHit } : {}),
                ...(payload.contextUsageBreakdown && payload.contextUsageBreakdown.length > 0
                  ? { breakdown: payload.contextUsageBreakdown }
                  : {}),
              },
        cumulative: {
          inputTokens: cumulative.inputTokens + (usage.inputTokens ?? 0),
          outputTokens: cumulative.outputTokens + (usage.outputTokens ?? 0),
          cacheReadTokens: cumulative.cacheReadTokens + (usage.cacheReadTokens ?? 0),
          cacheWriteTokens: cumulative.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
        },
      },
    },
  });
  // ModelComplete 是缺少 network completed 事件时的成功兜底，不能让重试提示悬挂。
  deltas.push(...retryClearDeltas);
  return deltas;
}
