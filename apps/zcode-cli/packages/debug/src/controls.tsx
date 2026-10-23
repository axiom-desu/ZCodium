import { Database, FileJson, Radio } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  ObservationChangeEvent,
  ObservationHelloEvent,
  ObservationSourceErrorEvent,
  ProjectSummary,
  SourceStatus,
  TraceSummary,
} from "./shared";
import type { DebugView, ObservationEventState } from "./labels";
import { viewLabels } from "./labels";
import { formatTime, parseMessageEvent } from "./format";

export function ViewTabs(props: { activeView: DebugView; onChange: (view: DebugView) => void }) {
  return (
    <nav className="view-tabs" aria-label="调试视图">
      {(Object.keys(viewLabels) as DebugView[]).map((view) => (
        <button
          aria-current={props.activeView === view ? "page" : undefined}
          className={props.activeView === view ? "active" : ""}
          key={view}
          onClick={() => props.onChange(view)}
          type="button"
        >
          {viewLabels[view]}
        </button>
      ))}
    </nav>
  );
}

export function ProjectSelect(props: {
  projects: ProjectSummary[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      <span>项目</span>
      <select value={props.value} onChange={(event) => props.onChange(event.target.value)}>
        <option value="">全部项目</option>
        {props.projects.map((project) => (
          <option key={project.projectId} value={project.projectId}>
            {project.label}（{project.sessionCount}）
          </option>
        ))}
      </select>
    </label>
  );
}

export function TraceSelect(props: {
  traces: TraceSummary[];
  value: string;
  onChange: (traceId: string) => void;
}) {
  return (
    <label>
      <span>Trace</span>
      <select value={props.value} onChange={(event) => props.onChange(event.target.value)}>
        <option value="">选择 Trace</option>
        {props.traces.map((trace) => (
          <option key={trace.traceId} value={trace.traceId}>
            {trace.traceId} - {trace.firstUserMessage ?? "没有观察到用户消息"}
          </option>
        ))}
      </select>
    </label>
  );
}

export function SourceBar({
  sources,
  loading,
  live,
}: {
  sources: SourceStatus[];
  loading: boolean;
  live: ObservationEventState;
}) {
  const showLoading = useDelayedVisible(loading, 180);
  return (
    <section className="source-bar" aria-label="观测数据源">
      <div className={`source-pill live ${live.connected ? "ready" : "muted"}`}>
        <Radio size={16} />
        <div>
          <strong>{live.connected ? "实时推送" : "实时重连"}</strong>
          <span>
            {live.lastChangeAt
              ? `最近更新 ${formatTime(live.lastChangeAt)}`
              : `${live.watchedPathCount} 个路径`}
          </span>
        </div>
        {live.error ? <small>{live.error}</small> : <small>SSE</small>}
      </div>
      {sources.map((source) => (
        <div className={`source-pill ${source.available ? "ready" : "muted"}`} key={source.kind}>
          {source.kind === "sqlite" ? <Database size={16} /> : <FileJson size={16} />}
          <div>
            <strong>{source.label}</strong>
            <span>{source.recordCount} 条记录</span>
          </div>
          {source.warning ? <small>{source.warning}</small> : null}
        </div>
      ))}
      <div className={`loading-dot ${showLoading ? "visible" : ""}`} aria-hidden={!showLoading}>
        加载中
      </div>
    </section>
  );
}

export function useObservationEvents(query: string, onChange: () => void): ObservationEventState {
  const onChangeRef = useRef(onChange);
  const [state, setState] = useState<ObservationEventState>({
    connected: false,
    error: null,
    watchedPathCount: 0,
  });

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    let closed = false;
    let refreshTimer: number | undefined;
    const events = new EventSource(`/api/observations/events${query}`);

    const scheduleRefresh = () => {
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        if (!closed) onChangeRef.current();
      }, 180);
    };

    events.addEventListener("hello", (event) => {
      const parsed = parseMessageEvent<ObservationHelloEvent>(event);
      if (!parsed || closed) return;
      setState({
        connected: true,
        error: null,
        watchedPathCount: parsed.sources.length,
      });
    });
    events.addEventListener("change", (event) => {
      const parsed = parseMessageEvent<ObservationChangeEvent>(event);
      if (!parsed || closed) return;
      setState({
        connected: true,
        error: null,
        lastChangeAt: parsed.changedAt,
        watchedPathCount: parsed.sources.length,
      });
      scheduleRefresh();
    });
    events.addEventListener("source-error", (event) => {
      const parsed = parseMessageEvent<ObservationSourceErrorEvent>(event);
      if (!parsed || closed) return;
      setState((current) => ({
        ...current,
        connected: true,
        error: parsed.message,
      }));
    });
    events.addEventListener("open", () => {
      if (!closed) {
        setState((current) => ({ ...current, connected: true, error: null }));
      }
    });
    events.addEventListener("error", () => {
      if (!closed) {
        setState((current) => ({
          ...current,
          connected: false,
          error: "观测事件流已断开，正在等待浏览器重连。",
        }));
      }
    });

    return () => {
      closed = true;
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      events.close();
    };
  }, [query]);

  return state;
}

function useDelayedVisible(visible: boolean, delayMs: number): boolean {
  const [delayedVisible, setDelayedVisible] = useState(false);

  useEffect(() => {
    if (!visible) {
      setDelayedVisible(false);
      return;
    }

    const timer = window.setTimeout(() => setDelayedVisible(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, visible]);

  return delayedVisible;
}
