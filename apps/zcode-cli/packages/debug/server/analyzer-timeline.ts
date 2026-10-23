import type { TimelineItem } from "../src/shared.js";
import type {
  DbMessageRecord,
  DbPartRecord,
  EventRecord,
  LoadedObservation,
  LogRecord,
} from "./types.js";
import {
  compareIsoDesc,
  eventToolCallId,
  formatRole,
  normalizeLogLevel,
  summarizeDbMessage,
  summarizeDbPart,
  summarizeEvent,
} from "./analyzer-values.js";

export function buildTimeline(
  traceId: string,
  sessions: Set<string>,
  observation: LoadedObservation,
): TimelineItem[] {
  const items: TimelineItem[] = [];

  for (const log of observation.logs.records) {
    if (log.traceId !== traceId) continue;
    items.push(timelineFromLog(log));
  }

  for (const event of observation.events.records) {
    if (event.traceId !== traceId) continue;
    items.push(timelineFromEvent(event));
  }

  const db = observation.db.records[0];
  if (db && sessions.size > 0) {
    for (const message of db.messages) {
      if (sessions.has(message.sessionId)) {
        items.push(timelineFromDbMessage(message));
      }
    }
    for (const part of db.parts) {
      if (sessions.has(part.sessionId)) {
        items.push(timelineFromDbPart(part));
      }
    }
  }

  return items.sort((left, right) => compareIsoDesc(left.at, right.at));
}

function timelineFromLog(log: LogRecord): TimelineItem {
  const label = log.event ?? log.message ?? "log";
  return {
    id: `log:${log.sourcePath}:${log.line}`,
    at: log.timestamp,
    source: "log",
    kind: log.event ?? "log",
    label,
    severity: normalizeLogLevel(log.level),
    traceId: log.traceId,
    sessionId: log.sessionId,
    turnId: log.turnId,
    spanId: log.spanId,
    parentSpanId: log.parentSpanId,
    toolCallId: log.toolCallId,
    summary: log.message ?? log.event ?? "结构化日志条目",
    payload: log.context ?? log.error,
  };
}

function timelineFromEvent(event: EventRecord): TimelineItem {
  return {
    id: `event:${event.id}`,
    at: event.timestamp,
    source: "eventlog",
    kind: event.type,
    label: event.type,
    traceId: event.traceId,
    sessionId: event.sessionId,
    turnId: event.turnId,
    spanId: event.spanId,
    parentSpanId: event.parentSpanId,
    toolCallId: eventToolCallId(event.payload),
    summary: summarizeEvent(event),
    payload: event.payload,
  };
}

function timelineFromDbMessage(message: DbMessageRecord): TimelineItem {
  return {
    id: `sqlite:message:${message.id}`,
    at: message.createdAt,
    source: "sqlite",
    kind: "message",
    label: `${formatRole(message.role)}消息`,
    sessionId: message.sessionId,
    summary: summarizeDbMessage(message),
    payload: message.data,
  };
}

function timelineFromDbPart(part: DbPartRecord): TimelineItem {
  return {
    id: `sqlite:part:${part.id}`,
    at: part.createdAt,
    source: "sqlite",
    kind: `part:${part.type ?? "unknown"}`,
    label: `${part.type ?? "未知"} 片段`,
    sessionId: part.sessionId,
    summary: summarizeDbPart(part),
    payload: part.data,
  };
}
