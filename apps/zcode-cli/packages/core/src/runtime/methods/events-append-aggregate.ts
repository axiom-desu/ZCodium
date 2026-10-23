import { traceContextToLogContext } from "../deps.js";
import type { SessionEvent, TraceContext } from "../deps.js";
import { SessionEventType } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

const SESSION_EVENT_APPEND_SUMMARY_FLUSH_COUNT = 100;

const SUMMARY_SESSION_EVENT_TYPES = new Set<SessionEventType>([
  SessionEventType.ModelStreaming,
  SessionEventType.ModelNetworkStatus,
  SessionEventType.StreamingToolLedgerUpdated,
  SessionEventType.ToolCallProgress,
]);

interface SessionEventAppendAggregate {
  eventCount: number;
  eventType: SessionEventType;
  firstEventId: string;
  firstSessionEventSequenceNumber: number;
  lastEventId: string;
  lastSessionEventSequenceNumber: number;
  payloadBytes: number;
  payloadKinds: Record<string, number>;
}

const sessionEventAppendAggregates = new WeakMap<
  AgentRuntimeInternal,
  Map<string, SessionEventAppendAggregate>
>();

export function recordSessionEventAppendAggregate(
  this: AgentRuntimeInternal,
  event: SessionEvent,
  traceContext: TraceContext,
): boolean {
  if (!SUMMARY_SESSION_EVENT_TYPES.has(event.type)) {
    return false;
  }

  const aggregateKey = `${traceContext.turnId ?? "session"}:${event.type}`;
  const aggregateMap = getSessionEventAppendAggregateMap(this);
  const payloadKind = getPayloadKind(event.payload);
  const existing = aggregateMap.get(aggregateKey);
  if (existing) {
    existing.eventCount += 1;
    existing.lastEventId = String(event.id);
    existing.lastSessionEventSequenceNumber = event.sequenceNumber;
    existing.payloadBytes += measureJsonBytes(event.payload);
    existing.payloadKinds[payloadKind] = (existing.payloadKinds[payloadKind] ?? 0) + 1;
    if (existing.eventCount >= SESSION_EVENT_APPEND_SUMMARY_FLUSH_COUNT) {
      flushSessionEventAppendAggregate.call(
        this,
        aggregateKey,
        existing,
        traceContext,
        "count_threshold",
      );
    }
    return true;
  }

  aggregateMap.set(aggregateKey, {
    eventCount: 1,
    eventType: event.type,
    firstEventId: String(event.id),
    firstSessionEventSequenceNumber: event.sequenceNumber,
    lastEventId: String(event.id),
    lastSessionEventSequenceNumber: event.sequenceNumber,
    payloadBytes: measureJsonBytes(event.payload),
    payloadKinds: { [payloadKind]: 1 },
  });
  return true;
}

export function flushSessionEventAppendAggregates(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
  reason: "count_threshold" | "low_frequency_event",
): void {
  const aggregateMap = sessionEventAppendAggregates.get(this);
  if (!aggregateMap || aggregateMap.size === 0) {
    return;
  }
  for (const [aggregateKey, aggregate] of aggregateMap) {
    flushSessionEventAppendAggregate.call(this, aggregateKey, aggregate, traceContext, reason);
  }
}

function flushSessionEventAppendAggregate(
  this: AgentRuntimeInternal,
  aggregateKey: string,
  aggregate: SessionEventAppendAggregate,
  traceContext: TraceContext,
  reason: "count_threshold" | "low_frequency_event",
): void {
  const aggregateMap = sessionEventAppendAggregates.get(this);
  aggregateMap?.delete(aggregateKey);
  // 日志治理原因：model streaming / progress 类事件与 token 流同频，
  // 逐条写默认日志会把 eventStore 索引复制成巨量 daily log；这里保留 seq 范围和 kind 分布用于定位。
  this.logger?.debug("Session event append summary", {
    ...traceContextToLogContext(traceContext),
    event: "event_store.appended.summary",
    eventCount: aggregate.eventCount,
    firstEventId: aggregate.firstEventId,
    firstSessionEventSequenceNumber: aggregate.firstSessionEventSequenceNumber,
    flushReason: reason,
    lastEventId: aggregate.lastEventId,
    lastSessionEventSequenceNumber: aggregate.lastSessionEventSequenceNumber,
    module: "core.runtime",
    payloadBytes: aggregate.payloadBytes,
    payloadKinds: aggregate.payloadKinds,
    sessionEventType: aggregate.eventType,
  });
}

function getSessionEventAppendAggregateMap(
  runtime: AgentRuntimeInternal,
): Map<string, SessionEventAppendAggregate> {
  let aggregateMap = sessionEventAppendAggregates.get(runtime);
  if (!aggregateMap) {
    aggregateMap = new Map();
    sessionEventAppendAggregates.set(runtime, aggregateMap);
  }
  return aggregateMap;
}

function getPayloadKind(payload: unknown): string {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const kind = (payload as Record<string, unknown>).kind;
    if (typeof kind === "string" && kind.length > 0) {
      return kind;
    }
  }
  return "<missing>";
}

function measureJsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
  } catch {
    return 0;
  }
}
