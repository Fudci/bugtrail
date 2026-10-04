import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { BatteryCharging, Battery, ShieldCheck, Wifi, WifiOff } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import { api, type EventDetail } from "../api";
import { formatDate, timeAgo } from "../hooks";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const s = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : undefined);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const ctxOf = (p: Obj, key: string): Obj => (isObj(p["contexts"]) && isObj(p["contexts"][key]) ? p["contexts"][key] : {});

export const fmtBytes = (b: number) =>
  b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(0)} MB` : `${(b / 1024).toFixed(0)} KB`;

// "374 GB kosong dari 516 GB (terpakai 28%)"
function capacity(free?: number, total?: number): ReactNode | undefined {
  if (total == null && free == null) return undefined;
  if (total == null) return `${fmtBytes(free!)} free`;
  if (free == null) return `${fmtBytes(total)} total`;
  const used = Math.round(((total - free) / total) * 100);
  return (
    <span>
      {fmtBytes(free)} free of {fmtBytes(total)}{" "}
      <span style={{ color: used >= 90 ? "var(--red)" : "#8f8c83" }}>({used}% used)</span>
    </span>
  );
}

const yes = (v: unknown) => v === true || v === "true" || v === 1;

/** Konteks event: device, storage, RAM, jaringan, baterai, OS, app. Field yang tidak dikirim SDK disembunyikan. */
export function EventContext({ event }: { event: EventDetail }) {
  const p = event.payload;
  const device = ctxOf(p, "device");
  const os = ctxOf(p, "os");
  const app = ctxOf(p, "app");
  const browser = ctxOf(p, "browser");
  const rn = ctxOf(p, "react_native_context");
  const user = isObj(p["user"]) ? p["user"] : {};

  const online = device["online"];
  const connection = s(device["connection_type"]);
  const battery = num(device["battery_level"]);
  const lowMem = yes(device["low_memory"]);

  const rows: [string, ReactNode | undefined][] = [
    ["Device", [s(device["manufacturer"]) ?? s(device["brand"]), s(device["model"])].filter(Boolean).join(" ") || undefined],
    ["OS", [s(os["name"]), s(os["version"])].filter(Boolean).join(" ") + (yes(os["rooted"]) ? " · ROOT" : "") || undefined],
    ["Browser", [s(browser["name"]), s(browser["version"])].filter(Boolean).join(" ") || undefined],
    ["Storage", capacity(num(device["free_storage"]), num(device["storage_size"]))],
    ["RAM", device["memory_size"] != null || device["free_memory"] != null ? (
      <span>{capacity(num(device["free_memory"]), num(device["memory_size"]))}{lowMem && <span style={{ color: "var(--red)" }}> · LOW MEMORY</span>}</span>
    ) : undefined],
    ["Internet", online == null && !connection ? undefined : (
      <span className="row" style={{ gap: 6 }}>
        {online === false ? <WifiOff style={{ width: 14, color: "var(--red)" }} /> : <Wifi style={{ width: 14, color: "var(--accent)" }} />}
        {online === false ? "offline" : online === true ? "online" : "?"}
        {connection && ` · ${connection}`}
      </span>
    )],
    ["Battery", battery == null ? undefined : (
      <span className="row" style={{ gap: 6 }}>
        {yes(device["charging"]) ? <BatteryCharging style={{ width: 14 }} /> : <Battery style={{ width: 14, color: battery <= 15 ? "var(--red)" : undefined }} />}
        {Math.round(battery)}%{yes(device["charging"]) && " · charging"}
      </span>
    )],
    ["Orientation", s(device["orientation"])],
    ["App", [s(app["app_version"]), s(app["app_build"]) && `(${s(app["app_build"])})`].filter(Boolean).join(" ") || undefined],
    ["App state", app["in_foreground"] == null ? undefined : yes(app["in_foreground"]) ? "foreground" : "background"],
    ["Release", event.release ?? undefined],
    ["Env", event.environment ?? undefined],
    ["JS engine", s(rn["js_engine"]) ? `${s(rn["js_engine"])}${s(rn["react_native_version"]) ? ` · RN ${s(rn["react_native_version"])}` : ""}` : undefined],
    ["User", [s(user["username"]) ?? s(user["email"]), s(user["id"])].filter(Boolean).join(" · ") || undefined],
    ["SDK", isObj(p["sdk"]) ? [s(p["sdk"]["name"]), s(p["sdk"]["version"])].filter(Boolean).join(" ") : undefined],
    ["Time", formatDate(event.timestamp)],
  ];
  return (
    <dl className="kv">
      {rows.filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => (<Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>))}
    </dl>
  );
}

// Izin yang biasanya berpengaruh ke perilaku app ditampilkan duluan.
const IMPORTANT = ["ACCESS_FINE_LOCATION", "ACCESS_COARSE_LOCATION", "ACCESS_BACKGROUND_LOCATION", "CAMERA", "RECORD_AUDIO",
  "POST_NOTIFICATIONS", "READ_MEDIA_IMAGES", "READ_EXTERNAL_STORAGE", "WRITE_EXTERNAL_STORAGE", "BLUETOOTH_CONNECT", "READ_CONTACTS", "SCHEDULE_EXACT_ALARM"];

/** Izin aplikasi (contexts.app.permissions: { NAMA: "granted" | "not_granted" }). */
export function Permissions({ event }: { event: EventDetail }) {
  const [all, setAll] = useState(false);
  const perms = ctxOf(event.payload, "app")["permissions"];
  if (!isObj(perms) || Object.keys(perms).length === 0) return null;
  const entries = Object.entries(perms).map(([k, v]) => ({ name: k, granted: v === "granted" }));
  entries.sort((a, b) => {
    const ia = IMPORTANT.indexOf(a.name), ib = IMPORTANT.indexOf(b.name);
    if ((ia >= 0) !== (ib >= 0)) return ia >= 0 ? -1 : 1;
    if (a.granted !== b.granted) return a.granted ? 1 : -1; // yang ditolak duluan
    return a.name.localeCompare(b.name);
  });
  const denied = entries.filter((e) => !e.granted).length;
  const shown = all ? entries : entries.slice(0, 8);
  return (
    <div className="card">
      <div className="head">
        <h2 className="row" style={{ gap: 8 }}><ShieldCheck style={{ width: 20 }} />App permissions</h2>
        <span className="sub" style={{ fontSize: 12 }}>{denied} denied · {entries.length - denied} granted</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {shown.map((e) => (
          <span key={e.name} className={`tag ${e.granted ? "" : "err"}`} title={e.granted ? "granted" : "not granted"}>
            {e.granted ? "✓" : "✕"} {e.name.replace(/^android\.permission\./, "")}
          </span>
        ))}
      </div>
      {entries.length > 8 && <a className="sub" style={{ fontSize: 12, display: "inline-block", marginTop: 10 }} onClick={() => setAll(!all)}>{all ? "Show less" : `Show all ${entries.length}`}</a>}
    </div>
  );
}

export function Tags({ event }: { event: EventDetail }) {
  const tags = event.payload["tags"];
  const list: [string, string][] = Array.isArray(tags)
    ? tags.filter((t): t is [string, string] => Array.isArray(t) && t.length === 2).map(([k, v]) => [String(k), String(v)])
    : isObj(tags) ? Object.entries(tags).map(([k, v]) => [k, String(v)]) : [];
  if (list.length === 0) return null;
  return (
    <div className="card">
      <div className="head"><h2>Tags</h2></div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {list.map(([k, v]) => (
          <span key={k} className="tag mono" style={{ height: "auto", padding: "4px 10px", whiteSpace: "normal" }}>
            <span className="sub">{k}:</span>&nbsp;{v}
          </span>
        ))}
      </div>
    </div>
  );
}

interface AffectedUser { userId: string; events: number; lastSeen: string; lastEventId: string }

export function AffectedUsers({ issueId, currentEventId, onOpen }: { issueId: string; currentEventId?: string | undefined; onOpen: (eventId: string) => void }) {
  const users = useQuery({ queryKey: ["issue-users", issueId], queryFn: () => api.get<AffectedUser[]>(`/issues/${issueId}/users`) });
  if (!users.data || users.data.length === 0) return null;
  return (
    <div className="card">
      <div className="head">
        <h2>Affected users</h2>
        <span className="sub" style={{ fontSize: 12 }}>{users.data.length}{users.data.length === 100 ? "+" : ""} {users.data.length === 1 ? "user" : "users"}</span>
      </div>
      {users.data.map((u) => (
        <a key={u.userId} className="acc-it row between mono" style={{ padding: "9px 0", fontSize: 12, gap: 10, fontWeight: u.lastEventId === currentEventId ? 600 : 400 }}
          onClick={() => onOpen(u.lastEventId)} title="Open this user's latest event">
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.userId}</span>
          <span className="sub" style={{ flexShrink: 0 }}>{u.events}× · {timeAgo(u.lastSeen)}</span>
        </a>
      ))}
    </div>
  );
}

interface EventRow {
  id: string; receivedAt: string; release: string | null; userId: string | null;
  device: string | null; os: string | null; online: boolean | null; connection: string | null;
}

export function EventsList({ issueId, currentEventId, onOpen }: { issueId: string; currentEventId?: string | undefined; onOpen: (eventId: string) => void }) {
  const events = useInfiniteQuery({
    queryKey: ["issue-events", issueId],
    queryFn: ({ pageParam }) => api.get<{ events: EventRow[]; nextCursor: string | null }>(
      `/issues/${issueId}/events?limit=25${pageParam ? `&cursor=${pageParam}` : ""}`),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = events.data?.pages.flatMap((p) => p.events) ?? [];
  if (events.isPending) return <p className="sub">Loading…</p>;
  return (
    <div>
      {rows.map((ev) => (
        <div key={ev.id} className="frame" onClick={() => onOpen(ev.id)}
          style={{ cursor: "pointer", display: "grid", gridTemplateColumns: "120px 1fr auto", gap: 12, alignItems: "center", fontFamily: "inherit",
            outline: ev.id === currentEventId ? "2px solid var(--sel)" : undefined }}>
          <span className="mono" style={{ fontSize: 12 }}>{formatDate(ev.receivedAt)}</span>
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13 }}>
            <b className="mono" style={{ fontWeight: 500 }}>{ev.userId ?? "—"}</b>
            <span className="sub"> · {[ev.device, ev.os, ev.release].filter(Boolean).join(" · ")}</span>
          </span>
          <span className="sub row" style={{ gap: 4, fontSize: 12 }}>
            {ev.online === false ? <><WifiOff style={{ width: 13, color: "var(--red)" }} />offline</> : ev.online ? <><Wifi style={{ width: 13 }} />{ev.connection ?? "online"}</> : null}
          </span>
        </div>
      ))}
      {events.hasNextPage && (
        <button className="btn sm" onClick={() => events.fetchNextPage()} disabled={events.isFetchingNextPage}>{events.isFetchingNextPage ? "Loading…" : "Load more"}</button>
      )}
      <p className="sub" style={{ fontSize: 12, marginTop: 8 }}>Events removed by retention are not shown.</p>
    </div>
  );
}
