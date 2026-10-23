import type {
  TurnErrorPayload,
  TurnSteerDiscardedPayload,
  TurnSteerDrainedPayload,
  TurnSteerDeliveryChangedPayload,
  TurnSteerQueuedPayload,
  TurnSteerReorderedPayload,
} from "../session.events.js";
import { SessionEventType as EventTypes } from "../session.events.js";
import type { SessionStatus } from "../../interfaces/session.port.js";
import type { EventHandlerTable } from "./types.js";

export const turn_controlHandlers: EventHandlerTable = {
  [EventTypes.TurnError]: (p, e) => {
    const payload = e.payload as TurnErrorPayload;
    return {
      ...p,
      status: "error" as SessionStatus,
      // projection 是重启/恢复链路的数据来源，必须保留真实 provider/subagent 根因。
      lastError: {
        type: payload.error.type,
        ...(payload.error.code ? { code: payload.error.code } : {}),
        message: payload.error.message,
        ...(payload.error.detail ? { detail: payload.error.detail } : {}),
        // TurnError 的 provider/network 归因是 live 与 cold projection 的共同事实；
        // 旧 reducer 只保留文案和 code，导致后续 task meta 无法区分 provider 拒绝。
        ...(payload.error.attribution ? { attribution: payload.error.attribution } : {}),
      },
      updatedAt: e.timestamp,
    };
  },

  [EventTypes.TurnSteerQueued]: (p, e) => {
    const payload = e.payload as TurnSteerQueuedPayload;
    const existingIndex = p.pendingSteerInputs.findIndex(
      (item) => item.pendingInputId === payload.pendingInputId,
    );
    const existing = existingIndex >= 0 ? p.pendingSteerInputs[existingIndex] : undefined;
    const next = {
      pendingInputId: payload.pendingInputId,
      input: payload.input,
      inputPreview: payload.inputPreview,
      inputSize: payload.inputSize,
      commandKind: payload.commandKind ?? existing?.commandKind,
      source: payload.source ?? existing?.source,
      inputPresentation: payload.inputPresentation ?? existing?.inputPresentation,
      intent: payload.intent ?? existing?.intent,
      toolDisallowlist: payload.toolDisallowlist ?? existing?.toolDisallowlist,
      // editQueueItem 会以同 id 重发 queued 事件；编辑不是重新 admission，
      // 必须保留原排队时间和数组位置，否则 runtime 冷重建会把它移到队尾。
      queuedAt: existing?.queuedAt ?? e.timestamp,
      targetTurnId: payload.targetTurnId,
      traceId: e.traceId,
    };
    return {
      ...p,
      pendingSteerInputs:
        existingIndex >= 0
          ? p.pendingSteerInputs.map((item, index) => (index === existingIndex ? next : item))
          : [...p.pendingSteerInputs, next],
      updatedAt: e.timestamp,
    };
  },

  [EventTypes.TurnSteerDeliveryChanged]: (p, e) => {
    const payload = e.payload as TurnSteerDeliveryChangedPayload;
    return {
      ...p,
      pendingSteerInputs: p.pendingSteerInputs.map((item) =>
        item.pendingInputId === payload.pendingInputId
          ? {
              ...item,
              intent:
                payload.intent ??
                (item.intent
                  ? {
                      ...item.intent,
                      admittedDelivery: payload.admittedDelivery,
                      fallbackReasonCode: payload.fallbackReasonCode,
                    }
                  : undefined),
            }
          : item,
      ),
      updatedAt: e.timestamp,
    };
  },

  [EventTypes.TurnSteerReordered]: (p, e) => {
    const payload = e.payload as TurnSteerReorderedPayload;
    const byId = new Map(p.pendingSteerInputs.map((item) => [item.pendingInputId, item]));
    const orderedIds = new Set(payload.orderedPendingInputIds);
    const ordered = payload.orderedPendingInputIds.flatMap((id) => {
      const item = byId.get(id);
      return item ? [item] : [];
    });
    const rest = p.pendingSteerInputs.filter((item) => !orderedIds.has(item.pendingInputId));
    return {
      ...p,
      pendingSteerInputs: [...ordered, ...rest].map((item, queuePosition) => ({
        ...item,
        ...(item.intent ? { intent: { ...item.intent, queuePosition } } : {}),
      })),
      updatedAt: e.timestamp,
    };
  },

  [EventTypes.TurnSteerDrained]: (p, e) => {
    const payload = e.payload as TurnSteerDrainedPayload;
    return {
      ...p,
      pendingSteerInputs: p.pendingSteerInputs.filter(
        (item) => !payload.pendingInputIds.includes(item.pendingInputId),
      ),
      updatedAt: e.timestamp,
    };
  },

  [EventTypes.TurnSteerDiscarded]: (p, e) => {
    const payload = e.payload as TurnSteerDiscardedPayload;
    return {
      ...p,
      pendingSteerInputs: p.pendingSteerInputs.filter(
        (item) => !payload.pendingInputIds.includes(item.pendingInputId),
      ),
      updatedAt: e.timestamp,
    };
  },
};
