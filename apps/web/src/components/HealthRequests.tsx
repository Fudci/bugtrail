import { Fragment, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, X } from "lucide-react";
import { Link } from "react-router";
import { api, type HealthRequests as Page, type RequestBody, type RequestError } from "../api";
import { errText, fmt, fmtDuration, fmtTime } from "./health-util";
import { Pager } from "./Pager";
import { StatusChips } from "./StatusChips";
import type { PageSize } from "./pager-util";

/** Token filter status (lihat status-util.ts); [] = semua. */
export type Status = string[];

const hm = (t: number) => new Date(t * 1000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
const dm = (t: number) => { const d = new Date(t * 1000); return `${d.getDate()} ${d.toLocaleString("en-US", { month: "short" })}`; };
// Label chip rentang waktu: sertakan tanggal untuk bucket >= 1 jam atau range 7 hari, mis. "9 Oct 14:00–15:00".
function windowRange(t: number, end: number, secs: number, range: string) {
  if (secs < 3600 && range !== "7d") return `${hm(t)}–${hm(end)}`;
  return dm(t) === dm(end) || hm(end) === "24:00" ? `${dm(t)} ${hm(t)}–${hm(end)}` : `${dm(t)} ${hm(t)}–${dm(end)} ${hm(end)}`;
}

function ErrorDetail({ e }: { e: RequestError }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <dl>
        {e.type && <><dt>Type</dt><dd className="mono">{e.type}</dd></>}
        {e.message && <><dt>Message</dt><dd className="mono">{e.message}</dd></>}
        {e.spanName && <><dt>Span</dt><dd className="mono">{e.spanName}</dd></>}
      </dl>
      {e.stacktrace ? <pre className="req-err-stack">{e.stacktrace}</pre> : <div className="sub" style={{ fontSize: 12 }}>No stack trace recorded.</div>}
    </div>
  );
}

// JSON yang bisa di-parse ditampilkan rapi (indent 2), selain itu teks mentah. Selalu dirender sebagai teks.
function pretty(text: string) {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}

function BodyBlock({ label, text, truncated }: { label: string; text: string; truncated: boolean }) {
  const [copied, setCopied] = useState(false);
  const shown = pretty(text);
  return (
    <div className="req-body-block">
      <div className="row req-body-head">
        <span className="sub">{label}</span>
        {truncated && <span className="sub req-body-note">truncated at 64K characters</span>}
        <button type="button" className="btn sm" style={{ marginLeft: "auto" }}
          onClick={async () => { try { await navigator.clipboard.writeText(shown); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard ditolak */ } }}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="req-err-stack req-body-pre">{shown}</pre>
    </div>
  );
}

const NOT_CAPTURED = "Bodies appear when the app records http.request.body / http.response.body on the server span.";

// Body request/response, dimuat lazy saat baris dibuka.
function RequestBodies({ projectId, traceId, spanId }: { projectId: string; traceId: string; spanId: string }) {
  const q = useQuery({
    queryKey: ["server-span", projectId, traceId, spanId],
    queryFn: () => api.get<{ body: RequestBody | null }>(`/projects/${projectId}/traces/${traceId}/server-span?spanId=${spanId}`),
    staleTime: Infinity,
    retry: false,
  });
  if (q.isPending) return <div className="sub" style={{ fontSize: 12 }}>Loading request body…</div>;
  if (q.isError) return <div className="sub" style={{ fontSize: 12 }}>Failed to load request body: {q.error.message}</div>;
  const b = q.data.body;
  const cut = (f: "request" | "query" | "response") => b?.truncatedFields?.includes(f) ?? false;
  const none = (what: string) => <div className="sub" style={{ fontSize: 12 }}>{what} not captured. {NOT_CAPTURED}</div>;
  return (
    <div className="req-bodies">
      {b?.userId && <dl><dt>User</dt><dd className="mono">{b.userId}</dd></dl>}
      <section aria-label="Request">
        <div className="req-body-title">Request</div>
        {b?.query && <BodyBlock label="Query" text={b.query} truncated={cut("query")} />}
        {b?.request && <BodyBlock label="Body" text={b.request} truncated={cut("request")} />}
        {!b?.query && !b?.request && none("Request")}
      </section>
      <section aria-label="Response">
        <div className="req-body-title">Response</div>
        {b?.response ? <BodyBlock label="Body" text={b.response} truncated={cut("response")} /> : none("Response")}
      </section>
    </div>
  );
}

export function HealthRequests({ projectId, range, method, route, status, onStatus: setStatus, window: win, bucketSeconds, onClearWindow, page, size, onPage, onSize }: {
  projectId: string; range: string; method: string; route: string; status: Status; onStatus: (s: Status) => void;
  window: { from: number; to: number } | null; bucketSeconds: number; onClearWindow: () => void;
  page: number; size: PageSize; onPage: (p: number) => void; onSize: (s: PageSize) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const top0 = useRef<HTMLDivElement>(null);
  const statusParam = status.length ? status.join(",") : "all";
  const filterKey = [projectId, range, method, route, statusParam, win?.from, win?.to].join("|");
  const q = useQuery({
    // Filter berubah -> parent mengembalikan page ke 1 (lihat setQuery di HealthPage).
    queryKey: ["health-requests", projectId, range, method, route, statusParam, win?.from, win?.to, page, size],
    queryFn: () => {
      const sp = new URLSearchParams({ method, route, range, status: statusParam, page: String(page), size: String(size) });
      if (win) { sp.set("from", String(win.from)); sp.set("to", String(win.to)); }
      return api.get<Page>(`/projects/${projectId}/health/requests?${sp}`);
    },
    // Data lama tetap tampil (diredupkan) selama halaman baru dimuat, supaya pager tidak melompat.
    placeholderData: (prev) => prev,
  });
  const rows = q.data?.requests ?? [];
  const sampled = q.data?.sampled;
  // topErrors dikirim di setiap halaman; simpan yang terakhir untuk filter yang sama supaya tidak berkedip saat paging.
  const lastTop = useRef<{ key: string; top: NonNullable<Page["topErrors"]> }>({ key: "", top: [] });
  if (q.data?.topErrors && !q.isPlaceholderData) lastTop.current = { key: filterKey, top: q.data.topErrors };
  const top = lastTop.current.key === filterKey ? lastTop.current.top : [];
  const go = (fn: () => void) => {
    // Ganti halaman: tutup baris yang terbuka dan gulir ke awal tabel.
    setOpen(null);
    fn();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    top0.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  };

  return (
    <div ref={top0} style={{ marginTop: "var(--s5)", scrollMarginTop: 80 }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <div className="sub" style={{ fontSize: 13, marginRight: 4 }}>Requests</div>
        {win && (
          <span className="tag acc filter-chip">{windowRange(win.from, win.to, bucketSeconds, range)}
            <button type="button" className="chip-x" onClick={onClearWindow} aria-label="Clear time filter"><X /></button>
          </span>
        )}
        <StatusChips value={status} counts={q.data?.statusCounts} loading={q.isFetching} onChange={setStatus} />
      </div>
      {sampled && <p className="sub" style={{ fontSize: 12, margin: "0 0 12px 8px" }}>Lite mode stores sampled error and slow traces — switch to Scale mode (ClickHouse) to see every request.</p>}
      {q.isPending && <div className="sub">Loading…</div>}
      {q.isError && <div className="sub">Failed to load requests: {q.error.message}</div>}
      {q.data && rows.length === 0 && q.data.total === 0 && (
        <div className="sub">{status.length === 0 ? "No requests in this range." : `No ${status.join(", ")} requests in this range.`}</div>
      )}
      {top.length > 0 && (
        <div className="top-errors" aria-label="Top errors">
          <div className="sub" style={{ fontSize: 12 }}>Top errors</div>
          {top.map((t) => (
            <div key={`${t.type ?? ""}:${t.message}`} className="top-err" title={errText(t)}>
              <span className="mono top-err-text">{errText(t)}</span><span className="num top-err-n">×{t.count}</span>
            </div>
          ))}
        </div>
      )}
      {q.data && rows.length === 0 && q.data.total > 0 && (
        <><div className="sub">No requests on this page.</div><Pager page={page} size={size} total={q.data.total} rows={0} onPage={(p) => go(() => onPage(p))} onSize={(s) => go(() => onSize(s))} /></>
      )}
      {rows.length > 0 && (
        <div style={{ opacity: q.isFetching && q.isPlaceholderData ? 0.6 : 1 }} aria-busy={q.isFetching && q.isPlaceholderData}>
          <div className="ihead req-grid"><span>Time</span><span>Status</span><span>Duration</span><span>Error</span><span>Trace</span></div>
          <div className="ilist">
            {rows.map((r) => {
              const k = `${r.traceId}:${r.spanId}`;
              const on = open === k;
              const txt = r.error ? errText(r.error) : "";
              return (
                <Fragment key={k}>
                  <div className={`irow req-grid has-err${on ? " on" : ""}`}
                    onClick={(ev) => { if (!(ev.target as HTMLElement).closest("a,button")) setOpen(on ? null : k); }}>
                    <span className="mono num" style={{ fontSize: 13 }}>{fmtTime(r.startUs)}</span>
                    <span className={`num ${r.status >= 500 ? "health-bad" : ""}`}>{r.status || "—"}</span>
                    <span className="num">{fmtDuration(r.durationUs)}{r.slow && <span className="tag slow" title="Slow request (at or above the project threshold)">slow</span>}</span>
                    {r.error ? (
                      <button type="button" className="req-err mono" title={txt} aria-expanded={on} aria-controls={`err-${k}`}
                        onClick={() => setOpen(on ? null : k)}>{txt}</button>
                    ) : (
                      <button type="button" className="req-err req-more" aria-expanded={on} aria-controls={`err-${k}`}
                        onClick={() => setOpen(on ? null : k)}>Details</button>
                    )}
                    <span><Link to={`/p/${projectId}/traces/${r.traceId}`} state={{ fromHealth: true }} className="btn sm">Open trace <ArrowUpRight /></Link></span>
                  </div>
                  {on && (
                    <div id={`err-${k}`} className="req-err-detail">
                      {r.error && <ErrorDetail e={r.error} />}
                      <RequestBodies projectId={projectId} traceId={r.traceId} spanId={r.spanId} />
                    </div>
                  )}
                </Fragment>
              );
            })}
          </div>
          <Pager page={page} size={size} total={q.data?.total ?? rows.length} rows={rows.length}
            onPage={(p) => go(() => onPage(p))} onSize={(s) => go(() => onSize(s))}
            extra={sampled && q.data?.observed !== undefined ? (
              <> stored <span className="sub">(of ~{fmt(q.data.observed)} requests — Lite mode samples error and slow traces)</span></>
            ) : undefined} />
        </div>
      )}
    </div>
  );
}
