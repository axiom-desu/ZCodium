import {
  CoreErrorType,
  SessionEventType,
  createCoreError,
  createSessionEvent,
  traceContextToLogContext,
} from "../deps.js";
import type {
  PendingTurnInput,
  SessionEvent,
  TraceContext,
  TurnSteerRejectReason,
  TurnSteerResult,
  TurnId,
} from "../deps.js";
import type { ActiveTurnKind, ActiveTurnSteeringState } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";

export function hasSteerInput(request: Pick<PendingTurnInput, "attachments" | "input">): boolean {
  return request.input.trim().length > 0 || Boolean(request.attachments?.length);
}

export function beginActiveTurn(
  this: AgentRuntimeInternal,
  turnId: TurnId,
  traceContext: TraceContext,
  kind: ActiveTurnKind,
  steerable: boolean,
  options?: { inputId?: string },
): ActiveTurnSteeringState {
  if (this.activeTurn) {
    throw createTurnInProgressError(kind, this.activeTurn.turnId, turnId);
  }
  const reservation = this.activeTurnStartReservation;
  if (reservation && reservation.turnId !== turnId) {
    throw createTurnInProgressError(kind, reservation.turnId, turnId);
  }

  const activeTurn: ActiveTurnSteeringState = {
    goalStateChangeReminderDeferralOpen: false,
    kind,
    pendingInputs: [],
    steerable,
    traceContext,
    turnId,
    ...(options?.inputId === undefined ? {} : { inputId: options.inputId }),
  };
  this.activeTurnStartReservation = undefined;
  this.activeTurn = activeTurn;
  return activeTurn;
}

export function reserveTurnStart(
  this: AgentRuntimeInternal,
  turnId: TurnId,
  traceContext: TraceContext,
  kind: ActiveTurnKind,
): void {
  if (this.activeTurn) {
    throw createTurnInProgressError(kind, this.activeTurn.turnId, turnId);
  }
  if (this.activeTurnStartReservation) {
    throw createTurnInProgressError(kind, this.activeTurnStartReservation.turnId, turnId);
  }
  this.activeTurnStartReservation = {
    kind,
    traceContext,
    turnId,
  };
}

export function releaseTurnStart(this: AgentRuntimeInternal, turnId: TurnId): void {
  if (this.activeTurnStartReservation?.turnId === turnId) {
    this.activeTurnStartReservation = undefined;
  }
}

export function finishActiveTurn(
  this: AgentRuntimeInternal,
  activeTurn: ActiveTurnSteeringState | undefined,
): void {
  if (activeTurn !== undefined && this.activeTurn === activeTurn) {
    this.activeTurn = undefined;
  }
}

export function createPendingInputId(this: AgentRuntimeInternal, turnId: TurnId): string {
  this.pendingInputSequence += 1;
  return `pending_${turnId}_${this.pendingInputSequence}`;
}

function createTurnInProgressError(
  kind: ActiveTurnKind,
  activeTurnId: TurnId,
  nextTurnId: TurnId,
): Error {
  return createCoreError(
    CoreErrorType.TurnInProgress,
    `Cannot start ${kind} turn while another turn is active`,
    {
      context: {
        activeTurnId,
        nextTurnId,
      },
      recoverable: true,
    },
  );
}

export async function rejectTurnSteer(
  this: AgentRuntimeInternal,
  reason: TurnSteerRejectReason,
  options: {
    activeTurn?: ActiveTurnSteeringState;
    expectedTurnId?: TurnId;
    inputPreview?: string;
    inputSize?: number;
    traceContext?: TraceContext;
  },
): Promise<TurnSteerResult> {
  const traceContext =
    options.activeTurn?.traceContext ?? options.traceContext ?? this.rootTraceContext;
  const event = createSessionEvent(
    SessionEventType.TurnSteerRejected,
    this.sessionId,
    {
      activeTurnId: options.activeTurn?.turnId,
      expectedTurnId: options.expectedTurnId,
      inputPreview: options.inputPreview,
      inputSize: options.inputSize,
      reason,
    },
    {
      traceId: traceContext.traceId,
      turnId: options.activeTurn?.turnId,
    },
  );
  await this.appendEvent(event, traceContext);
  this.logger?.debug("Turn steer rejected", {
    ...traceContextToLogContext(traceContext),
    activeQueueLength: options.activeTurn?.pendingInputs.length,
    activeTurnId: options.activeTurn?.turnId,
    activeTurnKind: options.activeTurn?.kind,
    activeTurnSteerable: options.activeTurn?.steerable,
    event: "turn.steer.rejected",
    expectedTurnId: options.expectedTurnId,
    inputPreview: options.inputPreview,
    inputSize: options.inputSize,
    module: "core.runtime",
    reason,
    status: "completed",
  });
  return {
    activeTurnId: options.activeTurn?.turnId,
    kind: "rejected",
    reason,
  };
}

export function hasPendingInput(
  this: AgentRuntimeInternal,
  activeTurn: ActiveTurnSteeringState,
): boolean {
  return this.activeTurn === activeTurn && activeTurn.pendingInputs.length > 0;
}

function pendingInputDelivery(pendingInput: PendingTurnInput | undefined): "guide" | "queue" {
  const delivery = pendingInput?.delivery ?? pendingInput?.intent?.admittedDelivery;
  return delivery === "guide" ? "guide" : "queue";
}

export function firstInlineGuideIndex(activeTurn: ActiveTurnSteeringState): number {
  // pendingInputs 同时承载 future queue 与 current-turn guide，只检查
  // 数组队首，导致先入队的普通消息把后续显式 guide 永久挡住。delivery 才是消费车道；
  // 这里只在 guide 子序列内保持 admission FIFO，普通 queue 留在原位等待外层提升。
  return activeTurn.pendingInputs.findIndex(
    (pendingInput) =>
      pendingInput.commandKind !== "sendGoalCommand" &&
      pendingInput.commandKind !== "compact" &&
      pendingInputDelivery(pendingInput) === "guide",
  );
}

export function hasInlineGuidePendingInput(
  this: AgentRuntimeInternal,
  activeTurn: ActiveTurnSteeringState,
): boolean {
  const guideIndex = firstInlineGuideIndex(activeTurn);
  const pendingInput = guideIndex >= 0 ? activeTurn.pendingInputs[guideIndex] : undefined;
  return (
    this.activeTurn === activeTurn &&
    !this.permissionFullAccessPending &&
    !this.queueExternalDrainActive &&
    !this.pendingInputReservations.has(pendingInput?.id ?? "") &&
    pendingInput?.commandKind !== "sendGoalCommand" &&
    pendingInput?.commandKind !== "compact" &&
    pendingInputDelivery(pendingInput) === "guide"
  );
}

/**
 * 当前 product turn 被 stop/interrupted，或 FIFO barrier 阻止安全 inline 时，把尚未消费的
 * guide 原地改投普通 queue。正常可消费的 text-only guide 仍在当前 active turn 内续跑。
 */
export async function fallbackPendingGuidesToQueue(
  this: AgentRuntimeInternal,
  options: {
    activeTurn: ActiveTurnSteeringState;
    events?: SessionEvent[];
    reasonCode: "guide.noToolBoundary" | "guide.turnInterrupted";
    traceContext: TraceContext;
  },
): Promise<number> {
  if (this.activeTurn !== options.activeTurn) return 0;
  let changed = 0;
  for (const pendingInput of options.activeTurn.pendingInputs) {
    if (pendingInputDelivery(pendingInput) !== "guide") continue;
    const intent = pendingInput.intent
      ? {
          ...pendingInput.intent,
          admittedDelivery: "queue" as const,
          fallbackReasonCode: options.reasonCode,
        }
      : undefined;
    const event = this.createEvent(
      SessionEventType.TurnSteerDeliveryChanged,
      {
        admittedDelivery: "queue",
        fallbackReasonCode: options.reasonCode,
        ...(intent ? { intent } : {}),
        pendingInputId: pendingInput.id,
        requestedDelivery: "guide",
        targetTurnId: options.activeTurn.turnId,
      },
      options.traceContext,
    );
    await this.appendEvent(event, options.traceContext);
    options.events?.push(event);
    pendingInput.delivery = "queue";
    if (intent) pendingInput.intent = intent;
    changed += 1;
    this.logger?.debug("Guide input fell back to ordinary queue", {
      ...traceContextToLogContext(options.traceContext),
      event: "turn.guide.fell_back",
      fallbackReasonCode: options.reasonCode,
      module: "core.runtime",
      pendingInputId: pendingInput.id,
      status: "completed",
      targetTurnId: options.activeTurn.turnId,
    });
  }
  return changed;
}
