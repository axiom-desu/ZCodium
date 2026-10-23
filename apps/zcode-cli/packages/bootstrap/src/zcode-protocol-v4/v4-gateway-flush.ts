import { localTtftFactsSchema } from "@zcode/shared/zcode-protocol-v4";
import type {
  ConversationTopicFrame,
  RoutedTopicFrame,
  SubscribeAck,
} from "@zcode/shared/zcode-protocol-v4";
import { parseConversationTopic } from "@zcode/shared/zcode-protocol-v4";
import { ConversationTopicPublisher } from "./conversation-topic-publisher.js";
import type { TopicFrameReservation } from "./topic-frame-reservation.js";
import type { GatewayState } from "./v4-gateway-state.js";
import {
  encodeReservedTopicFrame,
  subscriptionRouteKey,
  type FlushState,
  type V4SubscribeDispatchResult,
} from "./v4-gateway-contract.js";

/** 本域实际使用的根状态窄面。 */
type FlushDomainState = Pick<
  GatewayState,
  "controlReservations" | "flushStates" | "host" | "localTtft" | "pausedConnections" | "publishers"
>;

/** 测试探针：立即排空某订阅（绕过定时器）。 */
export function flushNow(
  ctx: FlushDomainState,
  subscriptionId: string,
): ConversationTopicFrame | null {
  const match = [...ctx.flushStates.entries()].find(
    ([, state]) => state.subscriptionId === subscriptionId,
  );
  const state = match?.[1];
  if (!state) return null;
  if (ctx.pausedConnections.has(state.connectionId)) return null;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  const publisher = ctx.publishers.get(state.sessionId);
  if (!publisher) return null;
  const reservation = publisher.reserveFlush(state.subscriptionId);
  if (!reservation || !reservation.commit()) return null;
  return reservation.frame;
}

export function scheduleFlush(
  ctx: FlushDomainState,
  routeKey: string,
  state: FlushState,
  publisher: ConversationTopicPublisher,
): void {
  if (ctx.pausedConnections.has(state.connectionId)) return;
  if (state.timer !== null) return;
  const timer = setTimeout(() => {
    state.timer = null;
    // timer 排队后可能收到 SAT；reserve 前必须二次检查，不能产生竞态帧。
    if (ctx.pausedConnections.has(state.connectionId)) return;
    // 惰性清理：订阅已被替换/退订→ 删调度状态，不产帧。
    if (!publisher.hasSubscription(state.subscriptionId, state.connectionId)) {
      ctx.flushStates.delete(routeKey);
      return;
    }
    const reservation = publisher.reserveFlush(state.subscriptionId);
    if (!reservation) return;
    try {
      emitReservation(ctx, reservation);
    } catch (error) {
      ctx.host.onError?.("v4.frame.emit", error);
    }
  }, state.flushWindowMs);
  // CLI 进程退出不被 flush 定时器挂住。
  timer.unref?.();
  state.timer = timer;
}

export function emitReservation<F extends RoutedTopicFrame>(
  ctx: FlushDomainState,
  reservation: TopicFrameReservation<F>,
): boolean {
  // resync/subscribe recovery 已进入 request-scoped outbox 时，online
  // flush 若复用同一 inFlight 会让 physical wire 抢在 ACK response 前出站。
  if (ctx.controlReservations.has(reservation)) return false;
  const sessionId = parseConversationTopic(reservation.frame.topic);
  const route = ctx.flushStates.get(
    subscriptionRouteKey(
      reservation.frame.topic,
      reservation.frame.subscriptionId,
      sessionId
        ? (ctx.publishers
            .get(sessionId)
            ?.connectionIdForSubscription(reservation.frame.subscriptionId) ?? "")
        : "",
    ),
  );
  if (
    sessionId &&
    route?.deliveryProfile === "continuous" &&
    reservation.deliveryKind === "online" &&
    reservation.frame.payload.kind === "deltas" &&
    ctx.localTtft.forSession(sessionId)
  ) {
    const rows = ctx.publishers.get(sessionId)?.getSnapshot().rows.window ?? [];
    const turns = new Set<string>();
    for (const delta of reservation.frame.payload.deltas) {
      if (delta.op === "row.appended" || delta.op === "row.upserted") turns.add(delta.row.turnId);
      else if (delta.op === "row.delta") {
        const row = rows.find((item) => item.rowId === delta.rowId);
        if (row) turns.add(row.turnId);
      }
    }
    const related = rows
      .filter((row) => row.kind === "turnHeader" && turns.has(row.turnId))
      .flatMap((header) =>
        header.kind === "turnHeader" && header.sourceCommandId
          ? [ctx.localTtft.forSession(sessionId, header.sourceCommandId)]
          : [],
      )
      .filter((facts) => facts !== undefined);
    const candidates = related.length ? related : [ctx.localTtft.forSession(sessionId)];
    const observations: import("@zcode/shared").LocalTtftFacts[] = [];
    for (const facts of candidates) {
      if (!facts || observations.some((item) => item.observationId === facts.observationId))
        continue;
      const header = rows.find(
        (row) => row.kind === "turnHeader" && row.sourceCommandId === facts.commandId,
      );
      const observation = localTtftFactsSchema.safeParse({
        ...facts,
        ...(ctx.host.cliVersion ? { cliVersion: ctx.host.cliVersion } : {}),
        ...(header ? { productTurnId: header.turnId } : {}),
      });
      // 转正前后的内容可能被同批发送；按实际 row 所属原输入携带事实，不能取最新队列项。
      if (observation.success) observations.push(observation.data);
    }
    if (observations.length) {
      (reservation.frame as ConversationTopicFrame).ttft = observations[0];
      if (observations.length > 1)
        (reservation.frame as ConversationTopicFrame).ttftRelated = observations.slice(1, 17);
    }
  }
  const wires = encodeReservedTopicFrame(reservation as TopicFrameReservation<RoutedTopicFrame>);
  for (const wire of wires) ctx.host.emitWireFrame(wire);
  return reservation.commit();
}

export function subscribeDispatch<F extends RoutedTopicFrame>(
  ctx: FlushDomainState,
  ack: SubscribeAck,
  reservation: TopicFrameReservation<F> | null,
  afterCommit?: () => void,
): V4SubscribeDispatchResult<F> {
  const initialWires = reservation
    ? encodeReservedTopicFrame(reservation as TopicFrameReservation<RoutedTopicFrame>)
    : [];
  if (reservation) ctx.controlReservations.add(reservation);
  let afterCommitRan = false;
  return {
    ack,
    initialFrame: reservation?.frame ?? null,
    initialWires,
    commit: () => {
      if (!reservation) return true;
      ctx.controlReservations.delete(reservation);
      const committed = reservation.commit();
      if (committed && !afterCommitRan) {
        afterCommitRan = true;
        // control reservation 等 ACK/outbox admission 时，既有 flush timer
        // 可能已触发并因同一 inFlight 被抑制。commit 后必须主动重驱动 publisher，
        // 否则期间积累的 delta 会一直等到下一次 ingest/publish 才可见。
        afterCommit?.();
      }
      return committed;
    },
  };
}
