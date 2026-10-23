import type { SessionEvent, TurnErrorPayload } from "@zcode/contracts";
import {
  parseZCodeBackgroundTaskNotificationText,
  zcodeBackgroundTaskNotificationToolUpdateStatus,
} from "@zcode/shared";
import type { ProjectionState } from "./product-projection-state.js";
import { closeStreamingRows } from "./product-projection-stream.js";
import { closeOpenToolRows, findToolRow } from "./product-projection-tool-rows.js";
import type {
  ConversationDelta,
  ToolCallRow,
  TurnHeaderRow,
  UserInputRow,
} from "@zcode/shared/zcode-protocol-v4";
import type { CanonicalUserIntentFact } from "./event-normalizer.js";
import { buildToolOutput } from "./projection-rows.js";
import {
  LEGACY_TURN_ERROR_RECOVERABLE_FALLBACK,
  controlPatch,
  ms,
  registerCanonicalUserRowTarget,
  rowBase,
  turnHeaderForEvent,
} from "./product-projection-primitives.js";
import { leaveDraftAfterControlOnlyTurn } from "./product-projection-turn-facts.js";
import { upsertTurnHeader } from "./product-projection-turn-segments.js";

export function onTurnStarted(
  state: ProjectionState,
  fact: CanonicalUserIntentFact,
): ConversationDelta[] {
  const event = fact.event;
  const runtimeTurnId = fact.runtimeTurnId;
  const turnId = fact.productTurnId;
  state.currentTurnId = runtimeTurnId;
  state.currentTurnStartedModelOnly = fact.visibility === "modelOnly";
  // 新 runtimeTurn：product turn 映射归零（1:1），工时基准 = 本轮起点。
  state.productTurnIdByRuntimeTurnId.delete(runtimeTurnId);
  if (turnId !== runtimeTurnId) state.productTurnIdByRuntimeTurnId.set(runtimeTurnId, turnId);
  state.runtimeTurnIdByProductTurnId.set(turnId, runtimeTurnId);
  state.productTurnSplitOrdinalByRuntimeTurnId.delete(runtimeTurnId);
  state.currentProductTurnStartedAtMs = ms(event);
  state.streamingTextRowId = null;
  state.streamingReasoningRowId = null;
  state.outputContinuationTextRowId = null;

  // background Agent 的 ToolCallResult 只是 launch ACK，先把工具行收口成
  // success；子 Agent 的真实终态随后只作为 model-only task-notification 开新轮。
  // V4 过去没有按 tool-use-id 消费这条权威事实，因此 429 后卡片会永久停在 completed。
  const deltas: ConversationDelta[] = applyBackgroundTaskNotification(state, fact);
  const sharedContextRef = fact.sharedContextRefs?.[0];
  if (
    sharedContextRef &&
    state.snapshot.sharedContextImport &&
    "contextId" in state.snapshot.sharedContextImport &&
    state.snapshot.sharedContextImport.contextId === sharedContextRef.context_id &&
    (state.snapshot.sharedContextImport.status === "pending" ||
      state.snapshot.sharedContextImport.status === "reserved")
  ) {
    const sharedContextImport = {
      ...state.snapshot.sharedContextImport,
      status: "attached" as const,
    };
    state.snapshot = { ...state.snapshot, sharedContextImport };
    deltas.push({ op: "state.updated", patch: { sharedContextImport } });
  }
  // marker 时机：只有当
  // 本轮实际使用的 provider/model 身份与上一轮不同时，才在 turnHeader 之前落
  // modelChange marker。普通首轮 silentInitial 不产 marker；显式 sourceLess 边界
  // 生成“正在使用”marker。思考深度变化只更新 config.thought，不是模型身份变化。
  // Bug 背景：旧实现在 onModelSelected（切换动作时）即落 marker，草稿态预热会话
  // 切一次模型就会在首条消息上方挂出 [modelChange]。
  const config = state.snapshot.config;
  const hasModel = config.provider !== "" && config.model !== "";
  if (hasModel && state.lastTurnModel.kind === "sourceLess") {
    deltas.push({
      op: "row.appended",
      row: {
        ...rowBase(
          state,
          event,
          turnId,
          `model-initial:${turnId}:${config.provider}/${config.model}`,
        ),
        kind: "timelineMarker",
        lane: "lightBoundary",
        marker: {
          type: "modelChange",
          toProvider: config.provider,
          toModel: config.model,
          toThought: config.thought,
        },
      },
    });
  } else if (
    hasModel &&
    state.lastTurnModel.kind === "known" &&
    (state.lastTurnModel.provider !== config.provider || state.lastTurnModel.model !== config.model)
  ) {
    deltas.push({
      op: "row.appended",
      row: {
        ...rowBase(
          state,
          event,
          turnId,
          `model-change:${turnId}:${state.lastTurnModel.provider}/${state.lastTurnModel.model}->${config.provider}/${config.model}`,
        ),
        kind: "timelineMarker",
        // lane 由投影裁决（UI 不得按 marker type 自行推断落位语义）。
        lane: "lightBoundary",
        marker: {
          type: "modelChange",
          fromProvider: state.lastTurnModel.provider,
          fromModel: state.lastTurnModel.model,
          toProvider: config.provider,
          toModel: config.model,
          toThought: config.thought,
        },
      },
    });
  }
  if (hasModel) {
    state.lastTurnModel = {
      kind: "known",
      provider: config.provider,
      model: config.model,
      thought: config.thought,
    };
  }
  const headerBase = rowBase(state, event, turnId, turnId);
  const header: TurnHeaderRow = {
    ...headerBase,
    kind: "turnHeader",
    origin: fact.turnHeaderOrigin,
    executionKind: fact.executionKind,
    ...(fact.sourceCommandId ? { sourceCommandId: fact.sourceCommandId } : {}),
    ...(fact.originMeta ? { originMeta: fact.originMeta } : {}),
    ...(fact.workflowLaunch ? { workflowLaunch: fact.workflowLaunch } : {}),
    state: "running",
    startedAt: headerBase.createdAt,
  };
  state.turnHeaderRowIdByTurnId.set(turnId, header.rowId);
  deltas.push({ op: "row.appended", row: header });

  // model-only 输入（goal continuation 等）不产生可见 userInput row。
  if (fact.visibility === "visible") {
    const userRowBase = rowBase(state, event, turnId, fact.entityId);
    const rootSourceCommandId = fact.provenance?.sourceCommandId ?? fact.sourceCommandId;
    const attachments = fact.attachments?.map((attachment, index) => ({
      ...attachment,
      ref: attachment.ref ?? `turn-attachment/${userRowBase.rowId}/${index}`,
    }));
    const row: UserInputRow = {
      ...userRowBase,
      kind: "userInput",
      text: fact.input,
      origin: fact.origin,
      ...(fact.sourceCommandId ? { sourceCommandId: fact.sourceCommandId } : {}),
      ...(rootSourceCommandId ? { rootSourceCommandId } : {}),
      ...(fact.clientId ? { clientId: fact.clientId } : {}),
      ...(fact.workflowLaunch ? { workflowLaunch: fact.workflowLaunch } : {}),
      ...(fact.epilogueStart === undefined ? {} : { epilogueStart: fact.epilogueStart }),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      ...(fact.source ? { source: fact.source } : {}),
    };
    // workspace checkpoint 以 user messageId 为 targetMessageId。
    // 普通 TurnStarted 也要登记 userInput row 的内部锚点，否则文件摘要 query
    // 只能找到 assistant messageId，展开列表会查不到该轮 checkpoint。
    registerCanonicalUserRowTarget(
      state,
      row.rowId,
      fact.entityId,
      fact.transcriptMessageId
        ? {
            entityId: fact.entityId,
            productTurnId: fact.productTurnId,
            transcriptMessageId: fact.transcriptMessageId,
            coveredByStableCompact: false,
            intent: {
              kind: fact.intentKind,
              text: fact.intentText,
              ...(fact.sourceCommandId ? { sourceCommandId: fact.sourceCommandId } : {}),
              ...(fact.clientId ? { clientId: fact.clientId } : {}),
              ...(fact.attachments ? { attachments: fact.attachments } : {}),
              ...(fact.queueItemId ? { queueItemId: fact.queueItemId } : {}),
              ...(fact.admissionSeq !== undefined ? { admissionSeq: fact.admissionSeq } : {}),
              ...(fact.admittedAt !== undefined ? { admittedAt: fact.admittedAt } : {}),
              ...(fact.requestedDelivery ? { requestedDelivery: fact.requestedDelivery } : {}),
              ...(fact.admittedDelivery ? { admittedDelivery: fact.admittedDelivery } : {}),
              ...(fact.fallbackReasonCode ? { fallbackReasonCode: fact.fallbackReasonCode } : {}),
              ...(fact.modelSelection ? { modelSelection: fact.modelSelection } : {}),
              ...(fact.mode ? { mode: fact.mode } : {}),
              ...(fact.planEnabled !== undefined ? { planEnabled: fact.planEnabled } : {}),
              ...(fact.provenance ? { provenance: fact.provenance } : {}),
            },
          }
        : undefined,
    );
    deltas.push({
      op: "row.appended",
      row,
    });
  }

  if (fact.executionKind === "agent") {
    deltas.push({
      op: "state.updated",
      patch: controlPatch(state, {
        phase: "running",
        sessionEnded: false,
        canStop: true,
        stopState: "stoppable",
        stopTargetKind: "assistant",
        activeWorks: [
          {
            kind: fact.origin === "goalContinuation" ? "goalContinuation" : "primaryTurn",
            ...(fact.foregroundExecutionId
              ? { foregroundExecutionId: fact.foregroundExecutionId }
              : {}),
            startedAt: ms(event),
          },
        ],
        // 新一轮被接受后，旧错误不再是当前事实（与旧 reducer 同一裁决）。
        lastError: null,
        apiRetry: null,
      }),
    });
  }
  // /goal 的可见 query 用 controlOnly turn 建立 live 时间线身份，
  // 但真实执行属于紧随其后的 goalContinuation。若控制轮也推进 running，连续链路
  // 会短暂生成第二份 activeWorks，恢复投影也会出现伪造的工作生命周期。
  return deltas;
}

function applyBackgroundTaskNotification(
  state: ProjectionState,
  fact: CanonicalUserIntentFact,
): ConversationDelta[] {
  const parsed = parseZCodeBackgroundTaskNotificationText(fact.input);
  if (!parsed) return [];
  const row = findToolRow(state, parsed.toolUseId);
  if (!row) return [];

  const notificationStatus = zcodeBackgroundTaskNotificationToolUpdateStatus(
    parsed.notification.status,
  );
  const status: ToolCallRow["status"] =
    notificationStatus === "failed"
      ? "error"
      : notificationStatus === "stopped"
        ? "cancelled"
        : "success";
  const content =
    parsed.notification.result ?? parsed.notification.summary ?? parsed.notification.error;
  const next: ToolCallRow = {
    ...row,
    status,
    ...(content
      ? {
          output: buildToolOutput({ success: status === "success", content }, parsed.toolUseId),
        }
      : {}),
    endedAt: ms(fact.event),
  };
  if (status === "error") {
    next.error = {
      code: "fault.runtime.backgroundTaskFailed",
      message: parsed.notification.error ?? content ?? "Background task failed.",
    };
  } else {
    delete next.error;
  }
  return [{ op: "row.upserted", row: next }];
}

export function onTurnError(state: ProjectionState, event: SessionEvent): ConversationDelta[] {
  const payload = event.payload as TurnErrorPayload;
  state.outputContinuationTextRowId = null;
  if (turnHeaderForEvent(state, event)?.executionKind === "controlOnly") {
    const deltas = [
      ...upsertTurnHeader(state, event, "failed"),
      ...leaveDraftAfterControlOnlyTurn(state, "error"),
    ];
    state.currentTurnId = null;
    // turn 收口后 model-only 标记随之失效，避免影响下一次归属判断。
    state.currentTurnStartedModelOnly = false;
    return deltas;
  }
  // TurnError 结束的是当前 turn，
  // 不是已经 accepted 的 future input。旧 reducer 没有 terminal queue patch，core 为了
  // 防止 error 后悬挂只能先发 TurnSteerDiscarded，造成用户消息丢失；现在把现有 queue
  // 原样转成 error-paused，等待显式 setAutoDrain(true) 恢复 FIFO。
  const heldQueue =
    state.snapshot.queue.items.length > 0
      ? {
          ...state.snapshot.queue,
          autoDrain: false,
          pauseReason: "error" as const,
        }
      : undefined;
  return [
    ...closeStreamingRows(state, "interrupted"),
    ...closeOpenToolRows(state, event, "error"),
    ...upsertTurnHeader(state, event, "failed"),
    {
      op: "state.updated",
      patch: controlPatch(
        state,
        {
          phase: "error",
          sessionEnded: false,
          canStop: false,
          stopState: "idle",
          stopTargetKind: "unknown",
          activeWorks: [],
          // 事件侧尚未携带 fault.* 分类，先透传错误类型，待补齐分类后再细化映射。
          lastError: {
            code: payload.error.code ?? payload.error.type ?? "fault.runtime.unknown",
            message: payload.error.message,
            recoverable: payload.error.retryable ?? LEGACY_TURN_ERROR_RECOVERABLE_FALLBACK,
            at: ms(event),
            // 旧投影把所有 TurnError 都写成 runtime，丢失 adapter 已识别的 provider/network 事实。
            source: payload.error.attribution?.source ?? "runtime",
            traceId: String(event.traceId),
            ...(payload.error.detail ? { detail: payload.error.detail } : {}),
            ...(payload.error.underlyingErrorMessage
              ? { underlyingErrorMessage: payload.error.underlyingErrorMessage }
              : {}),
            ...(payload.error.underlyingErrorDetail
              ? { underlyingErrorDetail: payload.error.underlyingErrorDetail }
              : {}),
            ...(payload.error.attribution ? { attribution: payload.error.attribution } : {}),
          },
          // 同 onTurnComplete：终态是重试生命周期的兜底清理边界。
          apiRetry: null,
        },
        undefined,
        heldQueue,
      ),
    },
  ];
}
