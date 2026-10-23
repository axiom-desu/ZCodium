import type { TraceSpan, TraceSpanLane, TraceSpanStatus } from "../src/shared.js";
import { stringValue } from "./sources.js";
import type { EventRecord, LoadedObservation, LogRecord } from "./types.js";
import {
  compareIsoAsc,
  eventToolCallId,
  eventToolName,
  modelName,
  subagentLabel,
  summarizeEvent,
} from "./analyzer-values.js";

export function buildTraceSpans(
  traceId: string,
  _sessions: Set<string>,
  observation: LoadedObservation,
): TraceSpan[] {
  const spans: TraceSpan[] = [];
  const traceEvents = observation.events.records
    .filter((event) => event.traceId === traceId)
    .sort((left, right) => compareIsoAsc(left.timestamp, right.timestamp));

  spans.push(
    ...spansFromEventPairs(traceEvents, {
      lane: "turn",
      startType: "turn_started",
      endTypes: ["turn_complete", "turn_error"],
      label: (event) => `Turn ${event.turnId ?? event.sessionId ?? event.id}`,
      match: matchTurnEvents,
    }),
    ...spansFromEventPairs(traceEvents, {
      lane: "model",
      startType: "model_request",
      endTypes: ["model_complete", "model_error"],
      label: (event) => modelName(event.payload) ?? "模型请求",
      match: matchModelEvents,
    }),
    ...spansFromEventPairs(traceEvents, {
      lane: "tool",
      startType: "tool_call_started",
      endTypes: ["tool_call_result", "tool_call_error"],
      label: (event) =>
        eventToolName(event.payload) ?? eventToolCallId(event.payload) ?? "工具调用",
      match: matchToolEvents,
    }),
    ...spansFromEventPairs(traceEvents, {
      lane: "permission",
      startType: "permission_requested",
      endTypes: ["permission_resolved", "permission_denied"],
      label: (event) =>
        eventToolName(event.payload) ?? eventToolCallId(event.payload) ?? "权限请求",
      match: matchPermissionEvents,
    }),
    ...spansFromEventPairs(traceEvents, {
      lane: "subagent",
      startType: "subagent_spawned",
      endTypes: ["subagent_stopped"],
      label: (event) => subagentLabel(event),
      match: matchSubagentEvents,
    }),
  );

  for (const log of observation.logs.records) {
    if (log.traceId !== traceId) continue;
    const span = spanFromLog(log);
    if (span) spans.push(span);
  }

  return spans.sort((left, right) => compareIsoAsc(left.startAt, right.startAt));
}

type SpanPairConfig = {
  lane: TraceSpanLane;
  startType: string;
  endTypes: string[];
  label: (event: EventRecord) => string;
  match: (start: EventRecord, end: EventRecord) => boolean;
};

function spansFromEventPairs(events: EventRecord[], config: SpanPairConfig): TraceSpan[] {
  const spans: TraceSpan[] = [];

  for (const start of events) {
    if (start.type !== config.startType || !start.timestamp) continue;
    const end = findMatchingEndEvent(events, start, config.endTypes, config.match);
    spans.push({
      id: `span:event:${start.id}`,
      traceId: start.traceId,
      sessionId: start.sessionId,
      turnId: start.turnId,
      spanId: start.spanId ?? end?.spanId,
      parentSpanId: start.parentSpanId ?? end?.parentSpanId,
      toolCallId: eventToolCallId(start.payload) ?? eventToolCallId(end?.payload),
      lane: config.lane,
      label: config.label(start),
      source: "eventlog",
      startAt: start.timestamp,
      endAt: end?.timestamp,
      status: spanStatusFromEndEvent(end),
      summary: end ? summarizeEvent(end) : summarizeEvent(start),
      payload: {
        start: eventPayloadForSpan(start),
        end: end ? eventPayloadForSpan(end) : undefined,
      },
    });
  }

  return spans;
}

function eventPayloadForSpan(event: EventRecord): Record<string, unknown> {
  return {
    id: event.id,
    type: event.type,
    timestamp: event.timestamp,
    payload: event.payload,
  };
}

function findMatchingEndEvent(
  events: EventRecord[],
  start: EventRecord,
  endTypes: string[],
  match: (start: EventRecord, end: EventRecord) => boolean,
): EventRecord | undefined {
  const startAt = start.timestamp ?? "";
  return events.find((event) => {
    if (!endTypes.includes(event.type)) return false;
    if (startAt && event.timestamp && event.timestamp < startAt) return false;
    return match(start, event);
  });
}

function matchTurnEvents(start: EventRecord, end: EventRecord): boolean {
  return matchSessionTurn(start, end);
}

function matchModelEvents(start: EventRecord, end: EventRecord): boolean {
  const startId = eventCorrelationId(start.payload, ["modelRequestId", "requestId", "id"]);
  const endId = eventCorrelationId(end.payload, ["modelRequestId", "requestId", "id"]);
  if (startId && endId) return startId === endId;
  return matchSessionTurn(start, end);
}

function matchToolEvents(start: EventRecord, end: EventRecord): boolean {
  const startToolCallId = eventToolCallId(start.payload);
  const endToolCallId = eventToolCallId(end.payload);
  if (startToolCallId && endToolCallId) return startToolCallId === endToolCallId;
  return matchSessionTurn(start, end);
}

function matchPermissionEvents(start: EventRecord, end: EventRecord): boolean {
  const startPermissionId = eventCorrelationId(start.payload, ["permissionId", "requestId"]);
  const endPermissionId = eventCorrelationId(end.payload, ["permissionId", "requestId"]);
  if (startPermissionId && endPermissionId) return startPermissionId === endPermissionId;
  return matchToolEvents(start, end);
}

function matchSubagentEvents(start: EventRecord, end: EventRecord): boolean {
  const startSubagentId = eventCorrelationId(start.payload, [
    "subagentId",
    "subagentSessionId",
    "childSessionId",
    "sessionId",
  ]);
  const endSubagentId = eventCorrelationId(end.payload, [
    "subagentId",
    "subagentSessionId",
    "childSessionId",
    "sessionId",
  ]);
  if (startSubagentId && endSubagentId) return startSubagentId === endSubagentId;
  return matchSessionTurn(start, end);
}

function matchSessionTurn(start: EventRecord, end: EventRecord): boolean {
  if (start.sessionId && end.sessionId && start.sessionId !== end.sessionId) return false;
  if (start.turnId && end.turnId && start.turnId !== end.turnId) return false;
  return true;
}

function eventCorrelationId(
  payload: Record<string, unknown> | undefined,
  names: string[],
): string | undefined {
  for (const name of names) {
    const value = stringValue(payload?.[name]);
    if (value) return value;
  }
  return undefined;
}

function spanStatusFromEndEvent(event: EventRecord | undefined): TraceSpanStatus {
  if (!event) return "unknown";
  if (event.type.endsWith("_error") || event.type === "permission_denied") return "error";
  if (event.type.endsWith("_cancelled") || event.type.endsWith("_canceled")) return "cancelled";
  return "ok";
}

function spanFromLog(log: LogRecord): TraceSpan | undefined {
  if (!log.timestamp || log.durationMs === undefined || log.durationMs <= 0) return undefined;
  const lane = spanLaneFromLog(log);
  const endAt = log.timestamp;
  return {
    id: `span:log:${log.sourcePath}:${log.line}`,
    traceId: log.traceId,
    sessionId: log.sessionId,
    turnId: log.turnId,
    spanId: log.spanId,
    parentSpanId: log.parentSpanId,
    toolCallId: log.toolCallId,
    lane,
    label: log.event ?? log.message ?? "结构化日志",
    source: "log",
    startAt: subtractMs(endAt, log.durationMs),
    endAt,
    status: spanStatusFromLog(log),
    summary: log.message ?? log.event,
    payload: log.context ?? log.error,
  };
}

function spanLaneFromLog(log: LogRecord): TraceSpanLane {
  const subject = `${log.event ?? ""} ${log.module ?? ""} ${log.message ?? ""}`.toLowerCase();
  if (subject.includes("tool")) return "tool";
  if (subject.includes("model") || subject.includes("provider")) return "model";
  if (subject.includes("permission") || subject.includes("approval")) return "permission";
  if (subject.includes("subagent")) return "subagent";
  if (subject.includes("network") || subject.includes("http")) return "network";
  if (subject.includes("sqlite") || subject.includes("storage") || subject.includes("cache")) {
    return "storage";
  }
  if (subject.includes("turn")) return "turn";
  return "log";
}

function spanStatusFromLog(log: LogRecord): TraceSpanStatus {
  const normalized = log.status?.toLowerCase();
  if (normalized === "running" || normalized === "pending") return "running";
  if (normalized === "ok" || normalized === "success" || normalized === "completed") return "ok";
  if (normalized === "error" || normalized === "failed" || normalized === "failure") return "error";
  if (normalized === "cancelled" || normalized === "canceled" || normalized === "aborted") {
    return "cancelled";
  }
  if (log.level === "error") return "error";
  return "unknown";
}

function subtractMs(value: string, durationMs: number): string {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return value;
  return new Date(time - durationMs).toISOString();
}
