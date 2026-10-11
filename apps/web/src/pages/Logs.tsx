import { useEffect, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { Link, useLocation, useParams, useSearchParams } from "react-router";
import { api, type LogPage } from "../api";
import { LogList } from "../components/LogList";
import { RangeTabs, SEARCH_RANGES, readRange } from "../components/RangeTabs";

type Range = "15m" | "1h" | "24h" | "7d";
const LEVELS: { v: string; label: string }[] = [{ v: "", label: "All levels" }, { v: "9", label: "Info and above" }, { v: "13", label: "Warn and above" }, { v: "17", label: "Error and above" }];

export function LogsPage() {
  const { projectId } = useParams();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const rawRange = params.get("range");
  const range: Range = readRange(rawRange, SEARCH_RANGES, "1h");
  const service = params.get("service") ?? "";
  const rawSev = params.get("severity") ?? "";
  const severity = LEVELS.some((l) => l.v === rawSev) ? rawSev : "";
  const traceId = /^[0-9a-f]{32}$/.test(params.get("traceId") ?? "") ? params.get("traceId")! : "";
  const urlQ = params.get("q") ?? "";
  const setQuery = (patch: Record<string, string>) => {
    // URL terbaru dari window.location: `prev` react-router bisa basi di dalam timer debounce.
    const next = new URLSearchParams(window.location.search);
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    setParams(next, { replace: true });
  };

  const [text, setText] = useState(urlQ);
  useEffect(() => { setText((t) => (t.trim() === urlQ ? t : urlQ)); }, [urlQ]);
  useEffect(() => {
    const v = text.trim();
    if (v === urlQ) return;
    const id = setTimeout(() => setQuery({ q: v }), 300);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const services = useQuery({
    queryKey: ["log-services", projectId, range],
    queryFn: () => api.get<{ services: string[] }>(`/projects/${projectId}/logs/services?range=${range}`),
    placeholderData: (prev) => prev,
  });
  const svcList = services.data?.services ?? [];

  const filter = new URLSearchParams({ range, ...(urlQ && { text: urlQ }), ...(service && { service }), ...(severity && { severity }), ...(traceId && { traceId }) });
  const logs = useInfiniteQuery({
    queryKey: ["logs", projectId, filter.toString()],
    // Halaman berikutnya membawa batas bawah jendela dari halaman pertama (fromUs), supaya jendela tidak bergeser.
    queryFn: ({ pageParam }) => api.get<LogPage>(`/projects/${projectId}/logs?${filter}&limit=100${pageParam
      ? `&before=${encodeURIComponent(pageParam.before)}${pageParam.from ? `&from=${pageParam.from}` : ""}` : ""}`),
    initialPageParam: null as { before: string; from?: number } | null,
    getNextPageParam: (last, pages) => (last.nextBefore ? { before: last.nextBefore, from: pages[0]?.fromUs ?? last.fromUs } : undefined),
    placeholderData: (prev) => prev,
  });
  const rows = logs.data?.pages.flatMap((p) => p.logs) ?? [];
  const enabled = logs.data?.pages[0]?.enabled ?? true;

  return (
    <section>
      <div className="hero" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
        <div>
          <h1>Logs</h1>
          <p className="sub" style={{ marginTop: 8 }}>OpenTelemetry log records, newest first. Logs with a trace ID link to their trace.</p>
        </div>
      </div>

      <div className="row trace-filters">
        <RangeTabs ranges={SEARCH_RANGES} value={range} onPick={(k) => setQuery({ range: k === "1h" ? "" : k })} />
      </div>
      <div className="row trace-filters">
        <select className="select" aria-label="Service" value={service} onChange={(e) => setQuery({ service: e.target.value })}>
          <option value="">All services</option>
          {service && !svcList.includes(service) && <option value={service}>{service}</option>}
          {svcList.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="select" aria-label="Minimum level" value={severity} onChange={(e) => setQuery({ severity: e.target.value })}>
          {LEVELS.map((l) => <option key={l.v} value={l.v}>{l.label}</option>)}
        </select>
        <label className="field trace-text">
          <Search size={16} />
          <input value={text} maxLength={500} placeholder="Search log messages" aria-label="Search log messages" onChange={(e) => setText(e.target.value)} />
        </label>
        {traceId && (
          <span className="tag" style={{ height: 32, display: "inline-flex", alignItems: "center", gap: 6 }}>
            trace <span className="mono">{traceId.slice(0, 12)}…</span>
            <a onClick={() => setQuery({ traceId: "" })} aria-label="Clear trace filter" style={{ cursor: "pointer" }}>×</a>
          </span>
        )}
      </div>

      {logs.isPending && <div className="empty">Loading…</div>}
      {logs.isError && <div className="empty">Failed to load logs: {logs.error.message}</div>}
      {!enabled && <div className="empty">Log ingest is not enabled on this server.</div>}
      {enabled && logs.data && rows.length === 0 && (
        <div className="empty">
          No logs in this range. Send OTLP logs to <span className="mono">/otlp/v1/logs</span> (or gRPC on port 4317) with the project key.
          <div style={{ marginTop: 12 }}><Link className="btn sm" to={`/p/${projectId}/settings`}>Settings</Link></div>
        </div>
      )}
      {rows.length > 0 && (
        <div className="card" style={{ padding: 8, opacity: logs.isFetching && logs.isPlaceholderData ? 0.6 : 1 }}>
          <LogList projectId={projectId!} logs={rows} showTrace backSearch={location.search} />
          {logs.hasNextPage && (
            <div style={{ textAlign: "center", padding: 12 }}>
              <button className="btn sm" disabled={logs.isFetchingNextPage} onClick={() => logs.fetchNextPage()}>
                {logs.isFetchingNextPage ? "Loading…" : "Load older logs"}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
