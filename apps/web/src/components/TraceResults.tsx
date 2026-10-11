import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { api, type TraceRow, type TraceSearch } from "../api";
import { errText, fmt, fmtDuration, fmtTime } from "./health-util";
import { Pager } from "./Pager";
import { StatusChips } from "./StatusChips";
import type { PageSize } from "./pager-util";

/** Token filter status (lihat status-util.ts); [] = semua. */
export type TraceStatus = string[];
export interface TraceFilters { range: "15m" | "1h" | "24h" | "7d"; status: TraceStatus; service: string; q: string; minMs: string }

// Badge status: kode HTTP kalau ada (merah >= 500, kuning 4xx), selain itu Error/OK dari status span.
function StatusBadge({ t }: { t: TraceRow }) {
  if (t.httpStatus) {
    const cls = t.httpStatus >= 500 ? "err" : t.httpStatus >= 400 ? "warn" : "";
    return <span className={`tag ${cls}`}>{t.httpStatus}</span>;
  }
  return t.statusCode === 2 ? <span className="tag err">Error</span> : <span className="tag">OK</span>;
}

export function TraceResults({ projectId, filters, backSearch, page, size, onPage, onSize, onStatus }: {
  projectId: string; filters: TraceFilters; backSearch: string; onStatus: (s: TraceStatus) => void;
  page: number; size: PageSize; onPage: (p: number) => void; onSize: (s: PageSize) => void;
}) {
  const navigate = useNavigate();
  const { range, service, q: text, minMs } = filters;
  const status = filters.status.length ? filters.status.join(",") : "all";
  const top0 = useRef<HTMLDivElement>(null);
  const q = useQuery({
    // Filter berubah -> parent mengembalikan page ke 1 (lihat setQuery di TracesPage).
    queryKey: ["traces", projectId, range, status, service, text, minMs, page, size],
    queryFn: () => {
      const sp = new URLSearchParams({ range, status, page: String(page), size: String(size) });
      if (service) sp.set("service", service);
      if (text) sp.set("q", text);
      if (minMs) sp.set("minMs", minMs);
      return api.get<TraceSearch>(`/projects/${projectId}/traces?${sp}`);
    },
    placeholderData: (prev) => prev,
  });
  const rows = q.data?.traces ?? [];
  const sampled = q.data?.sampled;
  // Ganti halaman: gulir ke awal tabel.
  const go = (fn: () => void) => {
    fn();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    top0.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  };
  const pager = (n: number) => q.data && (
    <Pager page={page} size={size} total={q.data.total ?? n} rows={n} onPage={(p) => go(() => onPage(p))} onSize={(s) => go(() => onSize(s))} />
  );
  // State berisi query pencarian, supaya tombol kembali di halaman trace membawa filter yang sama.
  const open = (t: TraceRow) => navigate(`/p/${projectId}/traces/${t.traceId}`, { state: { fromTraces: backSearch } });

  return (<>
    <div className="row trace-filters">
      <StatusChips value={filters.status} counts={q.data?.statusCounts} loading={q.isFetching} onChange={onStatus} withError />
    </div>
    <div ref={top0} style={{ opacity: q.isFetching && q.isPlaceholderData ? 0.6 : 1, scrollMarginTop: 80 }} aria-busy={q.isFetching && q.isPlaceholderData}>
      {sampled && <p className="sub" style={{ fontSize: 12, margin: "0 0 12px 8px" }}>Lite mode stores sampled error and slow traces — switch to Scale mode (ClickHouse) to see every request.</p>}
      {q.isPending && <div className="empty">Loading…</div>}
      {q.isError && <div className="empty">Failed to load traces: {q.error.message}</div>}
      {q.data && rows.length === 0 && (q.data.total > 0
        ? <><div className="empty">No traces on this page.</div>{pager(0)}</>
        : <div className="empty">No traces match these filters.</div>)}
      {rows.length > 0 && (
        <>
          <div className="ihead trace-grid">
            <span>Time</span><span>Service</span><span>Name</span><span>Status</span><span>Duration</span><span>Spans</span><span>Error</span>
          </div>
          <div className="ilist">
            {rows.map((t) => {
              const txt = t.error ? errText(t.error) : "";
              return (
                <div key={`${t.traceId}:${t.spanId}`} className="irow trace-grid" role="link" tabIndex={0}
                  aria-label={`Open trace ${t.name}, ${t.httpStatus ?? (t.statusCode === 2 ? "Error" : "OK")}, ${fmtDuration(t.durationUs)}`} onClick={() => open(t)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); open(t); } }}>
                  <span className="mono num" style={{ fontSize: 13 }}>{fmtTime(t.startUs)}</span>
                  <span style={{ minWidth: 0 }}>{t.service ? <span className="tag trace-svc" title={t.service}>{t.service}</span> : <span className="sub">—</span>}</span>
                  <span className="mono ttl" style={{ fontSize: 13 }} title={t.name}>{t.name}</span>
                  <span><StatusBadge t={t} /></span>
                  <span className="num">{fmtDuration(t.durationUs)}{t.slow && <span className="tag slow" title="Slow request (at or above the project threshold)">slow</span>}</span>
                  <span className="num">{fmt(t.spanCount)}</span>
                  {t.error ? <span className="mono trace-err" title={txt}>{txt}</span> : <span className="sub">—</span>}
                </div>
              );
            })}
          </div>
          {pager(rows.length)}
        </>
      )}
    </div>
  </>);
}
