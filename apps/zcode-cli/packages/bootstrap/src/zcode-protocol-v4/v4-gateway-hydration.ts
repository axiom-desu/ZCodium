import type { MessageWithParts, SessionEvent } from "@zcode/contracts";
import { SessionEventType } from "@zcode/contracts";
import type { ZCodeWorkspaceRef } from "@zcode/shared";
import { ConversationTopicPublisher } from "./conversation-topic-publisher.js";
import type { SessionUsageSeed } from "./product-projection.js";
import type { GatewayState } from "./v4-gateway-state.js";
import {
  PROJECTION_EVENT_COMMIT_TIMEOUT_MS,
  ProjectionEventCommitWaitError,
  type HydrationBuffer,
  type PersistedEventsLoadResult,
  type ProjectionEventCommitWaiter,
  type RawSequenceState,
} from "./v4-gateway-contract.js";

/** 本域实际使用的根状态窄面。 */
type HydrationDomainState = Pick<
  GatewayState,
  | "coldResume"
  | "configPublishers"
  | "controlReservations"
  | "createLogEpoch"
  | "detachedLiveSessions"
  | "disposed"
  | "flushStates"
  | "host"
  | "hydratedSessions"
  | "hydrationBuffers"
  | "hydrationInFlight"
  | "indexFanoutThrottle"
  | "indexPublishers"
  | "localTtft"
  | "now"
  | "pausedConnections"
  | "projectionEventCommitWaiters"
  | "publishers"
  | "rawSequenceStates"
  | "readyFlights"
>;
import * as indexconfig from "./v4-gateway-index-config.js";
import * as flush from "./v4-gateway-flush.js";
import { replayHydratedRawEvents } from "./v4-gateway-hydration-replay.js";
import * as sequence from "./v4-gateway-sequence.js";

/** 等待指定 raw event 真正完成 reorder drain + publisher projection apply。 */
export function waitForProjectionEventCommit(
  ctx: HydrationDomainState,
  sessionId: string,
  eventId: string,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  if (ctx.disposed) {
    return Promise.reject(
      new ProjectionEventCommitWaitError(
        "fault.projectionEventCommit.gatewayDisposed",
        "conversation gateway is disposed",
      ),
    );
  }
  const state = sequence.getOrCreateRawSequenceState(ctx, sessionId);
  if (state.appliedEventIds.has(eventId)) return Promise.resolve();
  const failed = state.failedEventById.get(eventId);
  if (failed) return Promise.reject(failed);
  if (options.signal?.aborted) {
    return Promise.reject(
      new ProjectionEventCommitWaitError(
        "fault.projectionEventCommit.aborted",
        `projection event commit wait aborted: ${eventId}`,
        { cause: options.signal.reason },
      ),
    );
  }
  return new Promise<void>((resolve, reject) => {
    const byEvent = ctx.projectionEventCommitWaiters.get(sessionId) ?? new Map();
    ctx.projectionEventCommitWaiters.set(sessionId, byEvent);
    const waiters = byEvent.get(eventId) ?? new Set();
    byEvent.set(eventId, waiters);
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      waiters.delete(waiter);
      if (waiters.size === 0) byEvent.delete(eventId);
      if (byEvent.size === 0) ctx.projectionEventCommitWaiters.delete(sessionId);
    };
    const waiter: ProjectionEventCommitWaiter = {
      resolve: () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      },
      reject: (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    };
    const onAbort = () => {
      // 只 reject 当前 waiter 会让 raw gap 中的 TurnStarted 继续存活；
      // command 已 cancelled 后补齐 gap，迟到事件仍会进入 canonical projection。
      // event failure 必须固化到 sequence state，后续 drain 只推进 cursor、不再 apply。
      sequence.rejectProjectionEventCommit(
        ctx,
        sessionId,
        eventId,
        new ProjectionEventCommitWaitError(
          "fault.projectionEventCommit.aborted",
          `projection event commit wait aborted: ${eventId}`,
          { cause: options.signal?.reason },
        ),
      );
    };
    const timeout = setTimeout(() => {
      sequence.rejectProjectionEventCommit(
        ctx,
        sessionId,
        eventId,
        new ProjectionEventCommitWaitError(
          "fault.projectionEventCommit.timeout",
          `projection event commit wait timed out: ${eventId}`,
        ),
      );
    }, PROJECTION_EVENT_COMMIT_TIMEOUT_MS);
    timeout.unref?.();
    waiters.add(waiter);
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 授权已经提交到任务事务，失败重试必须重放权威日志，不能再次提权或丢弃提交事实。 */
export async function waitForPermissionGrantCommit(
  ctx: HydrationDomainState,
  sessionId: string,
  eventId: string,
): Promise<void> {
  const state = sequence.getOrCreateRawSequenceState(ctx, sessionId);
  if (state.failedEventById.has(eventId)) {
    const event = state.recentRawEventsById.get(eventId);
    if (
      event?.type !== SessionEventType.SessionModeChanged ||
      !(event.payload as { permissionGrant?: unknown }).permissionGrant
    ) {
      throw new Error("Permission grant event unavailable for recovery");
    }
    await ctx.hydrationInFlight.get(sessionId);
    ctx.hydratedSessions.delete(sessionId);
    await hydratePublisher(ctx, sessionId, undefined, true);
  }
  await waitForProjectionEventCommit(ctx, sessionId, eventId);
}

/**
 * dwf 两个 journal 读面的宿主 record 前置。
 *
 * 这两个 query 都经 app 能力读 journal，而宿主按 sessionId 找 record——历史
 * 会话的 record 只由**订阅**路径激活。renderer 里发现查询的 effect 声明在 lease/订阅
 * effect 之前，而 CLI 严格串行派发请求（`zcode-protocol/transport.ts`，只有 session/stop
 * 越队），于是「重启后打开历史会话」时它必然先于订阅被处理、必然拿到 sessionNotFound：
 * 工具卡的 join 回退整块消失，卡片退回编译态，被打断的 run 连入口都没有。
 *
 * 只拉 record，**不**建 READY publisher：journal 与 conversation log 无关，读一页 run
 * 不需要投影（同一判断见这两个 query 刻意不带 atSeq/atLogEpoch）。习语与 attachmentBegin
 * 逐字相同；`ensureResumed` 自带按会话单飞，与并发订阅共享同一次 activation。
 *
 * 活性判定必须与 subscribe 同一条
 * `hasLiveConversation`，不能只看 `sessionExists`。dwf actor transcript 是 detached live
 * 会话——真 runtime 活在 run service 里、宿主刻意没有 record；嵌套 SessionPane 的发现
 * 查询带着 actor id 打到这里，旧判定就对一条**正在运行**的会话物化出第二个（幽灵）
 * runtime：它向同一份事件日志追加 SessionResumed、丢弃 pending steer、重放 resume hooks，
 * 双写把序列账搞乱，transcript 从此定格（症状是直播冻结在「已工作 xx 秒」）。
 */
export async function ensureHostRecordForJournalRead(
  ctx: HydrationDomainState,
  sessionId: string,
): Promise<void> {
  if (hasLiveConversation(ctx, sessionId)) return;
  await ctx.coldResume.ensureResumed(sessionId);
}

/** rows/plans/文件摘要共用的 READY 水位解析：已有 READY 直接复用，否则冷恢复或补 hydrate。 */
export function resolveQueryPublisher(
  ctx: HydrationDomainState,
  sessionId: string,
  isLive: boolean,
): Promise<ConversationTopicPublisher> {
  const existingReady = ctx.readyFlights.get(sessionId);
  if (existingReady) return existingReady;
  return isLive ? hydratePublisher(ctx, sessionId) : ensureColdReadyPublisher(ctx, sessionId);
}

export function ensurePublisher(
  ctx: HydrationDomainState,
  sessionId: string,
): ConversationTopicPublisher {
  let publisher = ctx.publishers.get(sessionId);
  if (!publisher) {
    publisher = new ConversationTopicPublisher(sessionId, ctx.createLogEpoch(sessionId), {
      now: ctx.now,
    });
    ctx.publishers.set(sessionId, publisher);
    // config 种子：创建即注入 runtime 真值（不产 delta / 不 bump revision）。
    seedPublisherConfig(ctx, sessionId, publisher);
  }
  return publisher;
}

/**
 * config 种子注入（防御式：种子失败不打断 conversation 主路径）。
 * 幂等且事件优先（seedConfig 跳过事件触碰过的字段），故在 publisher 创建与
 * hydration 收尾两处都调用——创建时机可能早于 record 完全就位（createSessionRecord
 * 事件接线期间），hydration 处补一次兜住该窗口。
 */
function seedPublisherConfig(
  ctx: HydrationDomainState,
  sessionId: string,
  publisher: ConversationTopicPublisher,
): void {
  const getSeed = ctx.host.getSessionConfigSeed;
  if (!getSeed) return;
  try {
    const seed = getSeed.call(ctx.host, sessionId);
    if (seed) publisher.seedConfig(seed);
  } catch (error) {
    ctx.host.onError?.("v4.configSeed", error);
  }
}

/**
 * 冷恢复 READY 只在明确需要 activation 的入口创建；hydratePublisher 保持 projection-only。
 * 注册 promise 早于 activation，避免 record 提前入册后并发 command/query 越过恢复水位。
 */
export function ensureColdReadyPublisher(
  ctx: HydrationDomainState,
  sessionId: string,
  resumeThoughtLevel?: string,
  workspace?: ZCodeWorkspaceRef,
  additionalDirectories?: string[],
): Promise<ConversationTopicPublisher> {
  const existingFlight = ctx.readyFlights.get(sessionId);
  if (existingFlight) return existingFlight;
  // 先登记同一个 READY，再开始所有耗时工作。
  const operation = Promise.resolve().then(async () => {
    const persistedMessages = await ctx.coldResume.ensureResumed(
      sessionId,
      resumeThoughtLevel,
      workspace,
      additionalDirectories,
    );
    return hydratePublisher(ctx, sessionId, persistedMessages);
  });
  ctx.readyFlights.set(sessionId, operation);
  // 成功和失败都由同一清理函数释放；不创建会重复传播 rejection 的派生 promise。
  const clear = () => {
    if (ctx.readyFlights.get(sessionId) === operation) ctx.readyFlights.delete(sessionId);
  };
  void operation.then(clear, clear);
  return operation;
}

/**
 * 首次订阅时的投影重建（hydration）。语义见 subscribe 注释；
 * synthesized 事件按 sequenceNumber 去重（publisher 已 ingest 过的 live 事件不重放）。
 */
export function hydratePublisher(
  ctx: HydrationDomainState,
  sessionId: string,
  persistedMessages?: MessageWithParts[],
  forceRebuild = false,
): Promise<ConversationTopicPublisher> {
  const existing = ctx.publishers.get(sessionId);
  // 已 hydrate 过的 live publisher：直接复用（避免重复重建 / 双计）。
  if (existing && ctx.hydratedSessions.has(sessionId)) return Promise.resolve(existing);

  const inFlight = ctx.hydrationInFlight.get(sessionId);
  if (inFlight) return inFlight;
  const buffer: HydrationBuffer = {
    cancelled: false,
    eventIds: new Set<string>(),
    rawEvents: [],
  };
  ctx.hydrationBuffers.set(sessionId, buffer);
  const hydration = performHydration(
    ctx,
    sessionId,
    buffer,
    persistedMessages,
    forceRebuild,
  ).finally(() => {
    if (ctx.hydrationBuffers.get(sessionId) === buffer) {
      ctx.hydrationBuffers.delete(sessionId);
    }
    if (ctx.hydrationInFlight.get(sessionId) === hydration) {
      ctx.hydrationInFlight.delete(sessionId);
    }
  });
  ctx.hydrationInFlight.set(sessionId, hydration);
  return hydration;
}

async function performHydration(
  ctx: HydrationDomainState,
  sessionId: string,
  buffer: HydrationBuffer,
  persistedMessages?: MessageWithParts[],
  forceRebuild = false,
): Promise<ConversationTopicPublisher> {
  const existingAtStart = ctx.publishers.get(sessionId);
  const liveSessionAtStart = ctx.host.sessionExists(sessionId);
  const hydrationStartedAt = performance.now();
  ctx.host.onDebug?.(
    `v4 hydrate started session=${sessionId} liveSessionAtStart=${String(liveSessionAtStart)} ` +
      `existingPublisherAtStart=${String(existingAtStart !== undefined)} ` +
      `persistedMessages=${String(persistedMessages?.length ?? 0)}`,
  );
  const loaded: PersistedEventsLoadResult = ctx.host.loadPersistedEvents
    ? await ctx.host.loadPersistedEvents(sessionId, persistedMessages).catch((error) => {
        ctx.host.onError?.("v4.hydrate", error, {
          durationMs: Math.max(0, Math.round(performance.now() - hydrationStartedAt)),
          existingPublisherAtStart: existingAtStart !== undefined,
          liveSessionAtStart,
          phase: "loadPersistedEvents",
          persistedMessages: persistedMessages?.length ?? 0,
          sessionId,
        });
        return { events: [] as SessionEvent[], synthesized: false, sourceEventSeq: 0 };
      })
    : { events: [] as SessionEvent[], synthesized: false, sourceEventSeq: 0 };

  ctx.host.onDebug?.(
    `v4 hydrate loaded session=${sessionId} events=${loaded.events.length} ` +
      `synthesized=${String(loaded.synthesized)} sourceEventSeq=${String(loaded.sourceEventSeq ?? 0)} ` +
      `durationMs=${String(Math.max(0, Math.round(performance.now() - hydrationStartedAt)))}`,
  );

  if (ctx.disposed || buffer.cancelled) {
    throw new Error(`v4 hydration cancelled for session ${sessionId}`);
  }

  // assistant 守恒：拒收过正文流的 publisher 不可信——它建立于
  // TurnStarted 之后，缺段无法用 append-only 重放补进中间位置，只能整体重建。
  const latestPublisher = ctx.publishers.get(sessionId);
  const existingDroppedContent =
    latestPublisher !== undefined && latestPublisher.getDroppedContentStreamEventCount() > 0;
  // 事件日志完整（synthesized=false）且已有健康 live publisher（流式）→ 保留，不重放。
  if (
    existingAtStart &&
    latestPublisher === existingAtStart &&
    !loaded.synthesized &&
    !forceRebuild &&
    !existingDroppedContent
  ) {
    // 创建时种子可能落空（record 尚未入册），首次订阅补一次（幂等、事件优先）。
    ctx.hydrationBuffers.delete(sessionId);
    seedPublisherConfig(ctx, sessionId, latestPublisher);
    if (loaded.sharedContextImport) {
      latestPublisher.seedSharedContextImport(loaded.sharedContextImport);
    }
    await seedPublisherUsage(ctx, sessionId, latestPublisher, persistedMessages, loaded.usageSeed);
    ctx.hydratedSessions.add(sessionId);
    indexconfig.publishCurrentSummaryToIndex(ctx, sessionId);
    return latestPublisher;
  }

  // 只记住 await 之前的 existing 引用是不够的：load 等待期间 raw event
  // 会继续推进这个 publisher，synthesized 返回后却把它整体删除，queue/stream 随之
  // 消失。重建以 sourceEventSeq 为 raw snapshot 边界，并把等待窗口内事件补回。
  const publisher = latestPublisher ?? existingAtStart ?? ensurePublisher(ctx, sessionId);
  sequence.rejectProjectionEventWaiters(
    ctx,
    sessionId,
    new ProjectionEventCommitWaitError(
      "fault.projectionEventCommit.rehydrated",
      `conversation projection rehydrated while waiting for event commit: ${sessionId}`,
    ),
  );
  publisher.rehydrate(loaded.events, {
    // 恢复时 transcript/event store 可能仍含运行期已拒绝的超大正文。不能让同一事实
    // 在 CLI 重启后再次把 subscribe 卡死；跳过该不可传输 projection event，继续归约
    // 后续持久 TurnError/TurnComplete，使冷快照停在最后一个可恢复边界。
    onPayloadTooLarge: (error) =>
      ctx.host.onError?.("v4.hydrate.payloadTooLarge", error, {
        phase: "publisher.rehydrate",
        sessionId,
      }),
  });
  if (loaded.sharedContextImport) {
    publisher.seedSharedContextImport(loaded.sharedContextImport);
  }
  if (loaded.subagentsSeed) publisher.seedSubagents(loaded.subagentsSeed);
  // 同次恢复的种子先应用，再补 live buffer；较新的使用量和选模事件始终获胜。
  if (loaded.usageSeed) publisher.seedUsage(loaded.usageSeed);
  const sourceEventSeq = Math.max(
    0,
    loaded.sourceEventSeq ??
      (loaded.synthesized
        ? 0
        : loaded.events.reduce((maximum, event) => Math.max(maximum, event.sequenceNumber), 0)),
  );
  const previousSequenceState = ctx.rawSequenceStates.get(sessionId);
  const sequenceState: RawSequenceState = {
    sourceEventSeq,
    offset: publisher.getSnapshot().seq - sourceEventSeq,
    lastTransportSeq: publisher.getSnapshot().seq,
    seenEventIds: new Set(loaded.events.map((event) => String(event.id))),
    appliedEventIds: new Set(loaded.events.map((event) => String(event.id))),
    failedEventById: new Map(previousSequenceState?.failedEventById),
    pendingByRawSeq: new Map(),
    recentRawEventsById: new Map(),
  };
  ctx.rawSequenceStates.set(sessionId, sequenceState);
  replayHydratedRawEvents(ctx, sessionId, publisher, sourceEventSeq, previousSequenceState, buffer);
  // publisher 已替换且 buffer 已同步补齐；在 usage seed 的异步等待窗口内，新 raw
  // event 直接走上面的 per-session sequence state 进入新 publisher，不再需要二次 replay。
  if (ctx.hydrationBuffers.get(sessionId) === buffer) {
    ctx.hydrationBuffers.delete(sessionId);
  }
  // 冷恢复种子（重放之后）：resume 已把历史会话的上次选型写回 runtime
  // （reconcileResumedRuntimeSettings），而合成/持久化事件里可能没有 ModelSelected——
  // 种子只填事件未触碰的字段，日志有值时以日志为准（冷恢复口径）。
  seedPublisherConfig(ctx, sessionId, publisher);
  if (loaded.usageSeed === undefined) {
    await seedPublisherUsage(ctx, sessionId, publisher, persistedMessages);
  }
  for (const [routeKey, state] of ctx.flushStates) {
    if (state.sessionId !== sessionId) continue;
    if (!publisher.hasSubscription(state.subscriptionId, state.connectionId)) continue;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (ctx.pausedConnections.has(state.connectionId)) continue;
    const reservation = publisher.reserveFlush(state.subscriptionId);
    if (!reservation) continue;
    try {
      flush.emitReservation(ctx, reservation);
    } catch (error) {
      ctx.host.onError?.("v4.hydrate.subscriptionResync", error, {
        phase: "subscriptionResync",
        sessionId,
      });
      flush.scheduleFlush(ctx, routeKey, state, publisher);
    }
  }
  ctx.hydratedSessions.add(sessionId);
  indexconfig.publishCurrentSummaryToIndex(ctx, sessionId);
  return publisher;
}

/**
 * 运行中 subagent 没有独立 bootstrap record，但 raw child events 会先建立 publisher。
 * publisher 已存在就代表 conversation live 可订阅，不能再把同一 child cold resume 成
 * 第二个 runtime；真正的历史 session 仍由 host record / persisted resume 负责。
 */
export function hasLiveConversation(ctx: HydrationDomainState, sessionId: string): boolean {
  return ctx.host.sessionExists(sessionId) || ctx.detachedLiveSessions.has(sessionId);
}

async function seedPublisherUsage(
  ctx: HydrationDomainState,
  sessionId: string,
  publisher: ConversationTopicPublisher,
  persistedMessages?: MessageWithParts[],
  loadedSeed?: SessionUsageSeed | null,
): Promise<void> {
  if (loadedSeed !== undefined) {
    if (loadedSeed) publisher.seedUsage(loadedSeed);
    return;
  }
  const getSeed = ctx.host.getSessionUsageSeed;
  if (!getSeed) return;
  try {
    const seed = await getSeed.call(ctx.host, sessionId, persistedMessages);
    if (seed) publisher.seedUsage(seed);
  } catch (error) {
    ctx.host.onError?.("v4.usageSeed", error);
  }
}
