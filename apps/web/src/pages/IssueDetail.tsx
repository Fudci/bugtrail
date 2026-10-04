import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, ArrowLeft, BellOff, Check, Clock, ClockAlert, RotateCcw, Trash2, Users } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { AffectedUsers, EventContext, EventsList, Permissions, Tags } from "./EventPanels";
import { api, type EventDetail, type IssueDetail, type IssueStatus, type Member } from "../api";
import { formatDate, initial } from "../hooks";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const s = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : undefined);

interface Frame { filename?: string; function?: string; lineno?: number; in_app?: boolean; context_line?: string; pre_context?: string[]; post_context?: string[] }

function exceptionsOf(payload: Obj) {
  const exc = payload["exception"];
  const values = isObj(exc) ? exc["values"] : exc;
  if (!Array.isArray(values)) return [];
  return values.filter(isObj).map((v) => ({
    type: s(v["type"]),
    value: s(v["value"]),
    // Sentry: frame terakhir = paling dalam; tampilkan dari yang paling dalam.
    frames: ((isObj(v["stacktrace"]) && Array.isArray(v["stacktrace"]["frames"]) ? v["stacktrace"]["frames"] : []) as Frame[]).slice().reverse(),
  }));
}

// Ganti stacktrace dengan raw_stacktrace (versi minify sebelum diterjemahkan source map).
function withRawStacktrace(payload: Obj): Obj {
  const exc = payload["exception"];
  const values = isObj(exc) ? exc["values"] : exc;
  if (!Array.isArray(values)) return payload;
  return {
    ...payload,
    exception: { values: values.map((v) => (isObj(v) && isObj(v["raw_stacktrace"]) ? { ...v, stacktrace: v["raw_stacktrace"] } : v)) },
  };
}

const hasRawStacktrace = (payload: Obj) => {
  const exc = payload["exception"];
  const values = isObj(exc) ? exc["values"] : exc;
  return Array.isArray(values) && values.some((v) => isObj(v) && isObj(v["raw_stacktrace"]));
};

// Path lengkap dari mesin build (mis. /Users/x/proj/node_modules/...) dipendekkan untuk tampilan.
const shortPath = (p: string | undefined) => p?.replace(/^.*?\/((?:node_modules|src|app|lib)\/)/, "$1");

function FrameView({ f }: { f: Frame }) {
  const pre = f.pre_context ?? [];
  const start = (f.lineno ?? 0) - pre.length;
  return (
    <div className="frame">
      <div>
        <span title={f.filename}>{shortPath(f.filename) ?? "?"}</span>{f.lineno ? `:${f.lineno}` : ""} <span className="fn">{f.function}</span>{" "}
        {f.in_app && <span className="tag" style={{ height: 20 }}>app</span>}
      </div>
      {f.context_line !== undefined && (
        <pre>
          {pre.map((l, i) => <span key={`a${i}`}>{String(start + i).padEnd(5)}{l}</span>)}
          <span className="hl">{String(f.lineno).padEnd(5)}{f.context_line}</span>
          {(f.post_context ?? []).map((l, i) => <span key={`b${i}`}>{String((f.lineno ?? 0) + i + 1).padEnd(5)}{l}</span>)}
        </pre>
      )}
    </div>
  );
}

function Stacktrace({ payload, raw = false }: { payload: Obj; raw?: boolean }) {
  const [showAll, setShowAll] = useState(false);
  const excs = exceptionsOf(raw ? withRawStacktrace(payload) : payload);
  if (excs.length === 0) {
    const msg = isObj(payload["logentry"]) ? s(payload["logentry"]["formatted"]) ?? s(payload["logentry"]["message"]) : s(payload["message"]);
    return <div className="frame">{msg ?? "No stacktrace."}</div>;
  }
  return (
    <>
      {excs.slice().reverse().map((x, i) => {
        const app = x.frames.filter((f) => f.in_app);
        const shown = showAll || app.length === 0 ? x.frames : app;
        const hidden = x.frames.length - shown.length;
        return (
          <div key={i} style={{ marginBottom: 16 }}>
            {excs.length > 1 && <p className="lbl2">{x.type}: {x.value}</p>}
            {shown.map((f, j) => <FrameView key={j} f={f} />)}
            {hidden > 0 && <div className="frame fn" style={{ cursor: "pointer" }} onClick={() => setShowAll(true)}>+ {hidden} library frames</div>}
          </div>
        );
      })}
    </>
  );
}

function Breadcrumbs({ payload }: { payload: Obj }) {
  const bc = payload["breadcrumbs"];
  const list = (isObj(bc) ? bc["values"] : bc) as unknown;
  const items = Array.isArray(list) ? list.filter(isObj).slice(-30) : [];
  if (items.length === 0) return <p className="sub" style={{ fontSize: 13 }}>No breadcrumbs.</p>;
  return (
    <>
      {items.map((b, i) => {
        const ts = b["timestamp"];
        const d = typeof ts === "number" ? new Date(ts * 1000) : typeof ts === "string" ? new Date(ts) : null;
        const isErr = b["level"] === "error" || b["level"] === "fatal";
        return (
          <div key={i} className="acc-it" style={{ padding: "10px 0" }}>
            <div className="row between mono" style={{ fontSize: 12, gap: 12 }}>
              <span style={{ color: isErr ? "var(--red)" : undefined, overflow: "hidden", textOverflow: "ellipsis" }}>
                {[s(b["category"]), s(b["message"])].filter(Boolean).join(" → ") || s(b["type"])}
              </span>
              <span className="sub" style={{ flexShrink: 0 }}>{d && !Number.isNaN(d.getTime()) ? d.toLocaleTimeString("en-US") : ""}</span>
            </div>
          </div>
        );
      })}
    </>
  );
}

export function IssueDetailPage() {
  const { projectId, issueId } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [tab, setTab] = useState<"stack" | "minified" | "events" | "raw">("stack");
  const issue = useQuery({ queryKey: ["issue", issueId], queryFn: () => api.get<IssueDetail>(`/issues/${issueId}`) });
  // Event yang sedang dilihat ada di URL (?event=...) supaya bisa dibagikan; kosong = event terbaru.
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("event");
  const selected = useQuery({
    queryKey: ["event", issueId, selectedId],
    queryFn: () => api.get<{ event: EventDetail; sourcemapsMissing: string[] }>(`/issues/${issueId}/events/${selectedId}`),
    enabled: Boolean(selectedId),
  });
  const openEvent = (eventId: string) => {
    setParams((p) => { const n = new URLSearchParams(p); n.set("event", eventId); return n; });
    setTab("stack");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const members = useQuery({
    queryKey: ["members", projectId],
    queryFn: () => api.get<{ members: Member[] }>(`/projects/${projectId}/members`),
  });

  const update = useMutation({
    mutationFn: (body: { status?: IssueStatus; assigneeId?: string | null }) => api.patch(`/issues/${issueId}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["issue", issueId] });
      qc.invalidateQueries({ queryKey: ["issues", projectId] });
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });

  const remove = useMutation({
    mutationFn: () => api.del(`/issues/${issueId}`),
    onSuccess: () => {
      qc.removeQueries({ queryKey: ["issue", issueId] });
      qc.invalidateQueries({ queryKey: ["issues", projectId] });
      qc.invalidateQueries({ queryKey: ["projects"] });
      navigate(`/p/${projectId}/issues`, { replace: true });
    },
  });

  if (issue.isPending) return <div className="empty">Loading…</div>;
  if (issue.isError) return <div className="empty">Issue not found.</div>;
  const i = issue.data;
  const canEdit = i.role !== "viewer";
  const e = selectedId ? selected.data?.event ?? null : i.latestEvent;
  const sourcemapsMissing = selectedId ? selected.data?.sourcemapsMissing ?? [] : i.sourcemapsMissing;

  return (
    <section>
      <Link to={`/p/${projectId}/issues`} className="btn sm" style={{ marginBottom: "var(--s4)" }}><ArrowLeft />Issues</Link>
      <div className="hero" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ maxWidth: 820, minWidth: 0 }}>
          <div className="row" style={{ marginBottom: 14 }}>
            <span className={`tag ${i.level === "error" || i.level === "fatal" ? "err" : ""}`}>● {i.level}</span>
            {i.status !== "unresolved" && <span className="tag acc">{i.status}</span>}
          </div>
          <h1 style={{ fontSize: 38, overflowWrap: "anywhere" }}>{i.title}</h1>
          {i.culprit && <p className="mono sub" style={{ marginTop: 10, fontSize: 13 }} title={i.culprit}>{shortPath(i.culprit)}</p>}
        </div>
        {canEdit && (
          <div className="row">
            {i.status === "unresolved" ? (
              <>
                <button className="btn dark" disabled={update.isPending} onClick={() => update.mutate({ status: "resolved" })}><Check />Resolve</button>
                <button className="btn" disabled={update.isPending} onClick={() => update.mutate({ status: "ignored" })}><BellOff />Ignore</button>
              </>
            ) : (
              <button className="btn" disabled={update.isPending} onClick={() => update.mutate({ status: "unresolved" })}><RotateCcw />Reopen</button>
            )}
            <label className="btn" style={{ paddingLeft: 10 }}>
              <span className={`who ${i.assignee ? "" : "none"}`} style={{ width: 26, height: 26, fontSize: 11 }}>{i.assignee ? initial(i.assignee.name ?? i.assignee.email) : ""}</span>
              <select
                value={i.assignee?.id ?? ""}
                onChange={(ev) => update.mutate({ assigneeId: ev.target.value || null })}
                style={{ cursor: "pointer" }}
              >
                <option value="">Unassigned</option>
                {members.data?.members.map((m) => <option key={m.id} value={m.id}>{m.name ?? m.email}</option>)}
              </select>
            </label>
            {i.role === "admin" && (
              <button className="btn" title="Delete issue" disabled={remove.isPending}
                onClick={() => confirm(`Permanently delete this issue and its ${i.eventCount.toLocaleString("en-US")} ${i.eventCount === 1 ? "event" : "events"}?`) && remove.mutate()}>
                <Trash2 style={{ color: "var(--red)" }} />
              </button>
            )}
          </div>
        )}
      </div>
      {remove.isError && <p className="err-msg" style={{ marginTop: -20, marginBottom: 20 }}>{remove.error.message}</p>}
      {update.isError && <p className="err-msg" style={{ marginTop: -20, marginBottom: 20 }}>{update.error.message}</p>}

      <div className="bigstats" style={{ marginBottom: "var(--s6)", flexWrap: "wrap" }}>
        <div className="bigstat"><span className="l"><Activity />Events</span><span className="n num">{i.eventCount.toLocaleString("en-US")}</span></div>
        <div className="bigstat"><span className="l"><Users />Users</span><span className="n num">{i.userCount.toLocaleString("en-US")}</span></div>
        <div className="bigstat"><span className="l"><Clock />First seen<span className="mono" style={{ fontSize: 12 }}>{formatDate(i.firstSeen)}</span></span></div>
        <div className="bigstat"><span className="l"><ClockAlert />Last seen<span className="mono" style={{ fontSize: 12 }}>{formatDate(i.lastSeen)}{e?.release ? ` · ${e.release}` : ""}</span></span></div>
      </div>

      <div className="grid detail-grid">
        <div className="card" style={{ minWidth: 0 }}>
          <div className="head">
            <div className="ptabs">
              <a className={tab === "stack" ? "on" : ""} onClick={() => setTab("stack")}>Stacktrace</a>
              {e && hasRawStacktrace(e.payload) && <a className={tab === "minified" ? "on" : ""} onClick={() => setTab("minified")}>Minified</a>}
              <a className={tab === "events" ? "on" : ""} onClick={() => setTab("events")}>Events {i.eventCount.toLocaleString("en-US")}</a>
              <a className={tab === "raw" ? "on" : ""} onClick={() => setTab("raw")}>JSON</a>
            </div>
            {e && (
              <span className="sub mono row" style={{ fontSize: 12, gap: 8 }}>
                event {e.id.slice(0, 8)}{selectedId ? "" : " (latest)"}
                {selectedId && <a onClick={() => setParams((p) => { const n = new URLSearchParams(p); n.delete("event"); return n; })} style={{ textDecoration: "underline" }}>go to latest</a>}
              </span>
            )}
          </div>
          {selectedId && selected.isError && <p className="err-msg">{selected.error.message}</p>}
          {sourcemapsMissing.length > 0 && tab !== "events" && (
            <div className="frame" style={{ background: "rgba(244,207,79,.35)", fontFamily: "inherit", fontSize: 13 }}>
              <b>Source map not uploaded</b> for debug ID <span className="mono">{sourcemapsMissing.slice(0, 2).join(", ")}</span>
              {sourcemapsMissing.length > 2 && ` +${sourcemapsMissing.length - 2}`}. The stacktrace is still minified —
              upload it with <span className="mono">sentry-cli sourcemaps upload</span> (see Settings → Source maps).
            </div>
          )}
          {tab === "events" ? <EventsList issueId={i.id} currentEventId={e?.id} onOpen={openEvent} /> :
            !e ? <p className="sub">{selectedId && selected.isPending ? "Loading…" : "No events yet."}</p> : tab === "stack" ? <Stacktrace payload={e.payload} /> : tab === "minified" ? <Stacktrace payload={e.payload} raw /> : (
            <pre className="code" style={{ maxHeight: 600 }}>{JSON.stringify(e.payload, null, 2)}</pre>
          )}
        </div>
        <div className="grid" style={{ alignContent: "start", minWidth: 0 }}>
          <div className="card dark">
            <div className="head"><h2 style={{ color: "#f1efe8" }}>Context</h2></div>
            {e && <EventContext event={e} />}
          </div>
          {e && <Permissions event={e} />}
          {e && <Tags event={e} />}
          <AffectedUsers issueId={i.id} currentEventId={e?.id} onOpen={openEvent} />
          <div className="card">
            <div className="head"><h2>Breadcrumbs</h2></div>
            {e && <Breadcrumbs payload={e.payload} />}
          </div>
        </div>
      </div>
    </section>
  );
}
