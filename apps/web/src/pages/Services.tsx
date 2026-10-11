import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Database, X } from "lucide-react";
import { Link, useParams, useSearchParams } from "react-router";
import { QuotaBanner } from "../components/QuotaBanner";
import { api, type ServiceDetail, type ServiceEdge, type ServiceEndpoint, type ServiceList } from "../api";
import { TimeChart } from "../components/TimeChart";
import { fmt, fmtLatency, pct, type Range } from "../components/health-util";
import { Spark } from "../components/Spark";
import { RangeTabs, ROLLUP_RANGES, rangeLabel, readRange } from "../components/RangeTabs";
import { edgePath, externalLabel, layoutMap, NODE_H, NODE_W } from "../components/service-map";

// Penanda merah di map dan tabel: rasio error di atas 5% dengan minimal 20 request (default alert API Health).
const THRESHOLD = { pct: 5, minRequests: 20 };
const bad = (count: number, errors: number) => count >= THRESHOLD.minRequests && (errors / count) * 100 >= THRESHOLD.pct;

export function ServicesPage() {
  const { projectId } = useParams();
  const [params, setParams] = useSearchParams();
  const rawRange = params.get("range");
  const range: Range = readRange(rawRange, ROLLUP_RANGES, "24h");
  const selected = params.get("service") ?? "";
  const setQuery = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    setParams(next, { replace: true });
  };

  const list = useQuery({
    queryKey: ["services", projectId, range],
    queryFn: () => api.get<ServiceList>(`/projects/${projectId}/services?range=${range}`),
    placeholderData: (prev) => prev,
    refetchInterval: 60_000,
  });
  const d = list.data;
  const unit = d ? (d.bucketSeconds >= 3600 ? "hour" : "minute") : "";
  const toggle = (name: string) => setQuery({ service: name === selected ? "" : name });

  return (
    <section>
      <QuotaBanner />
      <div className="hero" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
        <div>
          <h1>Services</h1>
          <p className="sub" style={{ marginTop: 8 }}>Requests and calls between services in the last {rangeLabel(ROLLUP_RANGES, range)}, from OpenTelemetry spans.</p>
        </div>
      </div>

      <div className="row" style={{ marginBottom: "var(--s5)", flexWrap: "wrap" }}>
        <RangeTabs ranges={ROLLUP_RANGES} value={range} onPick={(k) => setQuery({ range: k === "24h" ? "" : k })} />
      </div>

      {list.isPending && <div className="empty">Loading…</div>}
      {list.isError && <div className="empty">Failed to load services: {list.error.message}</div>}
      {d && d.services.length === 0 && (
        <div className="empty">
          No services yet. Services are built from OTLP spans; each app is named by its <span className="mono">service.name</span> resource attribute.
          <div style={{ marginTop: 12 }}><Link className="btn sm" to={`/p/${projectId}/settings`}>Settings</Link></div>
        </div>
      )}

      {d && d.services.length > 0 && (
        <div style={{ opacity: list.isFetching && list.isPlaceholderData ? 0.6 : 1 }}>
          <ServiceMap list={d} selected={selected} onSelect={toggle} />

          <div className="ihead services-grid" style={{ marginTop: "var(--s5)" }}>
            <span>Service</span><span>Requests</span><span>Error %</span><span>p50</span><span>p95</span><span>p99</span><span />
          </div>
          <div className="ilist">
            {d.services.map((s) => {
              const hot = bad(s.count, s.errors);
              return (
                <div key={s.name} className={`irow services-grid ${s.name === selected ? "on" : ""} ${hot ? "hot" : ""}`} onClick={() => toggle(s.name)}>
                  <span className="mono ttl" style={{ fontSize: 13 }} title={s.name}>{s.name}</span>
                  <span className="v num">{fmt(s.count)}</span>
                  <span className="v num"><span className={hot ? "health-bad" : ""}>{pct(s.errorRate)}</span></span>
                  <span className="num">{fmtLatency(s.p50)}</span>
                  <span className="num">{fmtLatency(s.p95)}</span>
                  <span className="num">{fmtLatency(s.p99)}</span>
                  <Spark data={s.series} err={s.errSeries} hot={bad} title={(n) => `${fmt(n)} requests, per ${unit}`} />
                </div>
              );
            })}
          </div>
          <p className="sub" style={{ fontSize: 12, margin: "12px 0 0 8px" }}>
            Requests = incoming server and consumer spans. Errors = span status ERROR or HTTP 5xx. Latency percentiles are approximate (bucket upper bounds).
          </p>

          {selected && <ServiceCard projectId={projectId!} range={range} service={selected} onSelect={(s) => setQuery({ service: s })} onClose={() => setQuery({ service: "" })} />}
        </div>
      )}
    </section>
  );
}

function ServiceMap({ list, selected, onSelect }: { list: ServiceList; selected: string; onSelect: (name: string) => void }) {
  const { nodes, width, height } = layoutMap(list.services.map((s) => s.name), list.edges);
  const at = new Map(nodes.map((n) => [n.id, n]));
  const stats = new Map(list.services.map((s) => [s.name, s]));
  const near = (e: ServiceEdge) => !selected || e.source === selected || e.target === selected;
  return (
    <div className="card svc-map" role="group" aria-label="Service map">
      <div style={{ overflowX: "auto" }}>
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
          <defs>
            <marker id="svc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
            </marker>
          </defs>
          {list.edges.map((e) => {
            const a = at.get(e.source), b = at.get(e.target);
            if (!a || !b || a === b) return null;
            const hot = bad(e.count, e.errors);
            return (
              <g key={`${e.source}>${e.target}`} className={`svc-edge ${hot ? "hot" : ""} ${near(e) ? "" : "dim"}`}>
                <path d={edgePath(a, b)} markerEnd="url(#svc-arrow)">
                  <title>{`${e.source} → ${e.target}: ${fmt(e.count)} calls, ${pct(e.errorRate)} errors, p95 ${fmtLatency(e.p95)}`}</title>
                </path>
              </g>
            );
          })}
          {nodes.map((n) => {
            const s = stats.get(n.id);
            const hot = s ? bad(s.count, s.errors) : false;
            const cls = `svc-node ${n.external ? "ext" : ""} ${hot ? "hot" : ""} ${n.id === selected ? "on" : ""}`;
            return (
              <g key={n.id} className={cls} transform={`translate(${n.x},${n.y})`}
                onClick={n.external ? undefined : () => onSelect(n.id)} tabIndex={n.external ? -1 : 0} role={n.external ? undefined : "button"}
                onKeyDown={(ev) => { if (!n.external && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); onSelect(n.id); } }}>
                <rect width={NODE_W} height={NODE_H} rx={n.external ? 26 : 12} />
                <text x={12} y={21} className="svc-name">{n.id.length > 20 ? `${n.id.slice(0, 19)}…` : n.id}<title>{n.id}</title></text>
                <text x={12} y={39} className="svc-meta">
                  {n.external ? externalLabel(n.id) : s && s.count > 0 ? `${fmt(s.count)} req · ${pct(s.errorRate)} err` : "outgoing calls only"}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

function ServiceCard({ projectId, range, service, onSelect, onClose }: {
  projectId: string; range: Range; service: string; onSelect: (s: string) => void; onClose: () => void;
}) {
  const q = useQuery({
    queryKey: ["service", projectId, range, service],
    queryFn: () => api.get<ServiceDetail>(`/projects/${projectId}/services/detail?${new URLSearchParams({ range, service })}`),
    placeholderData: (prev) => prev,
    refetchInterval: 60_000,
  });
  const card = useRef<HTMLDivElement>(null);
  const loaded = Boolean(q.data);
  useEffect(() => {
    if (!loaded) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    card.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  }, [service, loaded]);
  // Grafik API Health dipakai ulang: errors ditampilkan di deret "5xx" dengan label "error".
  const s = (q.data?.series ?? []).map((p) => ({ ...p, c4xx: 0, c5xx: p.errors }));

  return (
    <div ref={card} className="card" style={{ marginTop: "var(--s5)", scrollMarginTop: 80 }}>
      <div className="head">
        <h2 className="mono" style={{ fontSize: 15 }}>{service}</h2>
        <div className="row" style={{ gap: 8 }}>
          <Link className="btn sm" to={`/p/${projectId}/traces?service=${encodeURIComponent(service)}`}>Traces</Link>
          <a className="iconbtn sm" onClick={onClose} title="Close"><X /></a>
        </div>
      </div>
      {q.isPending && <div className="sub">Loading…</div>}
      {q.isError && <div className="sub">Failed to load service: {q.error.message}</div>}
      {q.data && (
        <>
          <TimeChart s={s} range={range} bucketSeconds={q.data.bucketSeconds} threshold={THRESHOLD} window={null} onSelect={() => {}} errLabel="error" />
          <div className="svc-calls">
            <Calls title="Called by" empty="No callers seen." edges={q.data.upstream} side="source" onSelect={onSelect} />
            <Calls title="Calls" empty="No outgoing calls seen." edges={q.data.downstream} side="target" onSelect={onSelect} />
          </div>
          <Endpoints projectId={projectId} range={range} endpoints={q.data.endpoints ?? []} />
        </>
      )}
    </div>
  );
}

function Endpoints({ projectId, range, endpoints }: { projectId: string; range: Range; endpoints: ServiceEndpoint[] }) {
  return (
    <div style={{ marginTop: "var(--s5)" }}>
      <h3 className="svc-calls-h">Endpoints</h3>
      {endpoints.length === 0 ? <div className="sub" style={{ fontSize: 13 }}>No HTTP server requests seen.</div> : (
        <table className="svc-table">
          <thead><tr><th>Endpoint</th><th>Requests</th><th>5xx %</th><th>4xx</th><th>p50</th><th>p95</th><th>p99</th></tr></thead>
          <tbody>
            {endpoints.map((e) => (
              <tr key={`${e.method} ${e.route}`}>
                <td>
                  <Link className="row" style={{ gap: 8, minWidth: 0 }} title="Open in API Health"
                    to={`/p/${projectId}/health?${new URLSearchParams({ ...(range !== "24h" && { range }), method: e.method, route: e.route })}`}>
                    <span className="tag">{e.method}</span><span className="mono">{e.route}</span>
                  </Link>
                </td>
                <td className="num">{fmt(e.count)}</td>
                <td className={`num ${bad(e.count, e.c5xx) ? "health-bad" : ""}`}>{pct(e.errorRate)}</td>
                <td className="num">{fmt(e.c4xx)}</td>
                <td className="num">{fmtLatency(e.p50)}</td>
                <td className="num">{fmtLatency(e.p95)}</td>
                <td className="num">{fmtLatency(e.p99)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Calls({ title, empty, edges, side, onSelect }: {
  title: string; empty: string; edges: ServiceEdge[]; side: "source" | "target"; onSelect: (s: string) => void;
}) {
  return (
    <div>
      <h3 className="svc-calls-h">{title}</h3>
      {edges.length === 0 ? <div className="sub" style={{ fontSize: 13 }}>{empty}</div> : (
        <table className="svc-table">
          <thead><tr><th>Service</th><th>Calls</th><th>Error %</th><th>p95</th></tr></thead>
          <tbody>
            {edges.map((e) => {
              const name = e[side];
              const ext = side === "target" && e.external;
              return (
                <tr key={`${e.source}>${e.target}`}>
                  <td className="mono">
                    {ext ? <span className="row" style={{ gap: 6 }}><Database size={13} />{name}</span>
                      : <a onClick={() => onSelect(name)}>{name}</a>}
                  </td>
                  <td className="num">{fmt(e.count)}</td>
                  <td className={`num ${bad(e.count, e.errors) ? "health-bad" : ""}`}>{pct(e.errorRate)}</td>
                  <td className="num">{fmtLatency(e.p95)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {side === "target" && edges.some((e) => e.external) && (
        <p className="sub" style={{ fontSize: 12, marginTop: 8 }}>
          Databases and other dependencies don't send traces themselves; they are seen from the caller, which also measures their latency.
        </p>
      )}
    </div>
  );
}
