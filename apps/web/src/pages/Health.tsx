import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, X } from "lucide-react";
import { Link, useParams, useSearchParams } from "react-router";
import { QuotaBanner } from "../components/QuotaBanner";
import { api, type HealthList, type HealthPoint, type HealthThreshold } from "../api";
import { HealthRequests, type Status as ReqStatus } from "../components/HealthRequests";
import { parseStatus } from "../components/status-util";
import { TimeChart, type TimeWindow } from "../components/TimeChart";
import { breachLabel, breachTitle, breaches, fmt, fmtLatency, pct, sortEndpoints, type Range, type Sort } from "../components/health-util";
import { Spark } from "../components/Spark";
import { RangeTabs, ROLLUP_RANGES, rangeLabel, readRange } from "../components/RangeTabs";
import { DEFAULT_SIZE, readPaging, type PageSize } from "../components/pager-util";

const SORTS: { key: Sort; label: string }[] = [{ key: "problems", label: "Problems" }, { key: "requests", label: "Requests" }, { key: "p95", label: "p95" }];

// Panjang rentang (detik), sama dengan ROLLUP_RANGES di API (dashboard/common.ts).
const RANGE_S: Record<Range, number> = { "1h": 3600, "24h": 86_400, "7d": 7 * 86_400 };

export function HealthPage() {
  const { projectId } = useParams();
  const [params, setParams] = useSearchParams();
  // Validasi ?range= dari URL; nilai tak dikenal kembali ke "24h".
  const rawRange = params.get("range");
  const range: Range = readRange(rawRange, ROLLUP_RANGES, "24h");
  const rawSort = params.get("sort");
  const sort: Sort = rawSort === "requests" || rawSort === "p95" ? rawSort : "problems";
  const method = params.get("method") ?? "";
  const route = params.get("route") ?? "";
  // Jendela waktu grafik (?from=&to=, detik epoch) dan filter status request (?status=4xx|all; 5xx = default, tidak ditulis).
  const fromN = Number(params.get("from")), toN = Number(params.get("to"));
  const urlWin: TimeWindow | null = Number.isInteger(fromN) && Number.isInteger(toN) && fromN > 0 && toN > fromN ? { from: fromN, to: toN } : null;
  // Bookmark lama: jendela di luar rentang sekarang ditolak API (400). Abaikan dan hapus dari URL
  // (aturan sama dengan health-routes: [now - range, now + 60)).
  const nowS = Date.now() / 1000;
  const stale = !!urlWin && (urlWin.to <= nowS - RANGE_S[range] || urlWin.from >= nowS + 60);
  const win = stale ? null : urlWin;
  // ?status=500,502 / 4xx / all; tidak ada atau tidak sah = 5xx (default, tidak ditulis).
  const status: ReqStatus = parseStatus(params.get("status") ?? "5xx") ?? ["5xx"];
  // Halaman tabel request (?page=&size=; 1 dan 50 tidak ditulis).
  const { page, size } = readPaging(params);
  const setQuery = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    // Filter apa pun berubah -> kembali ke halaman 1.
    if (!("page" in patch)) next.delete("page");
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    setParams(next, { replace: true });
  };
  useEffect(() => {
    if (stale) setQuery({ from: "", to: "" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stale]);

  const list = useQuery({
    queryKey: ["health", projectId, range],
    queryFn: () => api.get<HealthList>(`/projects/${projectId}/health?range=${range}`),
    placeholderData: (prev) => prev,
    refetchInterval: 60_000,
  });
  // Server versi lama belum mengirim threshold: pakai default alert (5% dari minimal 20 request).
  const d = list.data && { ...list.data, threshold: list.data.threshold ?? { pct: 5, minRequests: 20 } };
  const unit = d ? (d.bucketSeconds >= 3600 ? "hour" : "minute") : "";

  return (
    <section>
      <QuotaBanner />
      <div className="hero" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
        <div>
          <h1>API Health</h1>
          <p className="sub" style={{ marginTop: 8 }}>HTTP server requests per endpoint in the last {rangeLabel(ROLLUP_RANGES, range)}.</p>
        </div>
      </div>

      <div className="row" style={{ marginBottom: "var(--s5)", flexWrap: "wrap" }}>
        <RangeTabs ranges={ROLLUP_RANGES} value={range} onPick={(k) => setQuery({ range: k === "24h" ? "" : k, from: "", to: "" })} />
        <div className="ptabs" aria-label="Sort endpoints">
          {SORTS.map((o) => (
            <a key={o.key} className={sort === o.key ? "on" : ""} onClick={() => setQuery({ sort: o.key === "problems" ? "" : o.key })}>{o.label}</a>
          ))}
        </div>
        <Link className="btn sm" to={`/p/${projectId}/issues`}>Open issues <ArrowUpRight /></Link>
      </div>

      {list.isPending && <div className="empty">Loading…</div>}
      {list.isError && <div className="empty">Failed to load API health: {list.error.message}</div>}

      {d && d.endpoints.length === 0 && (
        <div className="empty">
          No requests yet. API Health counts HTTP server spans sent to /otlp/v1/traces.
          <div style={{ marginTop: 12 }}><Link className="btn sm" to={`/p/${projectId}/settings`}>Settings</Link></div>
        </div>
      )}

      {d && d.endpoints.length > 0 && (
        <div style={{ opacity: list.isFetching && list.isPlaceholderData ? 0.6 : 1 }}>
          <div className="ihead health-grid">
            <span>Endpoint</span><span>Requests</span><span>5xx %</span><span>4xx</span><span>p50</span><span>p95</span><span>p99</span><span />
          </div>
          <div className="ilist">
            {sortEndpoints(d.endpoints, sort, d.threshold).map((e) => {
              const on = e.method === method && e.route === route;
              // Penanda baris: ada bucket melewati ambang, atau rasio keseluruhan melewati ambang (keduanya perlu request cukup).
              const hot = e.breaches > 0 || breaches(e.count, e.c5xx, d.threshold);
              const why = e.breaches > 0 ? breachTitle(e.breaches, d.bucketSeconds, d.threshold)
                : hot ? `5xx rate ${pct(e.errorRate)} is above the alert threshold (${d.threshold.pct}%)` : undefined;
              return (
                <div key={`${e.method} ${e.route}`} className={`irow health-grid ${on ? "on" : ""} ${hot ? "hot" : ""}`}
                  title={why}
                  onClick={() => setQuery(on ? { method: "", route: "", from: "", to: "" } : { method: e.method, route: e.route, from: "", to: "" })}>
                  <div className="row" style={{ gap: 8, minWidth: 0 }}>
                    <span className="tag">{e.method}</span>
                    <span className="mono ttl" style={{ fontSize: 13 }} title={e.route}>{e.route}</span>
                  </div>
                  <span className="v num">{fmt(e.count)}</span>
                  <span className="v num">
                    <span className={e.errorRate * 100 >= d.threshold.pct ? "health-bad" : ""}>{pct(e.errorRate)}</span>
                    {e.breaches > 0 && <span className="breach-badge">{breachLabel(e.breaches, d.bucketSeconds)}</span>}
                  </span>
                  <span className="num">{fmt(e.c4xx)}</span>
                  <span className="num">{fmtLatency(e.p50)}</span>
                  <span className="num">{fmtLatency(e.p95)}</span>
                  <span className="num">{fmtLatency(e.p99)}</span>
                  <Spark data={e.series} err={e.errSeries} hot={(n, c) => breaches(n, c, d.threshold)} title={(n) => `${fmt(n)} requests, per ${unit}`} />
                </div>
              );
            })}
          </div>
          <p className="sub" style={{ fontSize: 12, margin: "12px 0 0 8px" }}>Latency percentiles are approximate (bucket upper bounds).</p>

          {method && route && (
            <HealthDetail projectId={projectId!} range={range} threshold={d.threshold} method={method} route={route}
              win={win} onWindow={(w) => setQuery({ from: w ? String(w.from) : "", to: w ? String(w.to) : "" })}
              status={status} onStatus={(v) => setQuery({ status: v.length === 0 ? "all" : v.join(",") === "5xx" ? "" : v.join(",") })}
              page={page} size={size} onPage={(p) => setQuery({ page: p > 1 ? String(p) : "" })}
              onSize={(v) => setQuery({ size: v === DEFAULT_SIZE ? "" : String(v) })}
              onClose={() => setQuery({ method: "", route: "", from: "", to: "" })} />
          )}
        </div>
      )}
    </section>
  );
}

function HealthDetail({ projectId, range, threshold, method, route, win, onWindow, status, onStatus, onClose, page, size, onPage, onSize }: {
  projectId: string; range: Range; threshold: HealthThreshold; method: string; route: string;
  win: TimeWindow | null; onWindow: (w: TimeWindow | null) => void; status: ReqStatus; onStatus: (s: ReqStatus) => void; onClose: () => void;
  page: number; size: PageSize; onPage: (p: number) => void; onSize: (s: PageSize) => void;
}) {
  const q = useQuery({
    queryKey: ["health-endpoint", projectId, range, method, route],
    queryFn: () => api.get<{ bucketSeconds: number; series: HealthPoint[] }>(
      `/projects/${projectId}/health/endpoint?${new URLSearchParams({ method, route, range })}`),
    placeholderData: (prev) => prev,
    refetchInterval: 60_000,
  });
  const s = q.data?.series ?? [];
  // Rentang waktu (detik epoch) yang dipilih di grafik -> menyaring tabel request. Disimpan di URL (?from=&to=);
  // ganti endpoint/range menghapusnya (lihat setQuery di HealthPage).
  // Kartu detail ada di bawah tabel: gulir ke sana saat endpoint dipilih, supaya kliknya terlihat ada hasilnya.
  // Tunggu data grafik ada (kartu sudah setinggi aslinya), lalu gulir sekali per endpoint yang dipilih.
  const card = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef("");
  const loaded = Boolean(q.data);
  useEffect(() => {
    const key = `${method} ${route}`;
    if (!loaded || scrolledFor.current === key) return;
    scrolledFor.current = key;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    card.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  }, [method, route, loaded]);

  return (
    <div ref={card} className="card" style={{ marginTop: "var(--s5)", scrollMarginTop: 80 }}>
      <div className="head">
        <h2 className="row" style={{ gap: 8, minWidth: 0 }}><span className="tag">{method}</span><span className="mono" style={{ fontSize: 15 }}>{route}</span></h2>
        <a className="iconbtn sm" onClick={onClose} title="Close"><X /></a>
      </div>
      {q.isPending && <div className="sub">Loading…</div>}
      {q.isError && <div className="sub">Failed to load endpoint: {q.error.message}</div>}
      {q.data && (
        <>
          <TimeChart s={s} range={range} bucketSeconds={q.data.bucketSeconds} threshold={threshold} window={win} onSelect={onWindow} />
          <HealthRequests projectId={projectId} range={range} method={method} route={route} status={status} onStatus={onStatus}
            window={win} bucketSeconds={q.data.bucketSeconds} onClearWindow={() => onWindow(null)}
            page={page} size={size} onPage={onPage} onSize={onSize} />
        </>
      )}
    </div>
  );
}
