import { useQuery } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { useMemo, useState } from "react";
import { api, ApiError } from "../api";
import { useProject } from "../hooks";

// Tampilan trace bergaya Jaeger: penggaris waktu, satu baris per span (bertingkat, warna per service),
// klik span untuk melihat atribut, resource, dan event (exception).
interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startUs: number;
  durationUs: number;
  statusCode: number;
  statusMessage?: string;
  attributes: Record<string, unknown>;
  events: { name: string; timeUs: number; attributes: Record<string, unknown> }[];
  service?: string;
}
interface TraceResponse { traceId: string; spans: Span[]; resource: Record<string, unknown> }

const PALETTE = ["#6c5ce7", "#e08a2c", "#2a9d8f", "#d6457a", "#3b82f6", "#8a6a3b", "#16a34a"];
const KIND = ["unspecified", "internal", "server", "client", "producer", "consumer"];
const fmtMs = (us: number) => (us >= 1_000_000 ? `${(us / 1_000_000).toFixed(2)} s` : `${(us / 1000).toFixed(1)} ms`);
const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
const isErr = (s: Span) => s.statusCode === 2 || s.events.some((e) => e.name === "exception");

// Sumber trace: lewat issue (issueId) atau path API langsung (mis. trace per project dari API Health).
export function TraceView({ issueId, path, traceId, notFoundText }: { issueId?: string; path?: string; traceId: string; notFoundText?: string }) {
  const project = useProject();
  const url = path ?? `/issues/${issueId}/trace/${traceId}`;
  const q = useQuery({
    queryKey: ["trace", url],
    queryFn: () => api.get<TraceResponse>(url),
    retry: false,
  });
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);

  const model = useMemo(() => {
    const spans = q.data?.spans ?? [];
    if (!spans.length) return null;
    const ids = new Set(spans.map((s) => s.spanId));
    const kids = new Map<string, Span[]>();
    const roots: Span[] = [];
    for (const s of [...spans].sort((a, b) => a.startUs - b.startUs)) {
      // Induk yang tidak tersimpan (mis. dari service lain) -> tampilkan sebagai akar.
      if (s.parentSpanId && ids.has(s.parentSpanId)) kids.set(s.parentSpanId, [...(kids.get(s.parentSpanId) ?? []), s]);
      else roots.push(s);
    }
    const t0 = Math.min(...spans.map((s) => s.startUs));
    const t1 = Math.max(...spans.map((s) => s.startUs + s.durationUs));
    const services = [...new Set(spans.map((s) => s.service ?? "unknown"))];
    const color = (svc?: string) => PALETTE[services.indexOf(svc ?? "unknown") % PALETTE.length]!;
    const depthOf = (s: Span): number => (s.parentSpanId && ids.has(s.parentSpanId) ? depthOf(spans.find((x) => x.spanId === s.parentSpanId)!) + 1 : 0);
    const maxDepth = Math.max(...spans.map(depthOf)) + 1;
    return { spans, kids, roots, t0, total: Math.max(1, t1 - t0), services, color, maxDepth };
  }, [q.data]);

  if (q.isPending) return <p className="sub">Loading trace…</p>;
  if (q.isError && notFoundText && q.error instanceof ApiError && q.error.status === 404) return <p className="sub">{notFoundText}</p>;
  if (q.isError || !model) return <p className="sub">{q.error?.message ?? notFoundText ?? "Trace not stored."}</p>;

  const { kids, roots, t0, total, services, color } = model;
  const firstErr = model.spans.find((s) => s.events.some((e) => e.name === "exception"));
  const sel = selected ?? firstErr?.spanId ?? null;
  const rows: { s: Span; depth: number }[] = [];
  const walk = (s: Span, depth: number) => {
    rows.push({ s, depth });
    if (!closed.has(s.spanId)) for (const k of kids.get(s.spanId) ?? []) walk(k, depth + 1);
  };
  roots.forEach((r) => walk(r, 0));
  const toggle = (id: string) => setClosed((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className="jg">
      <div className="jg-head">
        <div className="jg-meta">
          <span><small>Duration</small>{fmtMs(total)}</span>
          <span><small>Services</small>{services.length}</span>
          <span><small>Depth</small>{model.maxDepth}</span>
          <span><small>Spans</small>{model.spans.length}</span>
        </div>
        <button type="button" className="btn sm" onClick={() => navigator.clipboard?.writeText(traceId)} title="Copy trace ID">
          <Copy /><span className="mono">{traceId.slice(0, 16)}…</span>
        </button>
      </div>
      <div className="jg-mini">
        {model.spans.map((s, i) => (
          <i key={s.spanId} style={{ left: `${((s.startUs - t0) / total) * 100}%`, width: `${Math.max(0.4, (s.durationUs / total) * 100)}%`,
            top: 6 + (i % 9) * 4, background: isErr(s) && !kids.get(s.spanId) ? "var(--red)" : color(s.service) }} />
        ))}
      </div>
      <div className="jg-grid jg-ruler">
        <div className="jg-name">Service &amp; operation</div>
        <div className="jg-ticks">{[0, 0.25, 0.5, 0.75, 1].map((f) => <span key={f}>{fmtMs(total * f)}</span>)}</div>
      </div>
      {rows.map(({ s, depth }) => {
        const left = ((s.startUs - t0) / total) * 100, width = (s.durationUs / total) * 100;
        const hasKids = (kids.get(s.spanId)?.length ?? 0) > 0;
        const exc = s.events.find((e) => e.name === "exception");
        // Label durasi: di kanan batang; kalau batang sampai ujung, di dalam batang (lebar) atau di kirinya (sempit).
        const label = left + width <= 80 ? { left: `calc(${left + width}% + 6px)` }
          : width >= 15 ? { right: `calc(${100 - left - width}% + 8px)`, color: "#fff", fontWeight: 500 }
          : { right: `calc(${100 - left}% + 6px)` };
        return (
          <div key={s.spanId}>
            <div className={`jg-grid jg-row ${s.spanId === sel ? "sel" : ""}`} onClick={() => setSelected(s.spanId === sel ? "" : s.spanId)}>
              <div className="jg-name" style={{ paddingLeft: 12 + depth * 16 }}>
                <span className="jg-tog" onClick={(e) => { if (hasKids) { e.stopPropagation(); toggle(s.spanId); } }}>{hasKids ? (closed.has(s.spanId) ? "▸" : "▾") : ""}</span>
                <span className="jg-svc" style={{ background: color(s.service) }} />
                {isErr(s) && <span className="jg-err" title="Error">!</span>}
                <b>{s.service ?? "unknown"}</b><span className="jg-op">{s.name}</span>
              </div>
              <div className="jg-lane">
                <div className="jg-bar" style={{ left: `${left}%`, width: `${width}%`, background: exc && !hasKids ? "var(--red)" : color(s.service) }} />
                <span className="jg-dur" style={label}>{fmtMs(s.durationUs)}</span>
              </div>
            </div>
            {s.spanId === sel && (
              <div className="jg-detail">
                <h4>{s.name} <span className="sub">· {KIND[s.kind] ?? s.kind} · starts at {fmtMs(s.startUs - t0)} · {fmtMs(s.durationUs)}</span></h4>
                <h4>Attributes</h4>
                <div className="jg-kv">
                  {Object.entries(s.attributes).map(([k, v]) => <span key={k} style={{ display: "contents" }}><span>{k}</span><b>{show(v)}</b></span>)}
                  {s.statusCode === 2 && <><span>otel.status_code</span><b style={{ color: "var(--red)" }}>ERROR{s.statusMessage ? ` · ${s.statusMessage}` : ""}</b></>}
                </div>
                {s.events.length > 0 && (
                  <>
                    <h4>Events ({s.events.length})</h4>
                    {s.events.map((ev, i) => (
                      <div key={i} className={`jg-log ${ev.name === "exception" ? "" : "ok"}`}>
                        <b>{ev.name}</b> <span className="sub">at {fmtMs(ev.timeUs - t0)}</span>
                        {Object.entries(ev.attributes).map(([k, v]) => `\n  ${k}: ${show(v)}`).join("")}
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
      <div className="jg-foot">
        <span className="legend">{services.map((svc) => <span key={svc}><i style={{ background: color(svc) }} />{svc}</span>)}</span>
        {/* Catatan hanya relevan bila penyimpanan tidak menyimpan semua span (mode Lite). */}
        {project.data?.traceStorage?.allSpans === false && <span className="sub">Only traces that contain an error are stored.</span>}
      </div>
    </div>
  );
}
