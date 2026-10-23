import type {
  CacheReport,
  ContextSectionSource,
  ContextSnapshotView,
  TokenConfidence,
  TokenMethod,
  TraceSpan,
} from "./shared";
import type { DebugView, SourceInputs } from "./labels";

export function groupSections(snapshot?: ContextSnapshotView) {
  const groups = new Map<ContextSectionSource, number>();
  for (const section of snapshot?.sections ?? []) {
    groups.set(section.source, (groups.get(section.source) ?? 0) + section.tokens);
  }
  const total = [...groups.values()].reduce((sum, value) => sum + value, 0);
  return [...groups.entries()].map(([source, tokens]) => ({
    source,
    tokens,
    percent: total > 0 ? tokens / total : 0,
  }));
}

export function buildQuery(inputs: SourceInputs): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(inputs)) {
    if (value.trim()) params.set(key, value.trim());
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

export function stringifyPayload(payload: unknown): string {
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload, null, 2) ?? String(payload);
  } catch {
    return String(payload);
  }
}

export function parseMessageEvent<T>(event: Event): T | null {
  const data = (event as MessageEvent<string>).data;
  if (typeof data !== "string") return null;
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

export function escapeTimelineContent(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function viewFromHash(hash: string): DebugView {
  const normalized = hash.replace(/^#/, "");
  if (normalized === "gantt") return normalized;
  return "gantt";
}

export function formatSpanStatus(value: TraceSpan["status"]): string {
  switch (value) {
    case "running":
      return "进行中";
    case "ok":
      return "完成";
    case "error":
      return "错误";
    case "cancelled":
      return "已取消";
    case "unknown":
      return "未知";
  }
}

export function formatSpanDuration(span: TraceSpan): string {
  if (!span.endAt) return span.status === "running" ? "进行中" : "未结束";
  const start = new Date(span.startAt).getTime();
  const end = new Date(span.endAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return "未知耗时";
  return formatDuration(end - start);
}

export function formatObservationLevel(value: ContextSnapshotView["observationLevel"]): string {
  switch (value) {
    case "full":
      return "完整";
    case "metadata":
      return "元数据";
    case "inferred":
      return "推断";
  }
}

export function formatTokenMethod(value?: TokenMethod): string {
  switch (value) {
    case "provider_count":
      return "模型计数";
    case "provider_usage":
      return "模型用量";
    case "proportional_estimate":
      return "按比例估算";
    case "estimated":
      return "本地估算";
    default:
      return "未知来源";
  }
}

export function formatConfidence(value?: TokenConfidence): string {
  switch (value) {
    case "high":
      return "可信度高";
    case "medium":
      return "可信度中";
    case "low":
      return "可信度低";
    default:
      return "可信度未知";
  }
}

export function formatCacheStatus(value: CacheReport["segments"][number]["status"]): string {
  switch (value) {
    case "hit":
      return "命中";
    case "miss":
      return "未命中";
    case "unknown":
      return "未知";
  }
}

export function formatSegmentLabel(value?: string): string {
  switch (value) {
    case "system_prompt":
      return "系统";
    case "skills":
      return "技能";
    case "tools":
      return "工具";
    case "other":
      return "其他";
    case "message":
      return "消息";
    case "system":
      return "system 消息";
    case "user":
      return "user 消息";
    case "assistant":
      return "assistant 消息";
    case "tool":
      return "tool 消息";
    default:
      return value ?? "片段";
  }
}

function formatDuration(value?: number): string {
  if (value === undefined) return "-- ms";
  if (value < 1000) return `${value} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

export function formatTime(value?: string): string {
  if (!value) return "--:--:--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function compareDateAsc(left?: string, right?: string): number {
  return new Date(left ?? 0).getTime() - new Date(right ?? 0).getTime();
}
