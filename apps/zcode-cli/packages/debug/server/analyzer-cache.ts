import type { CacheReport, CacheSegment } from "../src/shared.js";
import { isRecord, numberValue, stringValue } from "./sources.js";
import { arrayValue } from "./analyzer-values.js";
import type { DbObservation, EventRecord, LoadedObservation } from "./types.js";
import {
  compareIsoAsc,
  estimateTokens,
  extractUsage,
  modelName,
  preview,
} from "./analyzer-values.js";

export function buildCacheReports(
  traceId: string,
  sessions: Set<string>,
  observation: LoadedObservation,
): CacheReport[] {
  const reports: CacheReport[] = [];
  const traceEvents = observation.events.records
    .filter((event) => event.traceId === traceId)
    .sort((left, right) => compareIsoAsc(left.timestamp, right.timestamp));
  const modelRequests = traceEvents.filter((event) => event.type === "model_request");

  for (const request of modelRequests) {
    const complete = findNextEvent(traceEvents, request, "model_complete");
    const turnComplete = findNextEvent(traceEvents, request, "turn_complete");
    const usage = extractUsage(complete?.payload);
    const cacheStats = isRecord(turnComplete?.payload?.cacheStats)
      ? turnComplete?.payload?.cacheStats
      : undefined;
    const messages = arrayValue(request.payload?.messages).filter(isRecord);
    reports.push({
      id: `cache:${request.id}`,
      at: complete?.timestamp ?? request.timestamp,
      traceId,
      sessionId: request.sessionId,
      turnId: request.turnId,
      model: modelName(request.payload),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      hitRate: usage.inputTokens > 0 ? usage.cacheReadTokens / usage.inputTokens : null,
      segments: cacheSegmentsFromMessages(messages, cacheStats, usage.cacheReadTokens),
      limitations: cacheLimitations(messages, cacheStats, usage.cacheReadTokens),
    });
  }

  if (reports.length === 0) {
    reports.push(...cacheReportsFromDb(traceId, sessions, observation.db.records[0]));
  }

  return reports;
}

function findNextEvent(
  events: EventRecord[],
  current: EventRecord,
  type: string,
): EventRecord | undefined {
  const currentAt = current.timestamp ?? "";
  return events.find((event) => {
    if (event.type !== type) return false;
    if (current.turnId && event.turnId !== current.turnId) return false;
    return !currentAt || !event.timestamp || event.timestamp >= currentAt;
  });
}

function cacheSegmentsFromMessages(
  messages: Record<string, unknown>[],
  cacheStats: Record<string, unknown> | undefined,
  cacheReadTokens: number,
): CacheSegment[] {
  const cachedMessages = numberValue(cacheStats?.cachedMessages);
  const lastCacheHit = cacheStats?.lastCacheHit === true;

  return messages.map((message, index) => {
    const content = String(message.content ?? "");
    const hasPrefixStats = lastCacheHit && cachedMessages !== undefined;
    const status = hasPrefixStats ? (index < cachedMessages ? "hit" : "miss") : "unknown";
    return {
      id: `message-${index}`,
      status,
      role: stringValue(message.role),
      source: "message",
      tokens: estimateTokens(content),
      chars: content.length,
      preview: preview(content),
      reason: hasPrefixStats
        ? "根据 runtime 的 cachedMessages 前缀统计推断。"
        : cacheReadTokens > 0
          ? "Provider 返回了缓存 token，但没有逐文本归因。"
          : "这条消息没有缓存归因信息。",
    };
  });
}

function cacheLimitations(
  messages: Record<string, unknown>[],
  cacheStats: Record<string, unknown> | undefined,
  cacheReadTokens: number,
): string[] {
  const limitations: string[] = [];
  if (messages.length === 0) {
    limitations.push("当前观测源没有 provider 可见的 messages。");
  }
  if (!cacheStats) {
    limitations.push("缺少 turn_complete.cacheStats，无法判断逐文本命中状态。");
  }
  if (cacheReadTokens > 0) {
    limitations.push("Provider 的缓存 token 不会标出具体命中文本。");
  }
  return limitations;
}

function cacheReportsFromDb(
  traceId: string,
  sessions: Set<string>,
  db?: DbObservation,
): CacheReport[] {
  if (!db || sessions.size === 0) return [];
  const reports: CacheReport[] = [];

  for (const part of db.parts) {
    if (!sessions.has(part.sessionId) || part.type !== "step-finish") continue;
    const tokens = isRecord(part.data.tokens) ? part.data.tokens : undefined;
    if (!tokens) continue;
    const cache = isRecord(tokens?.cache) ? tokens.cache : undefined;
    const read = numberValue(cache?.read) ?? 0;
    const write = numberValue(cache?.write) ?? 0;
    const inputTokens = numberValue(tokens?.input) ?? 0;
    reports.push({
      id: `sqlite-cache:${part.id}`,
      at: part.createdAt,
      traceId,
      sessionId: part.sessionId,
      inputTokens,
      outputTokens: numberValue(tokens?.output) ?? 0,
      totalTokens: numberValue(tokens?.total) ?? 0,
      cacheReadTokens: read,
      cacheWriteTokens: write,
      hitRate: inputTokens > 0 ? read / inputTokens : null,
      segments: [],
      limitations:
        read > 0 || write > 0
          ? ["SQLite 里有聚合缓存 token，但没有逐文本 cache report。"]
          : ["SQLite 里有 token usage，未观察到 cache read/write。"],
    });
  }

  return reports;
}
