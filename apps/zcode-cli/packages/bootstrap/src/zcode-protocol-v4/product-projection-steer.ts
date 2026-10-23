import type {
  SessionEvent,
  SessionInputPromotedPayload,
  TurnInputIntentMetadata,
  TurnSteerDiscardedPayload,
  TurnSteerDrainedPayload,
} from "@zcode/contracts";
import type { ProjectionState } from "./product-projection-state.js";
import type { ConversationDelta } from "@zcode/shared/zcode-protocol-v4";
import {
  registerCanonicalUserRowTarget,
  rowBase,
  turnIdOf,
} from "./product-projection-primitives.js";
import { openGuidedWorkSegment, splitProductTurn } from "./product-projection-turn-segments.js";
import { removeQueueItems } from "./product-projection-queue.js";

export function onTurnSteerDrained(
  state: ProjectionState,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as TurnSteerDrainedPayload;
  const runtimeTurnId = String(
    payload.targetTurnId ?? event.turnId ?? state.currentTurnId ?? "turn-unknown",
  );
  // drain 事实优先自带文本/messageId（drainedInputs），
  // 投影不再依赖内存 queue 状态取文本——旧实现查不到 queue item 就静默 continue，
  // 用户输入从 queue 消失后也不进 history。旧事件（无 drainedInputs）回退查表。
  const items =
    payload.drainedInputs ??
    payload.pendingInputIds.flatMap((pendingInputId, index) => {
      const queueItem = state.snapshot.queue.items.find(
        (candidate) => candidate.queueItemId === pendingInputId,
      );
      if (!queueItem) return [];
      const intent: TurnInputIntentMetadata = {
        sourceCommandId: queueItem.sourceCommandId,
        queueItemId: queueItem.queueItemId,
        clientId: queueItem.clientId,
        kind: queueItem.kind,
        text: queueItem.text,
        ...(queueItem.modelSelection ? { modelSelection: queueItem.modelSelection } : {}),
        ...(queueItem.mode ? { mode: queueItem.mode } : {}),
        ...(queueItem.planEnabled !== undefined ? { planEnabled: queueItem.planEnabled } : {}),
        admissionSeq: queueItem.order.admissionSeq,
        admittedAt: queueItem.admittedAt,
        requestedDelivery: queueItem.delivery.requested,
        admittedDelivery: queueItem.delivery.admitted,
        queuePosition: queueItem.order.queuePosition,
        ...(queueItem.delivery.fallbackReasonCode
          ? { fallbackReasonCode: queueItem.delivery.fallbackReasonCode }
          : {}),
        attachmentRefs: queueItem.attachments,
      };
      return [
        {
          pendingInputId,
          messageId: payload.injectedMessageIds?.[index],
          text: queueItem.text,
          delivery: state.deliveryByPendingInputId.get(pendingInputId),
          intent,
        },
      ];
    });

  const deltas: ConversationDelta[] = [];
  for (const item of items) {
    const delivery =
      item.delivery ?? state.deliveryByPendingInputId.get(item.pendingInputId) ?? "queue";
    // queue 消费 = product turn 边界（每条一轮：收口上一段
    // header、开新 turnHeader、后续 assistant 归新轮）；guide steer 内联当前轮。
    if (delivery === "queue") {
      deltas.push(
        ...splitProductTurn(
          state,
          event,
          runtimeTurnId,
          item.messageId ? String(item.messageId) : undefined,
        ),
      );
    }
    const messageId = item.messageId ? String(item.messageId) : null;
    const entityId = messageId ?? item.pendingInputId;
    const productTurnId = turnIdOf(state, event);
    const rootSourceCommandId =
      item.intent?.provenance?.sourceCommandId ?? item.intent?.sourceCommandId;
    const row = {
      ...rowBase(state, event, productTurnId, entityId),
      kind: "userInput" as const,
      text: item.text,
      origin: "realUser" as const,
      ...(delivery === "guide" ? { guided: true as const } : {}),
      ...(item.intent?.sourceCommandId ? { sourceCommandId: item.intent.sourceCommandId } : {}),
      ...(rootSourceCommandId ? { rootSourceCommandId } : {}),
      ...(item.intent?.clientId ? { clientId: item.intent.clientId } : {}),
      ...(item.intent?.attachmentRefs?.length ? { attachments: item.intent.attachmentRefs } : {}),
      ...(item.intent?.source ? { source: item.intent.source } : {}),
    };
    // queue/guide 消费后的 real-user row 与普通 TurnStarted 共用完整 canonical target；
    // 缺 messageId 的旧事件仍只可展示，不暴露无法执行的 edit action。
    registerCanonicalUserRowTarget(
      state,
      row.rowId,
      entityId,
      messageId && item.intent?.kind !== "compact"
        ? {
            entityId,
            productTurnId,
            transcriptMessageId: messageId,
            coveredByStableCompact: false,
            intent: {
              kind: item.intent?.kind === "sendGoalCommand" ? "sendGoalCommand" : "sendText",
              text: item.intent?.text ?? item.text,
              ...(item.intent?.sourceCommandId
                ? { sourceCommandId: item.intent.sourceCommandId }
                : {}),
              ...(item.intent?.clientId ? { clientId: item.intent.clientId } : {}),
              ...(item.intent?.attachmentRefs ? { attachments: item.intent.attachmentRefs } : {}),
              ...(item.intent?.queueItemId ? { queueItemId: item.intent.queueItemId } : {}),
              ...(item.intent?.admissionSeq !== undefined
                ? { admissionSeq: item.intent.admissionSeq }
                : {}),
              ...(item.intent?.admittedAt !== undefined
                ? { admittedAt: item.intent.admittedAt }
                : {}),
              ...(item.intent?.requestedDelivery
                ? { requestedDelivery: item.intent.requestedDelivery }
                : {}),
              ...(item.intent?.admittedDelivery
                ? { admittedDelivery: item.intent.admittedDelivery }
                : {}),
              ...(item.intent?.fallbackReasonCode
                ? { fallbackReasonCode: item.intent.fallbackReasonCode }
                : {}),
              ...(item.intent?.modelSelection
                ? { modelSelection: item.intent.modelSelection }
                : {}),
              ...(item.intent?.mode ? { mode: item.intent.mode } : {}),
              ...(item.intent?.planEnabled !== undefined
                ? { planEnabled: item.intent.planEnabled }
                : {}),
              ...(item.intent?.provenance ? { provenance: item.intent.provenance } : {}),
            },
          }
        : undefined,
    );
    if (delivery === "guide") {
      deltas.push(...openGuidedWorkSegment(state, event, row.entityId ?? item.pendingInputId));
    }
    deltas.push({ op: "row.appended", row });
    state.deliveryByPendingInputId.delete(item.pendingInputId);
  }
  return [...deltas, ...removeQueueItems(state, payload.pendingInputIds)];
}

export function onTurnSteerDiscarded(
  state: Pick<ProjectionState, "deliveryByPendingInputId" | "snapshot">,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as TurnSteerDiscardedPayload;
  return removeQueueItems(state, payload.pendingInputIds);
}

export function onSessionInputPromoted(
  state: Pick<ProjectionState, "deliveryByPendingInputId" | "snapshot">,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as SessionInputPromotedPayload;
  // sendQueuedNow 启动成功后，显式 TurnSteerDiscarded(promoted)
  // 可能在进程/链路边界丢失，使 UI 永久留下 promoting 幽灵项。
  // SessionInputPromoted 只在 user message + session_input 同事务提交后产生，
  // 因此它才是可以安全移除 queue 投影的 durable commit signal。
  return removeQueueItems(state, [payload.pendingInputId]);
}
