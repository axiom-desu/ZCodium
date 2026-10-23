import type { SessionEvent } from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import type { GatewayState } from "./v4-gateway-state.js";
import type { RawSequenceState } from "./v4-gateway-contract.js";

/** 本域实际使用的根状态窄面。 */
type SequenceDomainState = Pick<GatewayState, "projectionEventCommitWaiters" | "rawSequenceStates">;

/**
 * cold 合成会把事件重新编号为 1..N，而 runtime 仍沿用 eventStore raw seq。这里用
 * source cursor 建立 N-C 偏移；raw seq=0（live-only child）则顺延，并同步校正后续偏移。
 * eventId 兜住 snapshot/buffer 同时看见同一事件的竞态，cursor 兜住已入 snapshot 的事件。
 */
export function normalizeRuntimeEventSequence(
  ctx: SequenceDomainState,
  sessionId: string,
  event: SessionEvent,
): SessionEvent[] {
  const state = getOrCreateRawSequenceState(ctx, sessionId);
  const eventId = String(event.id);
  if (state.seenEventIds.has(eventId)) return [];

  const rawSeq = event.sequenceNumber;
  state.recentRawEventsById.set(eventId, event);
  while (state.recentRawEventsById.size > PROTOCOL_V4_LIMITS.eventRetentionPerSession) {
    const oldestEventId = state.recentRawEventsById.keys().next().value;
    if (oldestEventId === undefined) break;
    state.recentRawEventsById.delete(oldestEventId);
  }
  if (rawSeq <= 0) {
    state.seenEventIds.add(eventId);
    state.lastTransportSeq += 1;
    return [{ ...event, sequenceNumber: state.lastTransportSeq }];
  }
  if (event.type === SessionEventType.SessionResumed) {
    // 旧 runtime 在 unsubscribe/重建窗口时可能遗漏尾部 raw event。新 runtime
    // 延续持久 eventStore 高水位时，SessionResumed 的 raw seq 会大于旧 cursor；
    // 若只处理 seq 回退，resume 和后续 TurnStarted 就会永久等待无法补齐的旧 gap。
    // SessionResumed 是明确 epoch 边界：丢弃边界前的旧 pending，同时保留可能乱序先到的
    // 新 epoch 后续事件，再从 resume 自身连续 drain。
    for (const pendingSeq of state.pendingByRawSeq.keys()) {
      if (pendingSeq <= rawSeq) state.pendingByRawSeq.delete(pendingSeq);
    }
    state.sourceEventSeq = rawSeq - 1;
    state.offset = state.lastTransportSeq - state.sourceEventSeq;
  }
  if (rawSeq <= state.sourceEventSeq) {
    state.seenEventIds.add(eventId);
    resolveProjectionEventCommit(ctx, sessionId, eventId);
    return [];
  }

  state.seenEventIds.add(eventId);
  if (!state.pendingByRawSeq.has(rawSeq)) state.pendingByRawSeq.set(rawSeq, event);
  const ready: SessionEvent[] = [];
  // eventStore 先编号，各事件各自 await 持久化后再 notify，
  // 因此 N+1 可以先于 N 到达。高水位过滤会把迟到 N 错判成 duplicate；
  // 必须按 raw seq 暂存，只连续 drain，才能保住 queue/stream 总序。
  for (;;) {
    const nextRawSeq = state.sourceEventSeq + 1;
    const next = state.pendingByRawSeq.get(nextRawSeq);
    if (!next) break;
    state.pendingByRawSeq.delete(nextRawSeq);
    let transportSeq = nextRawSeq + state.offset;
    if (transportSeq <= state.lastTransportSeq) {
      transportSeq = state.lastTransportSeq + 1;
      state.offset = transportSeq - nextRawSeq;
    }
    state.sourceEventSeq = nextRawSeq;
    state.lastTransportSeq = transportSeq;
    // waiter timeout/abort 只清 listener 是不够的，还要终止已在 raw gap 中的
    // event。command 返回 failed 后，缺失 seq 一到仍会把同一 TurnStarted 投影出来。
    // 失败事件仍消费 raw 序号以解除后续事件阻塞，但绝不能再成为 canonical fact。
    if (state.failedEventById.has(String(next.id))) {
      continue;
    }
    ready.push(
      transportSeq === next.sequenceNumber ? next : { ...next, sequenceNumber: transportSeq },
    );
  }
  return ready;
}

export function getOrCreateRawSequenceState(
  ctx: SequenceDomainState,
  sessionId: string,
): RawSequenceState {
  const existing = ctx.rawSequenceStates.get(sessionId);
  if (existing) return existing;
  const created: RawSequenceState = {
    sourceEventSeq: 0,
    offset: 0,
    lastTransportSeq: 0,
    seenEventIds: new Set(),
    appliedEventIds: new Set(),
    failedEventById: new Map(),
    pendingByRawSeq: new Map(),
    recentRawEventsById: new Map(),
  };
  ctx.rawSequenceStates.set(sessionId, created);
  return created;
}

export function resolveProjectionEventCommit(
  ctx: SequenceDomainState,
  sessionId: string,
  eventId: string,
): void {
  const state = getOrCreateRawSequenceState(ctx, sessionId);
  state.failedEventById.delete(eventId);
  state.appliedEventIds.add(eventId);
  const waiters = ctx.projectionEventCommitWaiters.get(sessionId)?.get(eventId);
  if (!waiters) return;
  // 与拆分前 gateway 私有实现一致：先取快照再 settle。settle 会从该 Set 删除 waiter，
  // 未来若在 settle 过程中重入登记新 waiter，live iterator 会把它一并处理掉。
  for (const waiter of Array.from(waiters)) waiter.resolve();
}

export function rejectProjectionEventCommit(
  ctx: SequenceDomainState,
  sessionId: string,
  eventId: string,
  error: Error,
): void {
  const state = getOrCreateRawSequenceState(ctx, sessionId);
  state.failedEventById.set(eventId, error);
  const waiters = ctx.projectionEventCommitWaiters.get(sessionId)?.get(eventId);
  if (!waiters) return;
  // 同 resolve：保持拆分前的快照语义，只 settle 本轮开始时已存在的 waiter。
  for (const waiter of Array.from(waiters)) waiter.reject(error);
}

export function rejectProjectionEventWaiters(
  ctx: SequenceDomainState,
  sessionId: string,
  error: Error,
): void {
  const byEvent = ctx.projectionEventCommitWaiters.get(sessionId);
  if (!byEvent) return;
  for (const waiters of byEvent.values()) {
    // 同 resolve：快照遍历，避免 settle 期间集合变化影响本轮处理范围。
    for (const waiter of Array.from(waiters)) waiter.reject(error);
  }
  ctx.projectionEventCommitWaiters.delete(sessionId);
}
