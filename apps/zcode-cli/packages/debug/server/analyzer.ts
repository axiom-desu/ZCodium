import type { SourceStatus, TraceDetailResponse, TraceListResponse } from "../src/shared.js";
import { loadEventLog, loadLogs, loadSqlite } from "./sources.js";
import type { LoadedObservation, ObservationOptions, SourceLoadResult } from "./types.js";
import {
  buildProjectSummaries,
  buildTraceSummaries,
  collectSessionsForTrace,
} from "./analyzer-trace-summary.js";
import { buildTimeline } from "./analyzer-timeline.js";
import { buildTraceSpans } from "./analyzer-spans.js";
import { buildContextSnapshots } from "./analyzer-context.js";
import { buildContextUsageSnapshots } from "./analyzer-usage.js";
import { buildCacheReports } from "./analyzer-cache.js";
import { buildDeveloperRequests } from "./analyzer-requests.js";

const DEFAULT_TRACE_LIMIT = 10;

export async function listTraces(options: ObservationOptions = {}): Promise<TraceListResponse> {
  const observation = await loadObservation(options);
  return {
    sources: sourceStatuses(observation),
    projects: buildProjectSummaries(observation.db.records[0]),
    traces: buildTraceSummaries(
      observation,
      options.limit ?? DEFAULT_TRACE_LIMIT,
      options.projectId,
    ),
  };
}

export async function inspectTrace(
  traceId: string,
  options: ObservationOptions = {},
): Promise<TraceDetailResponse> {
  const observation = await loadObservation({ ...options, traceId });
  const sessions = collectSessionsForTrace(traceId, observation, options.sessionId);
  const timeline = buildTimeline(traceId, sessions, observation);
  const spans = buildTraceSpans(traceId, sessions, observation);
  const contextSnapshots = buildContextSnapshots(traceId, observation);
  const contextUsageSnapshots = buildContextUsageSnapshots(traceId, sessions, observation);
  const cacheReports = buildCacheReports(traceId, sessions, observation);

  return {
    traceId,
    sessions: [...sessions].sort(),
    sources: sourceStatuses(observation),
    timeline,
    spans,
    contextSnapshots,
    contextUsageSnapshots,
    cacheReports,
    developerRequests: buildDeveloperRequests(observation, contextSnapshots, cacheReports),
  };
}

async function loadObservation(options: ObservationOptions): Promise<LoadedObservation> {
  const [logs, events] = await Promise.all([loadLogs(options), loadEventLog(options)]);
  return {
    logs,
    events,
    db: loadSqlite(options),
  };
}

function sourceStatuses(observation: LoadedObservation): SourceStatus[] {
  return [
    toSourceStatus(observation.logs),
    toSourceStatus(observation.events),
    toSourceStatus(observation.db),
  ];
}

function toSourceStatus<TRecord>(source: SourceLoadResult<TRecord>): SourceStatus {
  return {
    kind: source.kind,
    label: source.label,
    path: source.path,
    available: source.records.length > 0,
    recordCount: source.records.length,
    warning: source.warning,
  };
}
