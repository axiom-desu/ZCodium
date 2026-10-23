import type { CacheReport, ContextSnapshotView, DeveloperRequest } from "../src/shared.js";
import type { LoadedObservation } from "./types.js";

export function buildDeveloperRequests(
  observation: LoadedObservation,
  snapshots: ContextSnapshotView[],
  reports: CacheReport[],
): DeveloperRequest[] {
  const requests: DeveloperRequest[] = [];
  const hasFullSnapshot = snapshots.some((snapshot) => snapshot.observationLevel === "full");
  const hasExactCache = reports.some((report) =>
    report.segments.some(
      (segment) =>
        Boolean(segment.contentHash) && (segment.status === "hit" || segment.status === "miss"),
    ),
  );

  if (!hasFullSnapshot) {
    requests.push({
      title: "在 model request 前产出 context_snapshot",
      eventName: "context_snapshot",
      reason: "当前数据源只能看到上下文元数据，或完全看不到 system prompt 文本。",
      schema: [
        "traceId/sessionId/turnId/modelRequestId",
        "sections[].name/source/chars/tokens/contentHash/preview/artifactRef",
        "messages[].role/chars/tokens/contentHash/sectionRefs",
      ],
    });
  }

  if (!hasExactCache) {
    requests.push({
      title: "产出逐文本 prompt cache report",
      eventName: "prompt_cache_report",
      reason: "Provider usage 只有缓存 token，没有说明哪些文本片段命中缓存。",
      schema: [
        "traceId/sessionId/turnId/modelRequestId",
        "usage.input/output/total/cacheRead/cacheWrite",
        "segments[].messageIndex/role/source/contentHash/tokens/cacheStatus/reason",
      ],
    });
  }

  if (observation.events.records.length === 0) {
    requests.push({
      title: "增加开发期 Session event JSONL sink",
      eventName: "session_event_jsonl_sink",
      reason: "结构化日志更像诊断索引；Session events 才是还原 trace 的事实来源。",
      schema: [
        "append-only JSONL through SessionEventSink",
        "same envelope fields as existing structured log sinks",
        "redacted artifact refs for large payloads",
      ],
    });
  }

  return requests;
}
