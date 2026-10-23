import type {
  ModelNetworkStatusPayload,
  SessionEvent,
  StreamRecoveryRetryStartedPayload,
  StreamRecoveryStartedPayload,
} from "@zcode/contracts";
import type { ProjectionState } from "./product-projection-state.js";
import { closeStreamingRows } from "./product-projection-stream.js";
import { closeOpenToolRows } from "./product-projection-tool-rows.js";
import {
  modelRetryReasonCode,
  nonNegativeInteger,
  positiveInteger,
  streamRecoveryReasonCode,
} from "./product-projection-model-facts.js";
import type { ApiRetryState, ConversationDelta } from "@zcode/shared/zcode-protocol-v4";
import { controlPatch, isRunning, ms } from "./product-projection-primitives.js";

// ── 流式输出 ──

export function onModelNetworkStatus(
  state: ProjectionState,
  event: SessionEvent,
): ConversationDelta[] {
  if (!acceptsActiveModelEvent(state, event)) return [];
  const payload = event.payload as ModelNetworkStatusPayload;
  switch (payload.type) {
    case "model_retry_scheduled": {
      const attempt = positiveInteger(payload.attempt, 1);
      const maxAttempts = Math.max(positiveInteger(payload.maxAttempts, attempt + 1), attempt + 1);
      return setApiRetry(state, {
        attempt,
        maxAttempts,
        nextRetryAt: ms(event) + nonNegativeInteger(payload.delayMs, 0),
        reasonCode: modelRetryReasonCode(payload.reason),
      });
    }
    case "model_request_started":
      if (payload.streamRecovery) {
        return setApiRetry(
          state,
          streamRecoveryApiRetry(
            payload.streamRecovery.retryNumber,
            payload.streamRecovery.maxRetries,
            ms(event),
            state.snapshot.control.apiRetry?.reasonCode ?? "fault.network.sseDisconnected",
          ),
        );
      }
      // adapter attempt=2+ 只说明重试请求已发出，不代表连接恢复；
      // 保持当前状态，等首个有效 text/reasoning/tool 进展再清理，避免标签闪退。
      return positiveInteger(payload.attempt, 1) <= 1 ? setApiRetry(state, null) : [];
    case "model_request_completed":
      return setApiRetry(state, null);
    case "model_request_failed":
      return payload.retryable ? [] : setApiRetry(state, null);
    case "model_stream_stalled":
    // 准入等待的两端是 runtime 观测，不是 UI 状态：
    // 不映射成重试/等待标签。
    case "model_request_queued":
    case "model_request_admitted":
      return [];
  }
}

export function onStreamRecoveryStarted(
  state: ProjectionState,
  event: SessionEvent,
): ConversationDelta[] {
  if (!acceptsActiveModelEvent(state, event)) return [];
  const payload = event.payload as StreamRecoveryStartedPayload;
  return setApiRetry(
    state,
    streamRecoveryApiRetry(
      payload.retryNumber,
      payload.maxRetries,
      ms(event),
      streamRecoveryReasonCode(payload.failureKind),
    ),
  );
}

export function onStreamRecoveryTailDiscarded(
  state: ProjectionState,
  event: SessionEvent,
): ConversationDelta[] {
  if (!acceptsActiveModelEvent(state, event)) return [];
  // Bug 原因：Core 已用 tail_discarded 切断失败 assistant attempt，但旧 V4 投影忽略该事件，
  // 下一次 reasoning/text 到达时会把旧行误收口为 complete。这里必须先标 interrupted，
  // 让恢复流用新 assistant identity 打开新行，避免 UI 看起来像一次连续完整输出。
  // Bug 原因：断流时已由 tool_input_start 打开、但还没等到 tool_call 定稿的工具行也属于
  // 被作废的 tail——core 只为已提交的工具合成终态，这些行没人收口；恢复请求会用新的
  // toolCallId 再开一行，UI 于是并排出现两张「正在编写工作流」。已提交（running /
  // pendingApproval）的行不在此列，它们的终态由 executor 自己发布。
  return [
    ...closeStreamingRows(state, "interrupted"),
    ...closeOpenToolRows(state, event, "cancelled", (row) => row.status === "inputStreaming"),
  ];
}

export function onStreamRecoveryRetryStarted(
  state: ProjectionState,
  event: SessionEvent,
): ConversationDelta[] {
  if (!acceptsActiveModelEvent(state, event)) return [];
  const payload = event.payload as StreamRecoveryRetryStartedPayload;
  return setApiRetry(
    state,
    streamRecoveryApiRetry(
      payload.retryNumber,
      payload.maxRetries,
      ms(event),
      state.snapshot.control.apiRetry?.reasonCode ?? "fault.network.sseDisconnected",
    ),
  );
}

function streamRecoveryApiRetry(
  retryNumber: number,
  maxRetriesValue: number,
  nextRetryAt: number,
  reasonCode: string,
): ApiRetryState {
  const attempt = positiveInteger(retryNumber, 1);
  const maxRetries = Math.max(positiveInteger(maxRetriesValue, attempt), attempt);
  return {
    attempt,
    maxAttempts: maxRetries + 1,
    nextRetryAt,
    reasonCode,
  };
}

export function setApiRetry(
  state: Pick<ProjectionState, "snapshot">,
  apiRetry: ApiRetryState | null,
): ConversationDelta[] {
  const current = state.snapshot.control.apiRetry;
  if (
    current === apiRetry ||
    (current !== null &&
      apiRetry !== null &&
      current.attempt === apiRetry.attempt &&
      current.maxAttempts === apiRetry.maxAttempts &&
      current.nextRetryAt === apiRetry.nextRetryAt &&
      current.reasonCode === apiRetry.reasonCode)
  ) {
    return [];
  }
  return [
    {
      op: "state.updated",
      patch: controlPatch(state, { apiRetry }),
    },
  ];
}

export function acceptsActiveModelEvent(state: ProjectionState, event: SessionEvent): boolean {
  if (!isRunning(state)) return false;
  // stop/新一轮后旧请求可能迟到；仅凭 session 级状态会让旧 turn 的
  // retry/progress 覆盖当前输入栏。当前 runtime turn 已知时必须按 turnId 隔离。
  return (
    state.currentTurnId === null ||
    event.turnId === undefined ||
    String(event.turnId) === state.currentTurnId
  );
}
