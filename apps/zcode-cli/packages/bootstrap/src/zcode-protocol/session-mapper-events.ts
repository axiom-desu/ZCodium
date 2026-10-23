import {
  zcodeApiRetryFromModelNetworkStatusPayload,
  zcodeApiRetryFromStreamRecoveryPayload,
} from "@zcode/shared";
import type { ZCodeDeliveryKind, ZCodeSessionEvent } from "@zcode/shared";
import { SessionEventType } from "@zcode/contracts";
import type { PendingPermission, SessionEvent } from "@zcode/contracts";
import {
  buildProtocolPermissionOptions,
  toLegacyPermissionOptionsPolicy,
} from "./permission-options.js";
import { asRecord, stringValue } from "./session-mapper-values.js";

export function mapSessionEvent(
  event: SessionEvent,
  deliveryKind?: ZCodeDeliveryKind,
  options: { seq?: number } = {},
): ZCodeSessionEvent {
  return {
    deliveryKind,
    eventId: String(event.id),
    payload: mapSessionEventPayload(event),
    seq: options.seq ?? event.sequenceNumber,
    sessionId: String(event.sessionId),
    timestamp: event.timestamp.getTime(),
    traceId: String(event.traceId),
    turnId: event.turnId ? String(event.turnId) : undefined,
    type: mapSessionEventType(event.type),
  };
}

export function mapSessionEventForProtocol(
  event: SessionEvent,
  deliveryKind?: ZCodeDeliveryKind,
  options: { seq?: number } = {},
): ZCodeSessionEvent | null {
  if (!shouldExposeSessionEventToProtocol(event)) {
    return null;
  }
  return mapSessionEvent(event, deliveryKind, options);
}

export function mapSessionEvents(
  events: readonly SessionEvent[],
  deliveryKind?: ZCodeDeliveryKind,
): ZCodeSessionEvent[] {
  return events
    .map((event) => mapSessionEventForProtocol(event, deliveryKind))
    .filter((event): event is ZCodeSessionEvent => event !== null);
}

export function shouldExposeSessionEventToProtocol(event: SessionEvent): boolean {
  if (event.type === SessionEventType.StreamingToolLedgerUpdated) {
    // 性能修复：StreamingToolLedgerUpdated 是 runtime replay 账本，常在 closed/queued/started/committed
    // 阶段携带同一份完整 tool input。UI 协议流已有 model.streaming/tool.updated 生命周期，
    // 继续透出会造成大参数反复全量跨进程传输，且 mapper 最终也不会消费这些内部状态。
    return false;
  }

  if (event.type === SessionEventType.DynamicWorkflowRunProgress) {
    // 与上面同一个 seam、同一个理由：workflow run 事件对 v3 完全同构——v4 面已有权威投影
    // （workflowRuns 状态键），v3 mapper 不消费这些内部状态，继续透出只是把每个节点相位
    // 迁移都跨进程搬一遍。**注意与前置特性的偏斜危害不同**：这里的剥离不是为了防丢事件，
    // 新类型不会被 v3 拒收（mapSessionEventType 的 default 落到 session.updated，其 payload
    // 是宽松的 jsonObjectSchema），纯粹是带宽与语义干净。
    return false;
  }

  if (event.type !== SessionEventType.ModelStreaming) {
    return true;
  }

  const payload = asRecord(event.payload);
  const kind = stringValue(payload.kind);
  const delta = stringValue(payload.delta);
  // UI 已支持工具参数预览后，tool_input_* 不能再在协议边界丢弃；
  // 否则 Write/Edit 会在模型思考阶段完全不可见。小包压力由 runtime 合并 delta 控制。
  if (kind === "text_delta" || kind === "reasoning_delta") {
    return Boolean(delta);
  }
  return (
    kind === "tool_input_start" ||
    kind === "tool_input_delta" ||
    kind === "tool_input_end" ||
    kind === "tool_call"
  );
}

function mapSessionEventPayload(event: SessionEvent): unknown {
  const payload = event.payload;
  switch (event.type) {
    case SessionEventType.ModelRequest:
      return mapModelRequestPayload(payload);
    case SessionEventType.ModelNetworkStatus:
      return mapModelNetworkStatusPayload(payload);
    case SessionEventType.StreamRecoveryAnchorCreated:
    case SessionEventType.StreamRecoveryStarted:
    case SessionEventType.StreamRecoveryAnchorSelected:
    case SessionEventType.StreamRecoveryRetryStarted:
    case SessionEventType.StreamRecoveryTailDiscarded:
    case SessionEventType.StreamRecoveryBlocked:
      return mapStreamRecoveryPayload(payload);
    case SessionEventType.ToolCallScheduled:
      return { ...(payload as Record<string, unknown>), kind: "scheduled" };
    case SessionEventType.ToolCallStarted:
      return mapToolCallStartedPayload(payload, event.timestamp);
    case SessionEventType.ToolCallProgress:
      return { ...(payload as Record<string, unknown>), kind: "progress" };
    case SessionEventType.ToolCallResult:
      return { ...(payload as Record<string, unknown>), kind: "result" };
    case SessionEventType.ToolCallError:
      return { ...(payload as Record<string, unknown>), kind: "error" };
    case SessionEventType.ToolBatchComplete:
      return { ...(payload as Record<string, unknown>), kind: "batch" };
    case SessionEventType.PermissionRequested:
      return mapPermissionRequestedPayload(payload);
    case SessionEventType.PermissionDenied:
      return mapPermissionDeniedPayload(payload);
    default:
      return payload;
  }
}

function mapPermissionDeniedPayload(payload: unknown): Record<string, unknown> {
  const record = asRecord(payload);
  return {
    ...record,
    // PermissionDenied 复用 permission.resolved 协议事件。
    // 下游投影依赖 decision=deny 才会把已出现的工具卡收口成失败态。
    decision: "deny",
  };
}

function mapToolCallStartedPayload(
  payload: unknown,
  eventTimestamp: Date,
): Record<string, unknown> {
  const record = asRecord(payload);
  return {
    ...record,
    // ToolCallStarted 的 startedAt 来自 runtime Date 对象；协议跨进程后必须是
    // 稳定 JSON 值，否则接收侧 strict schema 会把 started 事件当成无效消息丢弃。
    startedAt: protocolInstantValue(record.startedAt) ?? eventTimestamp.getTime(),
    kind: "started",
  };
}

function protocolInstantValue(value: unknown): number | string | undefined {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  return undefined;
}

function mapModelRequestPayload(payload: unknown): Record<string, unknown> {
  const record = asRecord(payload);
  // 内存 event store 淘汰 sealed turn 时会把 messages 瘦身为 messageCount
  // （session-event-retention.ts 的 slimRetainedModelRequest），两种形态都要映射出同一个条数。
  const messageCount =
    typeof record.messageCount === "number"
      ? record.messageCount
      : Array.isArray(record.messages)
        ? record.messages.length
        : 0;
  const result: Record<string, unknown> = {
    messageCount,
  };
  for (const key of [
    "providerId",
    "modelId",
    "temperature",
    "maxTokens",
    "toolCount",
    "iteration",
  ]) {
    if (record[key] !== undefined) {
      result[key] = record[key];
    }
  }
  // model_request 的 messages 是发给模型的完整上下文，只用于 core 内部追踪。
  // 之前映射成 session.updated 后会把全量上下文反复推给桌面，工具轮次越多单包越大。
  return result;
}

function mapModelNetworkStatusPayload(payload: unknown): Record<string, unknown> {
  const record = asRecord(payload);
  const apiRetry = zcodeApiRetryFromModelNetworkStatusPayload(record);
  if (apiRetry === undefined) {
    return record;
  }
  const meta = asRecord(record._meta);
  const zcodeMeta = asRecord(meta.zcode);
  return {
    ...record,
    _meta: {
      ...meta,
      zcode: {
        ...zcodeMeta,
        // 网络重试是模型请求运行态，不属于可持久化消息内容。
        // 这里通过 app 私有 meta 暴露给旧 task 投影，app 再写入 host runtime snapshot。
        apiRetry,
      },
    },
  };
}

function mapStreamRecoveryPayload(payload: unknown): Record<string, unknown> {
  const record = asRecord(payload);
  const apiRetry = zcodeApiRetryFromStreamRecoveryPayload(record);
  if (apiRetry === undefined) {
    return record;
  }
  const meta = asRecord(record._meta);
  const zcodeMeta = asRecord(meta.zcode);
  return {
    ...record,
    _meta: {
      ...meta,
      zcode: {
        ...zcodeMeta,
        // streamRecovery.updated 才是 SSE 断流恢复的核心进度事件。
        // 之前只在后续 model_request_started 上补 meta，UI 错过该事件时不会显示重试次数。
        apiRetry,
      },
    },
  };
}

function mapPermissionRequestedPayload(payload: unknown): Record<string, unknown> {
  // 同 mapPendingPermission：这个 payload 是整体 spread 出去的，新字段必须在这里显式解构
  // 剔除，否则会直接漏进 strict 的 zcodePermissionRequestedEventPayloadSchema。
  const { display: _display, optionsPolicy, ...record } = asRecord(payload);
  const toolName = stringValue(record.toolName) ?? "unknown";
  return {
    ...record,
    options: buildProtocolPermissionOptions({
      input: record.input,
      suggestedPermissionUpdates: Array.isArray(record.suggestedPermissionUpdates)
        ? (record.suggestedPermissionUpdates as PendingPermission["suggestedPermissionUpdates"])
        : undefined,
      optionsPolicy: toLegacyPermissionOptionsPolicy(optionsPolicy),
      toolName,
    }),
  };
}

function mapSessionEventType(type: SessionEvent["type"]): ZCodeSessionEvent["type"] {
  switch (type) {
    case SessionEventType.SessionCreated:
      return "session.created";
    case SessionEventType.SessionResumed:
      return "session.resumed";
    case SessionEventType.SessionTitleUpdated:
      return "session.titleUpdated";
    case SessionEventType.SessionEnded:
      return "session.closed";
    case SessionEventType.TurnStarted:
      return "turn.started";
    case SessionEventType.TurnSteerQueued:
      return "turn.steerQueued";
    case SessionEventType.TurnSteerDrained:
      return "turn.steerDrained";
    case SessionEventType.TurnComplete:
      return "turn.completed";
    case SessionEventType.TurnError:
      return "turn.failed";
    case SessionEventType.UserMessage:
    case SessionEventType.AssistantMessage:
    case SessionEventType.SystemMessage:
      return "message.upserted";
    case SessionEventType.ModelStreaming:
      return "model.streaming";
    case SessionEventType.ToolCallScheduled:
    case SessionEventType.ToolCallStarted:
    case SessionEventType.ToolCallProgress:
    case SessionEventType.ToolCallResult:
    case SessionEventType.ToolCallError:
    case SessionEventType.ToolBatchComplete:
      return "tool.updated";
    case SessionEventType.PermissionRequested:
      return "permission.requested";
    case SessionEventType.PermissionResolved:
    case SessionEventType.PermissionDenied:
      return "permission.resolved";
    case SessionEventType.CheckpointCreated:
      return "checkpoint.created";
    case SessionEventType.RewindTriggered:
      return "rewind.triggered";
    case SessionEventType.StreamRecoveryAnchorCreated:
    case SessionEventType.StreamRecoveryStarted:
    case SessionEventType.StreamRecoveryAnchorSelected:
    case SessionEventType.StreamRecoveryRetryStarted:
    case SessionEventType.StreamRecoveryTailDiscarded:
    case SessionEventType.StreamRecoveryBlocked:
      return "streamRecovery.updated";
    default:
      return "session.updated";
  }
}
