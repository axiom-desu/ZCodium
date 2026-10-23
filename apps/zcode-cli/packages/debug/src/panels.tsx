import { AlertTriangle, BarChart3, Clock3, Layers3 } from "lucide-react";
import { useMemo } from "react";
import type { ReactNode } from "react";
import type {
  CacheReport,
  ContextSnapshotView,
  ContextUsageSnapshotView,
  TimelineItem,
  TraceDetailResponse,
} from "./shared";
import { sourceClasses, sourceLabels, usageSourceClasses, usageSourceLabels } from "./labels";
import {
  formatCacheStatus,
  formatConfidence,
  formatObservationLevel,
  formatSegmentLabel,
  formatTime,
  formatTokenMethod,
  groupSections,
  stringifyPayload,
} from "./format";

export function TimelinePanel({ items }: { items: TimelineItem[] }) {
  return (
    <section className="panel timeline-panel">
      <PanelTitle icon={<Clock3 size={17} />} title="时间线" />
      <div className="timeline">
        {items.length === 0 ? <EmptyLine text="选择 Trace 后查看事件" /> : null}
        {items.map((item) => (
          <article className={`timeline-item severity-${item.severity ?? "info"}`} key={item.id}>
            <time>{formatTime(item.at)}</time>
            <div>
              <div className="timeline-heading">
                <strong>{item.label}</strong>
                <span>{item.source}</span>
              </div>
              <p className="timeline-summary">{item.summary}</p>
              {item.payload !== undefined ? <TimelinePayload payload={item.payload} /> : null}
              <MetaLine
                values={[
                  item.sessionId ? `会话 ${item.sessionId}` : "",
                  item.turnId ? `轮次 ${item.turnId}` : "",
                  item.toolCallId ? `工具 ${item.toolCallId}` : "",
                ]}
              />
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

export function TimelinePayload({ payload }: { payload: unknown }) {
  return (
    <details className="timeline-payload">
      <summary>原始 Payload</summary>
      <pre>{stringifyPayload(payload)}</pre>
    </details>
  );
}

export function ContextPanel({
  snapshots,
  usageSnapshots,
}: {
  snapshots: ContextSnapshotView[];
  usageSnapshots: ContextUsageSnapshotView[];
}) {
  const snapshot = useMemo(
    () => snapshots.findLast((item) => item.observationLevel === "full") ?? snapshots.at(-1),
    [snapshots],
  );
  const usageSnapshot = usageSnapshots.at(-1);
  const grouped = useMemo(() => groupSections(snapshot), [snapshot]);

  return (
    <section className="panel context-panel">
      <PanelTitle icon={<Layers3 size={17} />} title="上下文" />
      {!snapshot && !usageSnapshot ? <EmptyLine text="未观察到上下文快照" /> : null}
      {usageSnapshot ? (
        <div className="usage-snapshot">
          <div className="usage-heading">
            <strong>占用快照</strong>
            <span>
              {formatTokenMethod(usageSnapshot.tokenMethod)} ·{" "}
              {formatConfidence(usageSnapshot.confidence)}
            </span>
          </div>
          <div className="metric-row">
            <Metric label="估算 Token" value={usageSnapshot.totalTokens.toLocaleString()} />
            <Metric label="字符" value={usageSnapshot.totalChars.toLocaleString()} />
            <Metric label="算法" value={usageSnapshot.tokenizer ?? "未知"} />
          </div>
          <div className="stack-bar" aria-label="上下文占用 token 分类">
            {usageSnapshot.categories.map((category) => (
              <span
                className={usageSourceClasses[category.source]}
                key={category.id}
                style={{ width: `${Math.max(category.percentTokens * 100, 2)}%` }}
                title={`${usageSourceLabels[category.source]} ${Math.round(category.percentTokens * 100)}%`}
              />
            ))}
          </div>
          <div className="usage-list">
            {usageSnapshot.categories.map((category) => (
              <div className="usage-row" key={category.id}>
                <span className={`dot ${usageSourceClasses[category.source]}`} />
                <strong>{usageSourceLabels[category.source]}</strong>
                <small>
                  {category.tokens.toLocaleString()} Token ·{" "}
                  {Math.round(category.percentTokens * 100)}% ·{" "}
                  {formatTokenMethod(category.tokenMethod)}
                </small>
              </div>
            ))}
          </div>
          {usageSnapshot.mcpTools.length > 0 ? (
            <details className="usage-details">
              <summary>MCP 工具明细</summary>
              <div className="usage-list">
                {usageSnapshot.mcpTools.map((tool) => (
                  <div className="usage-row" key={tool.name}>
                    <span className="dot tone-mcp" />
                    <strong>{tool.name}</strong>
                    <small>
                      {tool.serverName ?? "unknown"} · {tool.tokens.toLocaleString()} Token ·{" "}
                      {formatTokenMethod(tool.tokenMethod)}
                    </small>
                  </div>
                ))}
              </div>
            </details>
          ) : null}
          {usageSnapshot.skills.length > 0 ? (
            <details className="usage-details">
              <summary>技能明细</summary>
              <div className="usage-list">
                {usageSnapshot.skills.map((skill) => (
                  <div className="usage-row" key={`${skill.source ?? "skill"}:${skill.name}`}>
                    <span className="dot tone-skills" />
                    <strong>{skill.name}</strong>
                    <small>
                      {skill.source ?? "unknown"} · {skill.tokens.toLocaleString()} Token ·{" "}
                      {formatTokenMethod(skill.tokenMethod)}
                    </small>
                  </div>
                ))}
              </div>
            </details>
          ) : null}
          {usageSnapshot.warnings.map((warning) => (
            <p className="soft-warning" key={warning}>
              {warning}
            </p>
          ))}
        </div>
      ) : null}
      {snapshot ? (
        <>
          <div className="usage-heading">
            <strong>文本快照</strong>
            <span>{formatObservationLevel(snapshot.observationLevel)}</span>
          </div>
          <div className="metric-row">
            <Metric label="Token" value={snapshot.totalTokens.toLocaleString()} />
            <Metric label="字符" value={snapshot.totalChars.toLocaleString()} />
            <Metric label="观测" value={formatObservationLevel(snapshot.observationLevel)} />
          </div>
          <div className="stack-bar" aria-label="上下文 token 占比">
            {grouped.map((group) => (
              <span
                className={sourceClasses[group.source]}
                key={group.source}
                style={{ width: `${Math.max(group.percent * 100, 2)}%` }}
                title={`${sourceLabels[group.source]} ${Math.round(group.percent * 100)}%`}
              />
            ))}
          </div>
          <div className="section-list">
            {snapshot.sections.map((section) => (
              <details key={section.id}>
                <summary>
                  <span className={`dot ${sourceClasses[section.source]}`} />
                  <strong>{section.name}</strong>
                  <small>
                    {sourceLabels[section.source]} · {section.tokens.toLocaleString()} Token ·{" "}
                    {Math.round(section.percentTokens * 100)}%
                  </small>
                </summary>
                <pre>{section.content ?? section.preview ?? "只有元数据"}</pre>
              </details>
            ))}
          </div>
          {snapshot.warnings.map((warning) => (
            <p className="soft-warning" key={warning}>
              {warning}
            </p>
          ))}
        </>
      ) : null}
    </section>
  );
}

export function CachePanel({ reports }: { reports: CacheReport[] }) {
  const report = reports.at(-1);
  const segments = report?.segments.filter(isRenderableCacheSegment) ?? [];

  return (
    <section className="panel cache-panel">
      <PanelTitle icon={<BarChart3 size={17} />} title="缓存" />
      {!report ? <EmptyLine text="未观察到缓存使用" /> : null}
      {report ? (
        <>
          <div className="metric-row">
            <Metric label="读取" value={report.cacheReadTokens.toLocaleString()} />
            <Metric label="写入" value={report.cacheWriteTokens.toLocaleString()} />
            <Metric
              label="命中"
              value={report.hitRate === null ? "未知" : `${Math.round(report.hitRate * 100)}%`}
            />
          </div>
          {segments.length > 0 ? (
            <div className="cache-segments">
              {segments.map((segment) => (
                <article className={`cache-segment ${segment.status}`} key={segment.id}>
                  <strong>{formatCacheStatus(segment.status)}</strong>
                  <span>{formatSegmentLabel(segment.role ?? segment.source)}</span>
                  <p>{segment.preview}</p>
                  {segment.reason ? <small>{segment.reason}</small> : null}
                </article>
              ))}
            </div>
          ) : null}
          {report.limitations.map((limitation) => (
            <p className="soft-warning" key={limitation}>
              {limitation}
            </p>
          ))}
        </>
      ) : null}
    </section>
  );
}

function isRenderableCacheSegment(segment: CacheReport["segments"][number]): boolean {
  return segment.preview !== "SQLite 的 step-finish token usage 不包含 provider 可见文本。";
}

export function GapsPanel({ requests }: { requests: TraceDetailResponse["developerRequests"] }) {
  return (
    <section className="panel gaps-panel">
      <PanelTitle icon={<AlertTriangle size={17} />} title="观测缺口" />
      {requests.length === 0 ? <EmptyLine text="当前 trace 没有观测缺口" /> : null}
      {requests.map((request) => (
        <article className="request-row" key={request.eventName}>
          <strong>{request.title}</strong>
          <p>{request.reason}</p>
          <code>{request.eventName}</code>
        </article>
      ))}
    </section>
  );
}

export function PanelTitle({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="panel-title">
      {icon}
      <h2>{title}</h2>
    </div>
  );
}

export function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function EmptyLine({ text }: { text: string }) {
  return <p className="empty-line">{text}</p>;
}

export function MetaLine({ values }: { values: string[] }) {
  const cleanValues = values.filter(Boolean);
  if (cleanValues.length === 0) return null;
  return <small className="meta-line">{cleanValues.join(" · ")}</small>;
}
