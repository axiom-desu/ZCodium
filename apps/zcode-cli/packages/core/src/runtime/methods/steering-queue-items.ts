import { SessionEventType, createSessionEvent, traceContextToLogContext } from "../deps.js";
import type { PendingSteerInputInfo, TraceContext, TurnId } from "../deps.js";
import {
  unpublishedPermissionGrants,
  recoverPendingPermissionGrant,
} from "../permission-grant-recovery.js";
import type { AgentRuntimeInternal } from "../internal.js";

async function pendingInputTargetTurnId(
  runtime: AgentRuntimeInternal,
  pendingInputId: string,
): Promise<TurnId | undefined> {
  const active = runtime.activeTurn?.pendingInputs.find((item) => item.id === pendingInputId);
  if (active) return active.turnId;
  const projection = await runtime.rebuildProjection();
  return projection.pendingSteerInputs.find((item) => item.pendingInputId === pendingInputId)
    ?.targetTurnId;
}

async function appendPendingInputDispatch(
  runtime: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    reservationId?: string;
    state: "queued" | "reserved" | "promoting";
    targetTurnId: TurnId;
    traceContext: TraceContext;
  },
): Promise<void> {
  const event = createSessionEvent(
    SessionEventType.TurnSteerDispatchChanged,
    runtime.sessionId,
    {
      pendingInputId: options.pendingInputId,
      ...(options.reservationId ? { reservationId: options.reservationId } : {}),
      state: options.state,
      targetTurnId: options.targetTurnId,
    },
    { traceId: options.traceContext.traceId, turnId: options.targetTurnId },
  );
  await runtime.appendEvent(event, options.traceContext);
}

async function settleRemovedSessionInput(
  runtime: AgentRuntimeInternal,
  pendingInputId: string,
  reason: "user_removed" | "promoted",
): Promise<void> {
  if (reason !== "user_removed") return;
  // 只删内存 queue/event 会留下 admitted 的 durable session_input。
  // LRU 淘汰后 commands/query 会退成 unknown，CLI restart 又会把用户主动删除误报为
  // inputDiscardedOnRestart。先写 cancelled 终态，失败时不允许 UI queue 先消失。
  await runtime.sessionStore?.settleSessionInput?.({
    id: pendingInputId,
    sessionID: runtime.sessionId,
    status: "cancelled",
    reason: "user_removed",
  });
}

export async function persistSessionInputUpdates(
  runtime: AgentRuntimeInternal,
  updates: Array<{ id: string; text?: string; queuePosition?: number }>,
): Promise<void> {
  await runtime.sessionStore?.updateSessionInputs?.({
    sessionID: runtime.sessionId,
    updates,
  });
}

export async function reservePendingInputById(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    reservationId: string;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  if (this.permissionFullAccessPending || this.pendingInputReservations.has(options.pendingInputId))
    return false;
  if (unpublishedPermissionGrants.has(this)) await recoverPendingPermissionGrant(this);
  const targetTurnId = await pendingInputTargetTurnId(this, options.pendingInputId);
  // rebuildProjection 上方有 await；落锁前必须复查，避免两端同时读到未占用。
  if (
    !targetTurnId ||
    this.permissionFullAccessPending ||
    this.pendingInputReservations.has(options.pendingInputId)
  )
    return false;
  this.pendingInputReservations.set(options.pendingInputId, options.reservationId);
  try {
    await appendPendingInputDispatch(this, {
      ...options,
      state: "reserved",
      targetTurnId,
    });
    return true;
  } catch (error) {
    this.pendingInputReservations.delete(options.pendingInputId);
    throw error;
  }
}

export async function markPendingInputPromoting(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    reservationId: string;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  if (this.pendingInputReservations.get(options.pendingInputId) !== options.reservationId) {
    return false;
  }
  const targetTurnId = await pendingInputTargetTurnId(this, options.pendingInputId);
  if (!targetTurnId) return false;
  await appendPendingInputDispatch(this, {
    ...options,
    state: "promoting",
    targetTurnId,
  });
  return true;
}

export async function releasePendingInputReservation(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    reservationId: string;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  if (this.pendingInputReservations.get(options.pendingInputId) !== options.reservationId) {
    return false;
  }
  const targetTurnId = await pendingInputTargetTurnId(this, options.pendingInputId);
  this.pendingInputReservations.delete(options.pendingInputId);
  if (!targetTurnId) return true;
  try {
    await appendPendingInputDispatch(this, {
      pendingInputId: options.pendingInputId,
      state: "queued",
      targetTurnId,
      traceContext: options.traceContext,
    });
  } catch (error) {
    // 事件写失败时 reservation 仍必须保持，不能让第二端重复执行。
    this.pendingInputReservations.set(options.pendingInputId, options.reservationId);
    throw error;
  }
  return true;
}

/**
 * （v4 queue 单项管理）：按 id 从当前 active turn 的 pendingInputs 移除一条，
 * 发 TurnSteerDiscarded([id])。v4 ProductProjection 已消费该事件移除对应 queue row。
 * 旧架构 queue 是 renderer-local，无单项 op；v4 queue 移入 CLI 投影后需此原生能力。
 * 返回是否移除（未命中 id / 无 active turn → false）。
 */
export async function removePendingInputById(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    reason: "user_removed" | "promoted";
    reservationId?: string;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  const reservationId = this.pendingInputReservations.get(options.pendingInputId);
  if (reservationId && reservationId !== options.reservationId) return false;
  const activeTurn = this.activeTurn;
  const index =
    activeTurn?.pendingInputs.findIndex(
      (pendingInput) => pendingInput.id === options.pendingInputId,
    ) ?? -1;
  if (!activeTurn || index < 0) {
    // held 回落（stop/完成后 queue 保留成 held）：held 项只存在于
    // 事件日志/投影（active turn 已结束），按投影定位后补 TurnSteerDiscarded。
    return this.discardHeldPendingInputById(
      options.pendingInputId,
      options.traceContext,
      options.reservationId,
      options.reason,
    );
  }
  await settleRemovedSessionInput(this, options.pendingInputId, options.reason);
  activeTurn.pendingInputs.splice(index, 1);
  const event = createSessionEvent(
    SessionEventType.TurnSteerDiscarded,
    this.sessionId,
    {
      pendingInputIds: [options.pendingInputId],
      reason: options.reason,
      targetTurnId: activeTurn.turnId,
    },
    {
      traceId: activeTurn.traceContext.traceId,
      turnId: activeTurn.turnId,
    },
  );
  await this.appendEvent(event, options.traceContext);
  this.pendingInputReservations.delete(options.pendingInputId);
  this.logger?.debug("Turn steer item removed", {
    ...traceContextToLogContext(options.traceContext),
    event: "turn.steer.removed",
    module: "core.runtime",
    pendingInputId: options.pendingInputId,
    status: "completed",
    targetTurnId: activeTurn.turnId,
  });
  return true;
}

/**
 * held 项按 id 丢弃（heldQueueDisposition=clearQueueAndSend 的执行件）：
 * active turn 结束后 pendingInputs 内存态即消亡，held queue 的权威在事件日志——
 * 经投影反查该项仍未 drain/discard 后补 TurnSteerDiscarded(user_removed)。
 */
export async function discardHeldPendingInputById(
  this: AgentRuntimeInternal,
  pendingInputId: string,
  traceContext: TraceContext,
  reservationId?: string,
  reason: "user_removed" | "promoted" = "user_removed",
): Promise<boolean> {
  const currentReservation = this.pendingInputReservations.get(pendingInputId);
  if (currentReservation && currentReservation !== reservationId) return false;
  const projection = await this.rebuildProjection();
  const held = projection.pendingSteerInputs.find((item) => item.pendingInputId === pendingInputId);
  if (!held) return false;
  await settleRemovedSessionInput(this, pendingInputId, reason);
  const event = createSessionEvent(
    SessionEventType.TurnSteerDiscarded,
    this.sessionId,
    {
      pendingInputIds: [pendingInputId],
      reason,
      targetTurnId: held.targetTurnId,
    },
    {
      traceId: traceContext.traceId,
      turnId: held.targetTurnId,
    },
  );
  await this.appendEvent(event, traceContext);
  this.pendingInputReservations.delete(pendingInputId);
  this.logger?.debug("Turn steer item removed", {
    ...traceContextToLogContext(traceContext),
    event: "turn.steer.removed",
    module: "core.runtime",
    pendingInputId,
    status: "completed",
    targetTurnId: held.targetTurnId,
  });
  return true;
}

/**
 * 清空全部排队输入（heldQueueDisposition=clearQueueAndSend 的执行件）：
 * 先摘 active turn 内存项（防后续 roundtrip drain），再按投影清扫 held 残留。
 * 返回丢弃条数。
 */
export async function clearAllPendingInputs(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<number> {
  let cleared = 0;
  const activeTurn = this.activeTurn;
  if (activeTurn && activeTurn.pendingInputs.length > 0) {
    for (const item of activeTurn.pendingInputs) {
      await settleRemovedSessionInput(this, item.id, "user_removed");
    }
    const removed = activeTurn.pendingInputs.splice(0);
    cleared += removed.length;
    const event = createSessionEvent(
      SessionEventType.TurnSteerDiscarded,
      this.sessionId,
      {
        pendingInputIds: removed.map((item) => item.id),
        reason: "user_removed",
        targetTurnId: activeTurn.turnId,
      },
      {
        traceId: activeTurn.traceContext.traceId,
        turnId: activeTurn.turnId,
      },
    );
    await this.appendEvent(event, traceContext);
  }
  const projection = await this.rebuildProjection();
  const heldByTurn = new Map<TurnId, PendingSteerInputInfo[]>();
  for (const item of projection.pendingSteerInputs) {
    const group = heldByTurn.get(item.targetTurnId) ?? [];
    group.push(item);
    heldByTurn.set(item.targetTurnId, group);
  }
  for (const [targetTurnId, group] of heldByTurn) {
    for (const item of group) {
      await settleRemovedSessionInput(this, item.pendingInputId, "user_removed");
    }
    cleared += group.length;
    const event = createSessionEvent(
      SessionEventType.TurnSteerDiscarded,
      this.sessionId,
      {
        pendingInputIds: group.map((item) => item.pendingInputId),
        reason: "user_removed",
        targetTurnId,
      },
      {
        traceId: traceContext.traceId,
        turnId: targetTurnId,
      },
    );
    await this.appendEvent(event, traceContext);
  }
  return cleared;
}
