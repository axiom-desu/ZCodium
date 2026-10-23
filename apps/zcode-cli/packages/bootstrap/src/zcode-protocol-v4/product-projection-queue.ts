import type {
  SessionEvent,
  TurnSteerDeliveryChangedPayload,
  TurnSteerDispatchChangedPayload,
  TurnSteerQueuedPayload,
} from "@zcode/contracts";
import type { ProjectionState } from "./product-projection-state.js";
import type {
  ConversationDelta,
  ConversationSnapshot,
  QueueItem,
} from "@zcode/shared/zcode-protocol-v4";
import { computeAvailability, computeInputRouting } from "./projection-state.js";
import { deriveContext, ms, queuePatch } from "./product-projection-primitives.js";

// ── turn-steer 队列──

export function onTurnSteerQueued(
  state: Pick<ProjectionState, "deliveryByPendingInputId" | "snapshot">,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as TurnSteerQueuedPayload;
  const queueItemId = payload.intent?.queueItemId ?? payload.pendingInputId;
  const existingIndex = state.snapshot.queue.items.findIndex(
    (item) => item.queueItemId === queueItemId,
  );
  const existing = existingIndex >= 0 ? state.snapshot.queue.items[existingIndex] : undefined;
  // queued 事件的 admittedDelivery 只能是 queue/guide。若读到早期或损坏事件里的
  // startNow，必须以实际 queue delivery 为准，不能让投影声称输入已立即启动。
  const admittedDelivery: "queue" | "guide" =
    payload.intent?.admittedDelivery === "queue" || payload.intent?.admittedDelivery === "guide"
      ? payload.intent.admittedDelivery
      : (payload.delivery ??
        (existing?.delivery.admitted === "queue" || existing?.delivery.admitted === "guide"
          ? existing.delivery.admitted
          : state.snapshot.config.followupMode === "guide"
            ? "guide"
            : "queue"));
  const requestedDelivery =
    payload.intent?.requestedDelivery ?? existing?.delivery.requested ?? admittedDelivery;
  const fallbackReasonCode =
    payload.intent?.fallbackReasonCode ?? existing?.delivery.fallbackReasonCode;
  const nextItem: QueueItem = {
    queueItemId,
    kind:
      payload.intent?.kind === "compact" || payload.commandKind === "compact"
        ? ("compact" as const)
        : payload.intent?.kind === "sendGoalCommand" || payload.commandKind === "sendGoalCommand"
          ? ("sendGoalCommand" as const)
          : (existing?.kind ?? ("sendText" as const)),
    text: payload.input,
    sourceCommandId:
      payload.intent?.sourceCommandId ??
      existing?.sourceCommandId ??
      payload.inputId ??
      payload.pendingInputId,
    clientId: payload.intent?.clientId ?? existing?.clientId ?? "cli",
    attachments: payload.intent?.attachmentRefs ?? existing?.attachments ?? [],
    ...((payload.intent?.source ?? existing?.source)
      ? { source: payload.intent?.source ?? existing?.source }
      : {}),
    // QueueItem 同时是提升执行的输入，不只是 UI 展示；漏字段会让新 Turn 沿用旧权限／模型。
    // 旧的正文编辑事件可能没有 intent，只能保留同项原事实，不能读取当前 Session 补值。
    modelSelection: payload.intent?.modelSelection ?? existing?.modelSelection,
    mode: payload.intent?.mode ?? existing?.mode,
    planEnabled: payload.intent?.planEnabled ?? existing?.planEnabled,
    sharedContextRefs: payload.intent?.sharedContextRefs ?? existing?.sharedContextRefs,
    provenance: payload.intent?.provenance ?? existing?.provenance,
    delivery: {
      requested: requestedDelivery,
      admitted: admittedDelivery,
      ...(fallbackReasonCode ? { fallbackReasonCode } : {}),
    },
    order: {
      admissionSeq:
        payload.intent?.admissionSeq ?? existing?.order.admissionSeq ?? event.sequenceNumber,
      queuePosition:
        payload.intent?.queuePosition ??
        existing?.order.queuePosition ??
        Math.max(0, (payload.queueLength ?? 1) - 1),
    },
    steer:
      !payload.intent && !payload.delivery && existing
        ? existing.steer
        : fallbackReasonCode
          ? { state: "fellBack", reasonCode: fallbackReasonCode }
          : admittedDelivery === "guide"
            ? { state: "steering" }
            : { state: "notRequested" },
    dispatch: { state: "queued" },
    ...(payload.toolDisallowlist ? { toolDisallowlist: [...payload.toolDisallowlist] } : {}),
    admittedAt: payload.intent?.admittedAt ?? existing?.admittedAt ?? ms(event),
  };
  // 投递语义侧表：payload 未带（旧 runtime 事件）时按当前 followupMode 兜底。
  state.deliveryByPendingInputId.set(payload.pendingInputId, admittedDelivery);
  // 同 id 重入 = editQueueItem 原地更新（保位）；新 id = 追加。旧逻辑 filter+append
  // 会把编辑项移到队尾，破坏 queueContentIndependence 的位置语义。
  const items =
    existingIndex >= 0
      ? state.snapshot.queue.items.map((item, index) => (index === existingIndex ? nextItem : item))
      : [...state.snapshot.queue.items, nextItem];
  return [
    {
      op: "state.updated",
      patch: queuePatch(state, { ...state.snapshot.queue, items }),
    },
  ];
}

export function onTurnSteerDispatchChanged(
  state: Pick<ProjectionState, "snapshot">,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as TurnSteerDispatchChangedPayload;
  if (
    !state.snapshot.queue.items.some(
      (candidate) => candidate.queueItemId === payload.pendingInputId,
    )
  ) {
    return [];
  }
  const dispatch =
    payload.state === "queued"
      ? ({ state: "queued" } as const)
      : ({
          state: payload.state,
          reservationId: payload.reservationId,
        } as const);
  return [
    {
      op: "state.updated",
      patch: queuePatch(state, {
        ...state.snapshot.queue,
        items: state.snapshot.queue.items.map((candidate) =>
          candidate.queueItemId === payload.pendingInputId ? { ...candidate, dispatch } : candidate,
        ),
      }),
    },
  ];
}

export function onTurnSteerDeliveryChanged(
  state: Pick<ProjectionState, "deliveryByPendingInputId" | "snapshot">,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as TurnSteerDeliveryChangedPayload;
  const queueItemId = payload.intent?.queueItemId ?? payload.pendingInputId;
  if (!state.snapshot.queue.items.some((item) => item.queueItemId === queueItemId)) {
    return [];
  }
  state.deliveryByPendingInputId.set(payload.pendingInputId, payload.admittedDelivery);
  return [
    {
      op: "state.updated",
      patch: queuePatch(state, {
        ...state.snapshot.queue,
        items: state.snapshot.queue.items.map((item) =>
          item.queueItemId === queueItemId
            ? {
                ...item,
                delivery: {
                  requested: payload.requestedDelivery,
                  admitted: payload.admittedDelivery,
                  fallbackReasonCode: payload.fallbackReasonCode,
                },
                steer: {
                  state: "fellBack",
                  reasonCode: payload.fallbackReasonCode,
                },
              }
            : item,
        ),
      }),
    },
  ];
}

/** v4 queue 重排：按 orderedPendingInputIds 重排 queue rows（未列出的项保持相对顺序追加）。 */
export function onTurnSteerReordered(
  state: Pick<ProjectionState, "snapshot">,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as { orderedPendingInputIds?: string[] };
  const order = payload.orderedPendingInputIds ?? [];
  const byId = new Map(state.snapshot.queue.items.map((item) => [item.queueItemId, item]));
  const ordered = order
    .map((id) => byId.get(id))
    .filter((item): item is (typeof state.snapshot.queue.items)[number] => item !== undefined);
  // 未在 order 里出现的项（防丢）追加保持原相对序。
  const orderedIds = new Set(order);
  const rest = state.snapshot.queue.items.filter((item) => !orderedIds.has(item.queueItemId));
  const reordered = [...ordered, ...rest];
  const items = reordered.map((item, index) =>
    item.order.queuePosition === index
      ? item
      : { ...item, order: { ...item.order, queuePosition: index } },
  );
  // 顺序无变化则不产 delta（幂等）。
  if (
    items.length === state.snapshot.queue.items.length &&
    items.every((item, index) => item === state.snapshot.queue.items[index])
  ) {
    return [];
  }
  return [
    {
      op: "state.updated",
      patch: queuePatch(state, { ...state.snapshot.queue, items }),
    },
  ];
}

// setAutoDrain：queue.autoDrain 授权位翻转。autoDrain 影响 held 派生
// （heldQueueInputRequiresChoice）与 A 区可用性 → 走 queuePatch 统一重算。
export function onQueueAutoDrainChanged(
  state: Pick<ProjectionState, "snapshot">,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as { autoDrain?: boolean };
  const autoDrain = payload.autoDrain ?? true;
  if (
    state.snapshot.queue.autoDrain === autoDrain &&
    (autoDrain || state.snapshot.queue.pauseReason === "manual")
  ) {
    return [];
  }
  const queue = { ...state.snapshot.queue, autoDrain };
  if (autoDrain) {
    delete queue.pauseReason;
  } else {
    queue.pauseReason = "manual";
  }
  return [
    {
      op: "state.updated",
      patch: queuePatch(state, queue),
    },
  ];
}

// setFollowupMode：config.followupMode 翻转。followupMode 是 running 时
// enqueue vs guide 的路由授权位（computeInputRouting）→ 改 config 后同步重算 A 区。
export function onFollowupModeChanged(
  state: Pick<ProjectionState, "snapshot">,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as { mode?: "queue" | "guide" };
  const mode: "queue" | "guide" = payload.mode === "guide" ? "guide" : "queue";
  if (state.snapshot.config.followupMode === mode) return [];
  const nextConfig: ConversationSnapshot["config"] = {
    ...state.snapshot.config,
    followupMode: mode,
  };
  const context = deriveContext(state, {});
  return [
    {
      op: "state.updated",
      patch: {
        config: nextConfig,
        availability: computeAvailability(context),
        inputRouting: computeInputRouting(context, mode),
      },
    },
  ];
}

export function removeQueueItems(
  state: Pick<ProjectionState, "deliveryByPendingInputId" | "snapshot">,
  ids: readonly string[],
): ConversationDelta[] {
  const idSet = new Set(ids);
  for (const id of ids) state.deliveryByPendingInputId.delete(id);
  const items = state.snapshot.queue.items
    .filter((item) => !idSet.has(item.queueItemId))
    .map((item, index) =>
      item.order.queuePosition === index
        ? item
        : { ...item, order: { ...item.order, queuePosition: index } },
    );
  if (items.length === state.snapshot.queue.items.length) return [];
  return [
    {
      op: "state.updated",
      patch: queuePatch(state, { ...state.snapshot.queue, items }),
    },
  ];
}
