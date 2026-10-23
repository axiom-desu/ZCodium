import {
  SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
  SESSION_ENTRY_USER_INPUT_AUTO_RESOLUTION,
  SessionEventType,
  createMessageId,
  createPartId,
  traceContextToLogContext,
} from "../deps.js";
import type {
  MessageId,
  PartId,
  SessionEvent,
  SessionId,
  TargetCompletionVerificationPayload,
  TraceContext,
  TurnInputIntentMetadata,
  UserInputAutoResolutionUpdatedPayload,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { buildPersistedConversationInputIntent } from "./input-intent-persistence.js";
import {
  persistWorkspaceCheckpointEntry,
  persistWorkspaceFileRewindEntry,
} from "./workspace-checkpoint-persistence.js";

/**
 * `appendEvent` 之后的 durable projection：把已落库事件映射成 session entry /
 * timeline part / session input 账本。只读 event + sessionStore，不改变事件顺序；
 * 生命周期与调用时机仍由 `events.ts` 的 appendEvent 决定。
 */
export async function persistDurableSessionEvent(
  this: AgentRuntimeInternal,
  event: SessionEvent,
  traceContext: TraceContext,
): Promise<void> {
  if (!this.sessionStore) return;

  if (event.type === SessionEventType.CheckpointCreated) {
    await persistWorkspaceCheckpointEntry(this, event, traceContext);
    return;
  }

  if (event.type === SessionEventType.RewindTriggered) {
    await persistWorkspaceFileRewindEntry(this, event, traceContext);
    return;
  }

  if (event.type === SessionEventType.UserInputAutoResolutionUpdated) {
    const payload = event.payload as UserInputAutoResolutionUpdatedPayload;
    try {
      await this.sessionStore.saveSessionEntry?.({
        id: `user-input-auto-resolution:${payload.interactionId}`,
        sessionID: event.sessionId,
        type: SESSION_ENTRY_USER_INPUT_AUTO_RESOLUTION,
        time: {
          created: payload.autoResolution.startedAt,
          updated: event.timestamp.getTime(),
        },
        data: {
          interactionId: payload.interactionId,
          toolCallId: payload.toolCallId,
          autoResolution: payload.autoResolution,
          eventId: event.id,
          sequenceNumber: event.sequenceNumber,
          traceId: event.traceId,
          ...(event.turnId ? { turnId: event.turnId } : {}),
        },
      });
    } catch (error) {
      // 原因：自动结束绝对时间若只在内存 eventStore，CLI 重启会错误重开五分钟窗口。
      // session entry 使用 interactionId 稳定覆写最新阶段，恢复时只读取最终状态。
      this.logger?.warn("Failed to persist user input auto-resolution state", {
        ...traceContextToLogContext(traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "user_input_auto_resolution.persist_failed",
        interactionId: payload.interactionId,
        module: "core.runtime",
        status: "failed",
      });
    }
    return;
  }

  // ── session_input 账本：queue/steer 生命周期集中记账 ──
  // 在事件汇处理（而非各发射点）：TurnSteerQueued/Discarded 有 5+ 个发射点
  // （steer/编辑重发/单删/清空/resume 清扫），单点接线保证不漏。promotion 在
  // drain 持久化处原子完成（persistUserPrompt sessionInputId 路径），不经此处。
  if (event.type === SessionEventType.TurnSteerQueued) {
    const payload = event.payload as {
      pendingInputId: string;
      input: string;
      commandKind?: string;
      delivery?: "guide" | "queue";
      intent?: TurnInputIntentMetadata;
    };
    const conversationInputIntent = buildPersistedConversationInputIntent(
      payload.input,
      payload.intent,
      "queued",
    );
    try {
      await this.sessionStore.saveSessionInput?.({
        id: payload.pendingInputId,
        sessionID: event.sessionId,
        kind: payload.intent?.kind ?? payload.commandKind ?? "sendText",
        delivery: payload.delivery ?? "queue",
        payload: {
          text: payload.input,
          ...(payload.intent ? { intent: payload.intent } : {}),
          ...(conversationInputIntent ? { conversationInputIntent } : {}),
        },
      });
    } catch (error) {
      this.logger?.warn("Failed to admit session input to ledger", {
        ...traceContextToLogContext(traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "session_input.admit_failed",
        module: "core.runtime",
        pendingInputId: payload.pendingInputId,
        status: "failed",
      });
    }
    return;
  }
  if (event.type === SessionEventType.TurnSteerDeliveryChanged) {
    const payload = event.payload as {
      admittedDelivery: "queue";
      intent?: TurnInputIntentMetadata;
      pendingInputId: string;
    };
    try {
      await this.sessionStore.updateSessionInputs?.({
        sessionID: event.sessionId,
        updates: [
          {
            delivery: payload.admittedDelivery,
            id: payload.pendingInputId,
            ...(payload.intent ? { intent: payload.intent } : {}),
          },
        ],
      });
    } catch (error) {
      this.logger?.warn("Failed to persist session input delivery fallback", {
        ...traceContextToLogContext(traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "session_input.delivery_change_failed",
        module: "core.runtime",
        pendingInputId: payload.pendingInputId,
        status: "failed",
      });
    }
    return;
  }
  if (event.type === SessionEventType.TurnSteerDiscarded) {
    const payload = event.payload as {
      pendingInputIds: string[];
      reason?: string;
    };
    // sendQueuedNow 只是在执行权已保留后把项从 queue 投影摘除；此时若把 ledger
    // 标成 cancelled，会制造 remove→后台 user message promotion 之间的崩溃丢失窗口。
    // 保持 admitted，随后由 persistUserPrompt 原子置 promoted；若进程先退出，恢复清扫
    // 会把它明确置 discarded/session_resumed。
    if (payload.reason === "promoted") return;
    // session_resumed=重启不保留队列（裁决，留痕不静默）；其余用户动作归 cancelled。
    const status = payload.reason === "session_resumed" ? "discarded" : "cancelled";
    for (const pendingInputId of payload.pendingInputIds) {
      try {
        await this.sessionStore.settleSessionInput?.({
          id: pendingInputId,
          sessionID: event.sessionId,
          status,
          reason: payload.reason,
        });
      } catch (error) {
        this.logger?.warn("Failed to settle session input in ledger", {
          ...traceContextToLogContext(traceContext),
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "session_input.settle_failed",
          module: "core.runtime",
          pendingInputId,
          status: "failed",
        });
      }
    }
    return;
  }

  if (event.type !== SessionEventType.TargetCompletionVerification) {
    return;
  }

  try {
    const timestamp = event.timestamp.getTime();
    const payload = event.payload as TargetCompletionVerificationPayload;
    const timelinePartId = targetCompletionVerificationTimelinePartId(payload);
    const existingTimeline = await readExistingTimelineTiming.call(this, {
      partID: timelinePartId,
      sessionID: event.sessionId,
    });
    const created = existingTimeline?.messageCreated ?? timestamp;
    const startedAt = existingTimeline?.partStarted ?? timestamp;
    if (this.sessionStore.saveSessionEntry) {
      await this.sessionStore.saveSessionEntry({
        id: String(event.id),
        sessionID: event.sessionId,
        type: SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
        time: {
          created: timestamp,
          updated: timestamp,
        },
        // goal verifier 生命周期是恢复 UI 轮次和分割线的业务事实；
        // 只写内存 eventStore 会导致冷启动后 goal iteration/todo 分组丢失。
        data: {
          eventId: event.id,
          payload: event.payload,
          sequenceNumber: event.sequenceNumber,
          traceId: event.traceId,
          ...(event.turnId ? { turnId: event.turnId } : {}),
        },
      });
    }
    await this.persistAssistantTimelinePartForSession({
      sessionId: event.sessionId,
      messageID: targetCompletionVerificationTimelineMessageId(payload),
      partID: timelinePartId,
      parentID: payload.anchorAssistantMessageId,
      created,
      completed: payload.status === "started" ? undefined : timestamp,
      finish: payload.status,
      timeline: {
        timelineType: "goal_verification",
        display: "separator",
        status: payload.status,
        anchorMessageId: payload.anchorAssistantMessageId,
        anchorTurnId: payload.anchorTurnId,
        targetId: payload.targetId,
        verificationId: payload.verificationId,
        goalIteration: payload.goalIteration,
        verification: payload.verification,
        time: {
          start: startedAt,
          end: payload.status === "started" ? undefined : timestamp,
        },
      },
      traceContext,
    });
  } catch (error) {
    this.logger?.warn("Failed to persist target completion verification event", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "session_entry.target_completion_verification.persist_failed",
      module: "core.runtime",
      sessionEventType: event.type,
      status: "failed",
    });
  }
}

function targetCompletionVerificationTimelineMessageId(
  payload: TargetCompletionVerificationPayload,
): MessageId {
  return createMessageId(`goal_verify_${targetCompletionVerificationTimelineKey(payload)}`);
}

function targetCompletionVerificationTimelinePartId(
  payload: TargetCompletionVerificationPayload,
): PartId {
  return createPartId(`goal_verify_${targetCompletionVerificationTimelineKey(payload)}_timeline`);
}

function targetCompletionVerificationTimelineKey(
  payload: TargetCompletionVerificationPayload,
): string {
  return payload.goalIteration !== undefined
    ? `${payload.targetId}_${payload.goalIteration}`
    : payload.verificationId;
}

async function readExistingTimelineTiming(
  this: AgentRuntimeInternal,
  input: { partID: PartId; sessionID: SessionId },
): Promise<{ messageCreated?: number; partStarted?: number } | undefined> {
  const messages = await this.sessionStore?.messages({ sessionID: input.sessionID });
  if (!messages) return undefined;
  for (const message of messages) {
    const part = message.parts.find((candidate) => candidate.id === input.partID);
    if (part?.type !== "timeline") continue;
    return {
      messageCreated: message.info.time.created,
      partStarted: part.time?.start,
    };
  }
  return undefined;
}
