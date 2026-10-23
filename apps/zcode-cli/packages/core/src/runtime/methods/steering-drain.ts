import { parseRuntimeInputPresentation } from "@zcode/contracts";
import { runtimeInputMetadata } from "../../agent/runtime-input-presentation.js";
import {
  SessionEventType,
  createMessageId,
  createSessionEvent,
  traceContextToLogContext,
} from "../deps.js";
import type {
  MessageId,
  PendingSteerInputInfo,
  PendingTurnInput,
  SessionEvent,
  TraceContext,
  TurnId,
} from "../deps.js";
import type { ActiveTurnSteeringState, DrainedPendingInputDiagnostics } from "../types.js";
import {
  buildUserContentFromTurn,
  measureUtf8Bytes,
  previewInput,
  resolveTurnAttachments,
} from "../helpers/index.js";
import {
  unpublishedPermissionGrants,
  recoverPendingPermissionGrant,
} from "../permission-grant-recovery.js";
import {
  createRuntimeUserEntry,
  realUserRuntimeMetadata,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { firstInlineGuideIndex } from "./steering-turn-lifecycle.js";

export async function drainPendingInput(
  this: AgentRuntimeInternal,
  options: {
    activeTurn: ActiveTurnSteeringState;
    events: SessionEvent[];
    traceContext: TraceContext;
  },
): Promise<DrainedPendingInputDiagnostics | undefined> {
  if (this.permissionFullAccessPending || this.activeTurn !== options.activeTurn) return undefined;
  if (unpublishedPermissionGrants.has(this)) await recoverPendingPermissionGrant(this);
  if (this.permissionFullAccessPending || this.activeTurn !== options.activeTurn) return undefined;
  // Guide 出队先移除内存、后落事件；完整消费期间不能从旧投影捕获授权目标。
  this.pendingInputDrains = (this.pendingInputDrains ?? 0) + 1;
  try {
    return await drainPendingInputUnlocked.call(this, options);
  } finally {
    this.pendingInputDrains -= 1;
  }
}

async function drainPendingInputUnlocked(
  this: AgentRuntimeInternal,
  options: Parameters<typeof drainPendingInput>[0],
): Promise<DrainedPendingInputDiagnostics | undefined> {
  const guideIndex = firstInlineGuideIndex(options.activeTurn);
  const pendingInput = guideIndex >= 0 ? options.activeTurn.pendingInputs[guideIndex] : undefined;
  if (!pendingInput) return undefined;
  // sendQueuedNow 已 reserve 的队首只能由 reservation owner 提升；普通 roundtrip drain
  // 必须暂停，避免 stop barrier 期间同一输入又被当前 turn 消费一次。
  if (this.pendingInputReservations.has(pendingInput.id)) return undefined;
  // 普通 queue 只能由 bootstrap 在 session-ready + goal gate 后提升；runtime 行内 drain
  // 从 guide 子序列取最早一项，不能让 future queue 偷跑，也不能让它阻塞当前轮引导。
  options.activeTurn.pendingInputs.splice(guideIndex, 1);
  const pendingInputs = [pendingInput];
  const queryIds = pendingInput.queryId ? [pendingInput.queryId] : undefined;
  // steer 是新的真实用户 query。drain 后的下一次模型请求必须切到该 queryId，
  // 不能继续沿用原始 turn query，否则 tool 后续请求会被归因到上一条用户消息。
  const drainTraceContext = pendingInput.queryId
    ? { ...options.traceContext, queryId: pendingInput.queryId }
    : options.traceContext;

  const drainedAt = Date.now();
  const inputPreviews = pendingInputs.map((pendingInput) => previewInput(pendingInput.input));
  const inputSizes = pendingInputs.map((pendingInput) => measureUtf8Bytes(pendingInput.input));
  const queuedDurationsMs = pendingInputs.map(
    (pendingInput) => drainedAt - pendingInput.queuedAt.getTime(),
  );
  const messageIds: MessageId[] = [];
  const runtimeEntries: RuntimeMessageEntry[] = [];
  const drainedInputs: Array<{
    pendingInputId: string;
    messageId: MessageId;
    text: string;
    delivery?: "guide" | "queue";
    intent?: NonNullable<PendingTurnInput["intent"]>;
    toolDisallowlist?: readonly string[];
  }> = [];
  for (const pendingInput of pendingInputs) {
    const messageId = createMessageId();
    // 投递语义缺省按 queue（排队消费=独立轮）；guide 由 v4 命令面
    // 按 inputRouting 显式标注。落到持久 metadata 供冷恢复还原同一切分。
    const delivery = pendingInput.delivery ?? "queue";
    const resolvedAttachments = await resolveTurnAttachments(pendingInput.attachments, {
      artifactStore: this.artifactStore,
      fileSystemPort: this.fileSystemPort,
      imageProcessorPort: this.imageProcessorPort,
      sessionId: this.sessionId,
      traceContext: drainTraceContext,
      turnId: options.activeTurn.turnId,
      workingDirectory: this.workingDirectory,
    });
    // 只在实际 guide 消费且无附件时固化新标记；审批反馈仍走原合同。
    const inputPresentation =
      delivery === "guide" && !pendingInput.source && !pendingInput.attachments?.length
        ? parseRuntimeInputPresentation(pendingInput.inputPresentation)
        : undefined;
    const runtimeEntry = createRuntimeUserEntry(
      buildUserContentFromTurn(pendingInput.input, resolvedAttachments),
      runtimeInputMetadata(inputPresentation) ?? realUserRuntimeMetadata(),
    );
    this.messageHistory.addEntries([runtimeEntry]);
    runtimeEntries.push(runtimeEntry);
    await this.persistUserPrompt(
      messageId,
      pendingInput.input,
      resolvedAttachments,
      drainTraceContext,
      {
        steerDelivery: delivery,
        inputPresentation,
        sessionInputId: pendingInput.id,
        sourceCommandId:
          pendingInput.intent?.sourceCommandId ?? String(pendingInput.queryId ?? pendingInput.id),
        clientId: pendingInput.intent?.clientId,
        intent: pendingInput.intent,
      },
    );
    messageIds.push(messageId);
    drainedInputs.push({
      pendingInputId: pendingInput.id,
      messageId,
      text: pendingInput.input,
      delivery,
      ...(pendingInput.intent ? { intent: pendingInput.intent } : {}),
      ...(pendingInput.toolDisallowlist ? { toolDisallowlist: pendingInput.toolDisallowlist } : {}),
    });
  }

  const pendingInputIds = pendingInputs.map((pendingInput) => pendingInput.id);
  const toolDisallowlist = [
    ...new Set(pendingInputs.flatMap((pendingInput) => pendingInput.toolDisallowlist ?? [])),
  ];
  const event = this.createEvent(
    SessionEventType.TurnSteerDrained,
    {
      injectedMessageIds: messageIds,
      pendingInputIds,
      drainedInputs,
      ...(queryIds ? { queryIds } : {}),
      targetTurnId: options.activeTurn.turnId,
    },
    drainTraceContext,
  );
  await this.appendEvent(event, drainTraceContext);
  options.events.push(event);
  this.logger?.debug("Turn steer drained", {
    ...traceContextToLogContext(drainTraceContext),
    drainedCount: pendingInputs.length,
    event: "turn.steer.drained",
    injectedMessageIds: messageIds,
    inputPreviews,
    inputSizes,
    module: "core.runtime",
    pendingInputIds,
    queryIds,
    queuedDurationsMs,
    status: "completed",
    targetTurnId: options.activeTurn.turnId,
  });
  return {
    injectedMessageIds: messageIds,
    ...(pendingInput.intent ? { intent: pendingInput.intent } : {}),
    latestMessageId: messageIds.at(-1),
    pendingInputIds,
    queryIds,
    runtimeEntries,
    ...(toolDisallowlist.length > 0 ? { toolDisallowlist } : {}),
  };
}

export async function discardPendingInput(
  this: AgentRuntimeInternal,
  options: {
    activeTurn: ActiveTurnSteeringState;
    events?: SessionEvent[];
    reason: "turn_cancelled" | "turn_failed" | "session_resumed";
    traceContext: TraceContext;
  },
): Promise<void> {
  if (this.activeTurn !== options.activeTurn) return;
  const pendingInputs = options.activeTurn.pendingInputs.splice(0);
  if (pendingInputs.length === 0) return;
  const pendingInputIds = pendingInputs.map((pendingInput) => pendingInput.id);

  const event = createSessionEvent(
    SessionEventType.TurnSteerDiscarded,
    this.sessionId,
    {
      pendingInputIds,
      reason: options.reason,
      targetTurnId: options.activeTurn.turnId,
    },
    {
      traceId: options.activeTurn.traceContext.traceId,
      turnId: options.activeTurn.turnId,
    },
  );
  await this.appendEvent(event, options.traceContext);
  options.events?.push(event);
  this.logger?.debug("Turn steer discarded", {
    ...traceContextToLogContext(options.traceContext),
    discardedCount: pendingInputs.length,
    event: "turn.steer.discarded",
    module: "core.runtime",
    pendingInputIds,
    reason: options.reason,
    status: "completed",
    targetTurnId: options.activeTurn.turnId,
  });
}

export async function discardPersistedPendingSteerInputs(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<number> {
  // （重启不保留队列）：先清扫账本残留 admitted——事件日志是
  // 内存的，崩溃后投影里什么都没有，账本是唯一痕迹（含 background wake：后台
  // 子进程随 CLI 重启已死，其未消费通知不可恢复）。留痕（discarded/session_resumed）
  // 不静默，用户/诊断可查「这条输入去哪了」。
  try {
    const admitted =
      (await this.sessionStore?.listSessionInputs?.({
        sessionID: this.sessionId,
        status: "admitted",
      })) ?? [];
    for (const record of admitted) {
      await this.sessionStore?.settleSessionInput?.({
        id: record.id,
        sessionID: this.sessionId,
        status: "discarded",
        reason: "session_resumed",
      });
    }
  } catch (error) {
    this.logger?.warn("Failed to sweep admitted session inputs on resume", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "session_input.resume_sweep_failed",
      module: "core.runtime",
      status: "failed",
    });
  }

  const projection = await this.rebuildProjection();
  const pendingInputs = projection.pendingSteerInputs;
  if (pendingInputs.length === 0) return 0;

  const pendingByTurn = new Map<TurnId, PendingSteerInputInfo[]>();
  for (const pendingInput of pendingInputs) {
    const group = pendingByTurn.get(pendingInput.targetTurnId) ?? [];
    group.push(pendingInput);
    pendingByTurn.set(pendingInput.targetTurnId, group);
  }

  for (const [targetTurnId, group] of pendingByTurn) {
    const pendingInputIds = group.map((item) => item.pendingInputId);
    const event = createSessionEvent(
      SessionEventType.TurnSteerDiscarded,
      this.sessionId,
      {
        pendingInputIds,
        reason: "session_resumed",
        targetTurnId,
      },
      {
        traceId: traceContext.traceId,
        turnId: targetTurnId,
      },
    );
    await this.appendEvent(event, traceContext);
    this.logger?.debug("Turn steer discarded", {
      ...traceContextToLogContext(traceContext),
      discardedCount: group.length,
      event: "turn.steer.discarded",
      module: "core.runtime",
      pendingInputIds,
      reason: "session_resumed",
      status: "completed",
      targetTurnId,
    });
  }

  return pendingInputs.length;
}
