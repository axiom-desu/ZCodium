import { basename } from "node:path";
import type { ProjectSummary, TraceSummary } from "../src/shared.js";
import type { DbObservation, DbPartRecord, LoadedObservation } from "./types.js";
import {
  compareIsoAsc,
  compareIsoDesc,
  extractUsage,
  firstUserMessageFromEvent,
  preview,
  textFromDbMessage,
  textFromDbParts,
} from "./analyzer-values.js";

type TraceSummaryDraft = TraceSummary & {
  firstUserMessageAt?: string;
};

export function buildTraceSummaries(
  observation: LoadedObservation,
  limit: number,
  projectId?: string,
): TraceSummary[] {
  const summaries = new Map<string, TraceSummaryDraft>();
  const allowedSessionIds = projectId
    ? sessionIdsForProject(observation.db.records[0], projectId)
    : undefined;

  for (const log of observation.logs.records) {
    if (!log.traceId) continue;
    const summary = ensureTraceSummary(summaries, log.traceId);
    summary.logCount += 1;
    addSession(summary, log.sessionId);
    addTime(summary, log.timestamp);
    summary.lastMessage = log.message ?? log.event ?? summary.lastMessage;
  }

  for (const event of observation.events.records) {
    if (!event.traceId) continue;
    const summary = ensureTraceSummary(summaries, event.traceId);
    summary.eventCount += 1;
    addSession(summary, event.sessionId);
    addTime(summary, event.timestamp);
    summary.lastMessage = event.type;
    recordFirstUserMessage(summary, firstUserMessageFromEvent(event), event.timestamp);
    const usage = extractUsage(event.payload);
    summary.cacheReadTokens += usage.cacheReadTokens;
    summary.cacheWriteTokens += usage.cacheWriteTokens;
  }

  enrichTraceSummariesFromDbMessages(summaries, observation.db.records[0]);

  return [...summaries.values()]
    .filter((summary) => {
      if (!allowedSessionIds) return true;
      return summary.sessionIds.some((sessionId) => allowedSessionIds.has(sessionId));
    })
    .sort((left, right) => compareIsoDesc(left.lastAt, right.lastAt))
    .slice(0, limit)
    .map(toTraceSummary);
}

export function buildProjectSummaries(db?: DbObservation): ProjectSummary[] {
  if (!db) return [];
  const byProject = new Map<string, ProjectSummary>();

  for (const session of db.sessions) {
    const existing = byProject.get(session.projectId);
    if (!existing) {
      byProject.set(session.projectId, {
        projectId: session.projectId,
        label: projectLabel(session.directory),
        directory: session.directory,
        sessionCount: 1,
        updatedAt: session.updatedAt,
      });
      continue;
    }

    existing.sessionCount += 1;
    if (!existing.updatedAt || (session.updatedAt && session.updatedAt > existing.updatedAt)) {
      existing.updatedAt = session.updatedAt;
      existing.directory = session.directory;
      existing.label = projectLabel(session.directory);
    }
  }

  return [...byProject.values()].sort((left, right) =>
    compareIsoDesc(left.updatedAt, right.updatedAt),
  );
}

function sessionIdsForProject(db: DbObservation | undefined, projectId: string): Set<string> {
  const ids = new Set<string>();
  for (const session of db?.sessions ?? []) {
    if (session.projectId === projectId) ids.add(session.id);
  }
  return ids;
}

function projectLabel(directory: string): string {
  return basename(directory) || directory || "未命名项目";
}

function ensureTraceSummary(
  summaries: Map<string, TraceSummaryDraft>,
  traceId: string,
): TraceSummaryDraft {
  const existing = summaries.get(traceId);
  if (existing) return existing;
  const summary: TraceSummary = {
    traceId,
    sessionIds: [],
    eventCount: 0,
    logCount: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  summaries.set(traceId, summary);
  return summary;
}

function enrichTraceSummariesFromDbMessages(
  summaries: Map<string, TraceSummaryDraft>,
  db?: DbObservation,
): void {
  if (!db || summaries.size === 0) return;
  const bySessionId = new Map<string, TraceSummaryDraft[]>();
  const partsByMessageId = groupPartsByMessageId(db.parts);
  for (const summary of summaries.values()) {
    for (const sessionId of summary.sessionIds) {
      const existing = bySessionId.get(sessionId);
      if (existing) {
        existing.push(summary);
      } else {
        bySessionId.set(sessionId, [summary]);
      }
    }
  }

  for (const message of db.messages) {
    if (message.role !== "user") continue;
    const matchedSummaries = bySessionId.get(message.sessionId);
    if (!matchedSummaries) continue;
    const text = textFromDbMessage(message) ?? textFromDbParts(partsByMessageId.get(message.id));
    for (const summary of matchedSummaries) {
      recordFirstUserMessage(summary, text, message.createdAt);
    }
  }
}

function groupPartsByMessageId(parts: DbPartRecord[]): Map<string, DbPartRecord[]> {
  const byMessageId = new Map<string, DbPartRecord[]>();
  for (const part of parts) {
    const existing = byMessageId.get(part.messageId);
    if (existing) {
      existing.push(part);
    } else {
      byMessageId.set(part.messageId, [part]);
    }
  }
  return byMessageId;
}

function recordFirstUserMessage(
  summary: TraceSummaryDraft,
  text: string | undefined,
  at?: string,
): void {
  const normalized = text ? preview(text, 120) : undefined;
  if (!normalized) return;
  if (summary.firstUserMessageAt) {
    if (!at || compareIsoAsc(summary.firstUserMessageAt, at) <= 0) return;
  } else if (summary.firstUserMessage && !at) {
    return;
  }

  summary.firstUserMessage = normalized;
  summary.firstUserMessageAt = at;
}

function toTraceSummary(summary: TraceSummaryDraft): TraceSummary {
  return {
    traceId: summary.traceId,
    sessionIds: summary.sessionIds,
    eventCount: summary.eventCount,
    logCount: summary.logCount,
    firstAt: summary.firstAt,
    lastAt: summary.lastAt,
    firstUserMessage: summary.firstUserMessage,
    lastMessage: summary.lastMessage,
    cacheReadTokens: summary.cacheReadTokens,
    cacheWriteTokens: summary.cacheWriteTokens,
  };
}

function addSession(summary: TraceSummary, sessionId?: string): void {
  if (sessionId && !summary.sessionIds.includes(sessionId)) {
    summary.sessionIds.push(sessionId);
  }
}

function addTime(summary: TraceSummary, at?: string): void {
  if (!at) return;
  if (!summary.firstAt || at < summary.firstAt) summary.firstAt = at;
  if (!summary.lastAt || at > summary.lastAt) summary.lastAt = at;
}

export function collectSessionsForTrace(
  traceId: string,
  observation: LoadedObservation,
  explicitSessionId?: string,
): Set<string> {
  const sessions = new Set<string>();
  if (explicitSessionId) sessions.add(explicitSessionId);
  if (traceId.startsWith("session:")) sessions.add(traceId.slice("session:".length));

  for (const log of observation.logs.records) {
    if (log.traceId === traceId && log.sessionId) sessions.add(log.sessionId);
  }
  for (const event of observation.events.records) {
    if (event.traceId === traceId && event.sessionId) sessions.add(event.sessionId);
  }

  return sessions;
}
