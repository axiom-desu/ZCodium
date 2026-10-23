import { AlertTriangle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ProjectSummary,
  SourceStatus,
  TraceDetailResponse,
  TraceListResponse,
  TraceSummary,
} from "./shared";
import { emptyInputs, lastProjectStorageKey } from "./labels";
import type { DebugView, SourceInputs } from "./labels";
import { buildQuery, fetchJson, viewFromHash } from "./format";
import { ProjectSelect, SourceBar, TraceSelect, ViewTabs, useObservationEvents } from "./controls";
import { CachePanel, ContextPanel, GapsPanel, TimelinePanel } from "./panels";
import { ExecutionGanttPanel } from "./gantt-panel";

export function App() {
  const [inputs, setInputs] = useState<SourceInputs>(emptyInputs);
  const [traceId, setTraceId] = useState("");
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [sources, setSources] = useState<SourceStatus[]>([]);
  const [detail, setDetail] = useState<TraceDetailResponse | null>(null);
  const [view, setView] = useState<DebugView>(() => viewFromHash(window.location.hash));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const query = useMemo(() => buildQuery(inputs), [inputs]);
  const spans = detail?.spans ?? [];
  const setDebugView = useCallback((nextView: DebugView) => {
    setView(nextView);
    window.history.replaceState(null, "", `#${nextView}`);
  }, []);
  const selectTrace = useCallback((nextTraceId: string) => {
    setTraceId(nextTraceId);
  }, []);

  const loadTraces = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchJson<TraceListResponse>(`/api/traces${query}`);
      setTraces(response.traces);
      setProjects(response.projects);
      setSources(response.sources);

      if (!inputs.projectId && response.projects.length > 0) {
        const lastProjectId = window.localStorage.getItem(lastProjectStorageKey);
        const nextProjectId =
          response.projects.find((project) => project.projectId === lastProjectId)?.projectId ??
          response.projects[0]?.projectId;
        if (nextProjectId) {
          setInputs((current) => ({ ...current, projectId: nextProjectId }));
        }
      }

      const hasCurrentTrace = response.traces.some((trace) => trace.traceId === traceId);
      if (!hasCurrentTrace) {
        setTraceId(response.traces[0]?.traceId ?? "");
      }
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
    } finally {
      setLoading(false);
    }
  }, [inputs.projectId, query, traceId]);

  const loadTraceDetail = useCallback(async () => {
    if (!traceId.trim()) {
      setDetail(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const encoded = encodeURIComponent(traceId.trim());
      const response = await fetchJson<TraceDetailResponse>(`/api/traces/${encoded}${query}`);
      setDetail(response);
      setSources(response.sources);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
    } finally {
      setLoading(false);
    }
  }, [query, traceId]);

  const refreshObservations = useCallback(() => {
    void loadTraces();
    void loadTraceDetail();
  }, [loadTraceDetail, loadTraces]);
  const observationEvents = useObservationEvents(query, refreshObservations);

  useEffect(() => {
    void loadTraces();
  }, [loadTraces]);

  useEffect(() => {
    void loadTraceDetail();
  }, [loadTraceDetail]);

  useEffect(() => {
    if (inputs.projectId) {
      window.localStorage.setItem(lastProjectStorageKey, inputs.projectId);
    }
  }, [inputs.projectId]);

  useEffect(() => {
    const syncViewFromHash = () => setView(viewFromHash(window.location.hash));
    window.addEventListener("hashchange", syncViewFromHash);
    return () => window.removeEventListener("hashchange", syncViewFromHash);
  }, []);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>ZCode 调试台</h1>
          <p>Trace、甘特执行、网络抓包</p>
        </div>
        <div className="topbar-actions">
          <ViewTabs activeView={view} onChange={setDebugView} />
          <button
            className="icon-button"
            type="button"
            onClick={() => void loadTraces()}
            title="刷新"
          >
            <RefreshCw size={18} />
          </button>
        </div>
      </header>

      <section className="control-strip" aria-label="调试控制">
        <ProjectSelect
          projects={projects}
          value={inputs.projectId}
          onChange={(value) => {
            setInputs((current) => ({ ...current, projectId: value }));
            setTraceId("");
          }}
        />
        <TraceSelect traces={traces} value={traceId} onChange={selectTrace} />
      </section>

      {error ? (
        <div className="notice error">
          <AlertTriangle size={16} />
          <span>{error}</span>
        </div>
      ) : null}

      <SourceBar sources={sources} loading={loading} live={observationEvents} />

      {view === "trace" ? (
        <div className="workspace-grid">
          <TimelinePanel items={detail?.timeline ?? []} />
          <div className="side-stack">
            <ContextPanel
              snapshots={detail?.contextSnapshots ?? []}
              usageSnapshots={detail?.contextUsageSnapshots ?? []}
            />
            <CachePanel reports={detail?.cacheReports ?? []} />
            <GapsPanel requests={detail?.developerRequests ?? []} />
          </div>
        </div>
      ) : null}

      {view === "gantt" ? (
        <div className="gantt-page">
          <ExecutionGanttPanel spans={spans} traceId={traceId} />
        </div>
      ) : null}
    </main>
  );
}
