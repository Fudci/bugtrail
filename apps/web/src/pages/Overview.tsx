import { useQuery } from "@tanstack/react-query";
import { Activity, ArrowUpRight, Bug, Download, Users, X } from "lucide-react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { QuotaBanner } from "../components/QuotaBanner";
import { api, type IssueStatus, type Level } from "../api";
import { RangeTabs, rangeLabel, readRange, type RangeOption } from "../components/RangeTabs";

interface Totals { events: number; users: number; newIssues: number }
interface OverviewData {
  range: Range; bucket: "hour" | "day"; from: string; to: string;
  totals: Totals & { previous: Totals };
  series: { t: string; events: number }[];
  levels: { level: Level; events: number }[];
  topIssues: { id: string; title: string; culprit: string | null; level: Level; status: IssueStatus; events: number; users: number }[];
  platforms: { name: string; events: number }[];
  releases: string[];
  environments: string[];
}
type Range = "24h" | "7d" | "14d" | "30d";
const RANGES: RangeOption<Range>[] = [
  { key: "24h", label: "24 hours" }, { key: "7d", label: "7 days" }, { key: "14d", label: "14 days" }, { key: "30d", label: "30 days" },
];
const LEVEL_STYLE: Record<Level, string> = { error: "p-dark", fatal: "p-out", warning: "p-acc", info: "p-hatch", debug: "p-hatch" };

const fmt = (n: number) => n.toLocaleString("en-US");
const compact = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

function Delta({ now, prev }: { now: number; prev: number }) {
  if (prev === 0) return now > 0 ? <span className="tag">new</span> : null;
  const pct = Math.round(((now - prev) / prev) * 100);
  if (pct === 0) return <span className="tag">±0%</span>;
  // Untuk error, naik = buruk (merah), turun = baik.
  return <span className={`tag ${pct > 0 ? "err" : ""}`}>{pct > 0 ? "+" : ""}{pct}%</span>;
}

function bucketLabel(t: string, bucket: "hour" | "day", total: number, i: number) {
  if (bucket === "hour") return i % 4 === 0 ? `${t.slice(11, 13)}:00` : "";
  const d = new Date(`${t}T00:00:00Z`);
  const every = total > 16 ? 5 : total > 8 ? 2 : 1;
  return i % every === 0 || i === total - 1 ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "";
}

export function OverviewPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  // Nilai ?range= tak dikenal kembali ke 14 hari (sebelumnya diteruskan ke API dan dibalas 400).
  const range = readRange(params.get("range"), RANGES, "14d");
  const release = params.get("release") ?? "";
  const environment = params.get("environment") ?? "";
  const level = params.get("level") ?? "";
  const platform = params.get("platform") ?? "";
  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v); else next.delete(k);
    setParams(next, { replace: true });
  };

  const overview = useQuery({
    queryKey: ["overview", projectId, range, release, environment, level, platform],
    queryFn: () => {
      const qs = new URLSearchParams({ range, tz: String(-new Date().getTimezoneOffset()) });
      if (release) qs.set("release", release);
      if (environment) qs.set("environment", environment);
      if (level) qs.set("level", level);
      if (platform) qs.set("platform", platform);
      return api.get<OverviewData>(`/projects/${projectId}/overview?${qs}`);
    },
    placeholderData: (prev) => prev,
    refetchInterval: 60_000,
  });
  const d = overview.data;

  const exportQs = new URLSearchParams({ range });
  if (release) exportQs.set("release", release);
  if (environment) exportQs.set("environment", environment);
  if (level) exportQs.set("level", level);
  if (platform) exportQs.set("platform", platform);

  // Klik di overview membawa filter yang sama ke halaman Issues.
  const issuesLink = (extra: Record<string, string> = {}) => {
    const qs = new URLSearchParams({ status: "all", ...extra });
    if (release) qs.set("release", release);
    if (level) qs.set("level", level);
    return `/p/${projectId}/issues?${qs}`;
  };

  const max = Math.max(1, ...(d?.series.map((s) => s.events) ?? [0]));
  const peak = d?.series.reduce((a, s, i, arr) => (s.events > (arr[a]?.events ?? 0) ? i : a), 0) ?? -1;
  const levelTotal = d?.levels.reduce((a, l) => a + l.events, 0) ?? 0;
  const platformTotal = d?.platforms.reduce((a, p) => a + p.events, 0) ?? 0;
  const busiest = d?.topIssues[0];

  return (
    <section>
      <QuotaBanner />
      <div className="hero" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
        <div>
          <h1>Overview</h1>
          <p className="sub" style={{ marginTop: 8 }}>Errors in the last {rangeLabel(RANGES, range)}. Counts reflect events still retained.</p>
          {d && levelTotal > 0 && (
            <div style={{ marginTop: 24, maxWidth: 680 }}>
              <div className="seg-hint">
                Events by level · <span>{level ? "showing one level, click it again to clear" : "click a level to filter"}</span>
              </div>
              <div className="segbar">
                {d.levels.map((l) => {
                  const pct = Math.round((l.events / levelTotal) * 100);
                  const on = level === l.level;
                  return (
                    <div key={l.level} className="seg" style={{ flex: Math.max(l.events / levelTotal, on ? 0.3 : 0.14), minWidth: on ? 150 : 0 }}>
                      <span className="lbl" style={{ textTransform: "capitalize" }}>{l.level}</span>
                      <button type="button" className={`pill seg-btn ${LEVEL_STYLE[l.level]} ${on ? "on" : level ? "dim" : ""}`}
                        onClick={() => setParam("level", on ? "" : l.level)}
                        title={on ? "Clear level filter" : `Show only ${l.level} (${fmt(l.events)} events)`}>
                        <span className="num">{pct}%</span><span className="seg-n num">· {fmt(l.events)}</span>
                        {on && <span className="chip-x"><X /></span>}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        {d && (
          <div className="bigstats">
            <div className="bigstat"><span className="l"><Activity />Events<Delta now={d.totals.events} prev={d.totals.previous.events} /></span><span className="n num">{compact(d.totals.events)}</span></div>
            <div className="bigstat"><span className="l"><Bug />New issues<Delta now={d.totals.newIssues} prev={d.totals.previous.newIssues} /></span><span className="n num">{fmt(d.totals.newIssues)}</span></div>
            <div className="bigstat"><span className="l"><Users />Users<Delta now={d.totals.users} prev={d.totals.previous.users} /></span><span className="n num">{compact(d.totals.users)}</span></div>
          </div>
        )}
      </div>

      <div className="row" style={{ marginBottom: "var(--s5)", flexWrap: "wrap" }}>
        <RangeTabs ranges={RANGES} value={range} onPick={(k) => setParam("range", k === "14d" ? "" : k)} />
        <select className="select" value={release} onChange={(e) => setParam("release", e.target.value)}>
          <option value="">All releases</option>
          {d?.releases.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <select className="select" value={environment} onChange={(e) => setParam("environment", e.target.value)}>
          <option value="">All environments</option>
          {d?.environments.map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
        <select className="select" value={level} onChange={(e) => setParam("level", e.target.value)}>
          <option value="">All levels</option>
          {(["fatal", "error", "warning", "info", "debug"] as const).map((l) => <option key={l} value={l} style={{ textTransform: "capitalize" }}>{l}</option>)}
        </select>
        <a className="btn sm" href={`/api/0/projects/${projectId}/overview/export?${exportQs}`} download>
          <Download />Export CSV
        </a>
        {platform && (
          <span className="tag acc filter-chip">platform: {platform}
            <button type="button" className="chip-x" onClick={() => setParam("platform", "")} aria-label="Clear platform filter"><X /></button>
          </span>
        )}
        {(release || environment || level || platform) && (
          <a className="btn sm" onClick={() => setParams(range === "14d" ? {} : { range }, { replace: true })}>Clear filters</a>
        )}
      </div>

      {overview.isPending && <div className="empty">Loading…</div>}
      {overview.isError && <div className="empty">Failed to load overview: {overview.error.message}</div>}

      {d && (
        <div className="grid overview-grid" style={{ opacity: overview.isFetching && overview.isPlaceholderData ? 0.6 : 1 }}>
          <div className="card dark" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", minHeight: 340 }}>
            {busiest ? (
              <>
                <div className="row between">
                  <span className="tag err" style={{ background: "rgba(229,72,77,.18)" }}>● {busiest.level}{busiest.status !== "unresolved" ? ` · ${busiest.status}` : ""}</span>
                  <a className="iconbtn sm" style={{ background: "rgba(255,255,255,.08)", color: "#fff" }} onClick={() => navigate(`/p/${projectId}/issues/${busiest.id}`)} title="Open issue"><ArrowUpRight /></a>
                </div>
                <div>
                  <div style={{ color: "#8f8c83", fontSize: 13, marginBottom: 6 }}>Busiest issue</div>
                  <div style={{ fontSize: 22, fontWeight: 300, letterSpacing: "-.02em", lineHeight: 1.3, overflowWrap: "anywhere" }}>{busiest.title}</div>
                  {busiest.culprit && <div className="mono" style={{ color: "#8f8c83", fontSize: 12, marginTop: 8 }}>{busiest.culprit}</div>}
                </div>
                <div className="row between">
                  <span style={{ color: "#a8a59c", fontSize: 13 }}>{fmt(busiest.users)} {busiest.users === 1 ? "user" : "users"} affected</span>
                  <span className="btn acc sm">{fmt(busiest.events)} events</span>
                </div>
              </>
            ) : <div style={{ color: "#8f8c83", margin: "auto" }}>No errors in this period 🎉</div>}
          </div>

          <div className="card" style={{ gridColumn: "span 2" }}>
            <div className="head">
              <h2>Events</h2>
              <a className="iconbtn sm" onClick={() => navigate(issuesLink())} title="Open issues"><ArrowUpRight /></a>
            </div>
            <div className="row" style={{ alignItems: "flex-end", gap: 12 }}>
              <span style={{ fontSize: 44, fontWeight: 300, letterSpacing: "-.03em", lineHeight: 1 }}>{compact(d.totals.events)}</span>
              <span className="sub" style={{ fontSize: 13, lineHeight: 1.3 }}>events<br />per {d.bucket}, peak {fmt(d.series[peak]?.events ?? 0)}</span>
            </div>
            <div className="bars">
              {d.series.map((s, i) => (
                <div key={s.t} className={`bar ${s.events === 0 ? "ghost" : i === peak ? "peak" : ""}`} title={`${s.t}: ${fmt(s.events)} events`}>
                  {i === peak && s.events > 0 && <span className="tip">{fmt(s.events)}</span>}
                  <i style={{ height: `${s.events === 0 ? 20 : Math.max(6, (s.events / max) * 100)}%` }} />
                  <b />
                  <span>{bucketLabel(s.t, d.bucket, d.series.length, i)}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="head"><h2>Platforms</h2><span style={{ fontSize: 32, fontWeight: 300, letterSpacing: "-.03em" }}>{d.platforms.length}</span></div>
            {d.platforms.length === 0 ? <div className="sub">No data.</div> : (
              <>
                <div className="seg-hint" style={{ paddingLeft: 0 }}><span>{platform ? "click again to clear" : "click a platform to filter"}</span></div>
                <div className="grid" style={{ gap: 4 }}>
                  {d.platforms.map((p, i) => {
                    const pct = Math.round((p.events / platformTotal) * 100);
                    const on = platform === p.name;
                    return (
                      <button key={p.name} type="button" className={`plat-row ${on ? "on" : platform ? "dim" : ""}`}
                        onClick={() => setParam("platform", on ? "" : p.name)}
                        title={on ? "Clear platform filter" : `Show only ${p.name} (${fmt(p.events)} events)`}>
                        <span className="row between" style={{ fontSize: 13, marginBottom: 6 }}>
                          <span>{p.name}</span>
                          <span className="row" style={{ gap: 8 }}>
                            <span className="sub num">{pct}% · {fmt(p.events)}</span>
                            {on && <span className="chip-x"><X /></span>}
                          </span>
                        </span>
                        <span className="plat-track">
                          <span className={i === 0 ? "p-acc" : "p-dark"} style={{ width: `${Math.max(pct, 2)}%` }} />
                        </span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          <div className="card" style={{ gridColumn: "1 / -1" }}>
            <div className="head">
              <h2>Top issues</h2>
              <a className="btn sm" onClick={() => navigate(issuesLink())}>All issues <ArrowUpRight /></a>
            </div>
            {d.topIssues.length === 0 ? <div className="sub">No errors in this period.</div> : (
              <div className="ilist">
                {d.topIssues.map((t) => (
                  <div key={t.id} className="irow top-grid" onClick={() => navigate(`/p/${projectId}/issues/${t.id}`)}>
                    <span className={`lv ${t.level}`} />
                    <div style={{ minWidth: 0 }}>
                      <div className="ttl">{t.title}</div>
                      <div className="meta">{t.culprit && <span className="mono">{t.culprit}</span>}{t.status !== "unresolved" && <span className="tag">{t.status}</span>}</div>
                    </div>
                    <span><div className="k">users</div><div className="v num">{fmt(t.users)}</div></span>
                    <span><div className="k">events</div><div className="v num">{fmt(t.events)}</div></span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
