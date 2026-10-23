import { BarChart3, Maximize2, Minimize2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Timeline as VisTimeline } from "vis-timeline/standalone";
import type { TraceSpan } from "./shared";
import { laneLabels } from "./labels";
import { compareDateAsc, formatSpanDuration, formatSpanStatus, formatTime } from "./format";
import { buildGanttGroups, buildGanttItems, ganttOptions } from "./gantt";
import { EmptyLine, MetaLine, Metric, PanelTitle, TimelinePayload } from "./panels";

export function ExecutionGanttPanel({ spans, traceId }: { spans: TraceSpan[]; traceId: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const timelineRef = useRef<VisTimeline | null>(null);
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const visibleSpans = useMemo(
    () => spans.toSorted((left, right) => compareDateAsc(left.startAt, right.startAt)),
    [spans],
  );
  const groups = useMemo(() => buildGanttGroups(visibleSpans), [visibleSpans]);
  const items = useMemo(() => buildGanttItems(visibleSpans), [visibleSpans]);
  const selectedSpan =
    visibleSpans.find((span) => span.id === selectedSpanId) ?? visibleSpans[0] ?? null;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const timeline = new VisTimeline(container, [], [], ganttOptions(false));
    timelineRef.current = timeline;
    const handleSelect = (properties?: { items?: Array<string | number> }) => {
      const id = properties?.items?.[0];
      setSelectedSpanId(id === undefined ? null : String(id));
    };
    timeline.on("select", handleSelect);
    return () => {
      timeline.off("select", handleSelect);
      timeline.destroy();
      timelineRef.current = null;
    };
  }, []);

  useEffect(() => {
    timelineRef.current?.setData({ groups, items });
    if (items.length > 0) {
      timelineRef.current?.fit();
    }
  }, [groups, items]);

  useEffect(() => {
    if (selectedSpanId && visibleSpans.some((span) => span.id === selectedSpanId)) return;
    setSelectedSpanId(visibleSpans[0]?.id ?? null);
  }, [selectedSpanId, visibleSpans]);

  useEffect(() => {
    if (!isFullscreen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsFullscreen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isFullscreen]);

  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) return;
    timeline.setOptions(ganttOptions(isFullscreen));
    const refit = () => {
      timeline.redraw();
      if (items.length > 0) timeline.fit();
    };
    let firstFrame = 0;
    let secondFrame = 0;
    firstFrame = window.requestAnimationFrame(() => {
      timeline.redraw();
      secondFrame = window.requestAnimationFrame(refit);
    });
    window.addEventListener("resize", refit);
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
      window.removeEventListener("resize", refit);
    };
  }, [isFullscreen, items.length]);

  return (
    <section className={isFullscreen ? "panel gantt-panel fullscreen" : "panel gantt-panel"}>
      <div className="gantt-toolbar">
        <PanelTitle icon={<BarChart3 size={17} />} title="执行甘特图" />
        <div className="gantt-toolbar-actions">
          <button
            className="icon-button"
            onClick={() => setIsFullscreen((current) => !current)}
            title={isFullscreen ? "退出窗口内全屏" : "窗口内全屏"}
            type="button"
          >
            {isFullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
          </button>
          <button
            className="secondary-button"
            disabled={items.length === 0}
            onClick={() => timelineRef.current?.fit()}
            type="button"
          >
            适配视图
          </button>
        </div>
      </div>
      <div className="gantt-summary">
        <Metric label="Trace" value={traceId || "未选择"} />
        <Metric label="执行段" value={String(visibleSpans.length)} />
        <Metric
          label="网络段"
          value={String(visibleSpans.filter((span) => span.lane === "network").length)}
        />
      </div>
      <div className="gantt-shell">
        <div className="gantt-canvas" ref={containerRef} />
        {visibleSpans.length === 0 ? (
          <div className="gantt-empty">
            <EmptyLine text="没有可渲染的执行段。需要 turn/tool/model start/end 事件或网络归因。" />
          </div>
        ) : null}
      </div>
      {selectedSpan ? <SpanDetail span={selectedSpan} /> : null}
    </section>
  );
}

function SpanDetail({ span }: { span: TraceSpan }) {
  return (
    <aside className="gantt-detail" aria-label="执行段详情">
      <div className="gantt-detail-heading">
        <strong>{span.label}</strong>
        <span className={`request-status status-${span.status}`}>
          {formatSpanStatus(span.status)}
        </span>
      </div>
      <MetaLine
        values={[
          laneLabels[span.lane],
          span.source,
          formatTime(span.startAt),
          formatSpanDuration(span),
          span.traceId ? `trace ${span.traceId}` : "",
          span.sessionId ? `session ${span.sessionId}` : "",
          span.turnId ? `turn ${span.turnId}` : "",
          span.toolCallId ? `tool ${span.toolCallId}` : "",
        ]}
      />
      {span.summary ? <p>{span.summary}</p> : null}
      {span.payload !== undefined ? <TimelinePayload payload={span.payload} /> : null}
    </aside>
  );
}
