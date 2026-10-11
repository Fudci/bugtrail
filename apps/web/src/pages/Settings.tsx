import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Copy, Database, FileCode2, KeyRound, Mail, Plus, Send, Trash2, TriangleAlert, UserPlus, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { api, type ArtifactList, type Invite, type Member, type ProjectDetail, type ProjectStats, type ProjectUsage, type Role, type UploadToken } from "../api";
import { formatDate, initial, personName, useMe, useProject } from "../hooks";
import { AlertRules } from "../components/AlertRules";

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="btn sm" onClick={async () => { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); }}>
      <Copy />{done ? "Copied" : "Copy"}
    </button>
  );
}

function InviteForm({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const invite = useMutation({
    mutationFn: () => api.post<Invite & { link: string }>(`/projects/${projectId}/invites`, { email, role }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["members", projectId] }),
  });
  const submit = (e: FormEvent) => { e.preventDefault(); invite.mutate(); };

  if (invite.data) {
    return (
      <div style={{ marginBottom: 16 }}>
        <p style={{ fontSize: 13, marginBottom: 8 }}>
          Send this link to {invite.data.email ? <b>{invite.data.email}</b> : "the person you're inviting"} (WhatsApp, Slack…). They choose their own
          username and password. The link works once, is shown only once and expires in 7 days.
        </p>
        <label className="field" style={{ background: "var(--dark-2)" }}>
          <input className="mono" style={{ fontSize: 12 }} value={invite.data.link} readOnly onFocus={(e) => e.target.select()} />
          <CopyButton text={invite.data.link} />
        </label>
        <button className="btn sm" style={{ marginTop: 10 }} onClick={onDone}>Done</button>
      </div>
    );
  }
  return (
    <form onSubmit={submit} style={{ marginBottom: 16 }}>
      <div className="row" style={{ gap: 8 }}>
        <label className="field" style={{ flex: 1, height: 44, color: "var(--ink)" }}><Mail /><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email (optional)" /></label>
        <select className="select" style={{ color: "var(--ink)" }} value={role} onChange={(e) => setRole(e.target.value as Role)}>
          <option value="member">member</option>
          <option value="viewer">viewer</option>
          <option value="admin">admin</option>
        </select>
      </div>
      {invite.isError && <p className="err-msg">{invite.error.message}</p>}
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn acc sm" disabled={invite.isPending}>Create invite link</button>
        <button type="button" className="btn sm" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

const fmtBytes = (b: number) =>
  b < 1024 ** 2 ? `${(b / 1024).toFixed(0)} KB` : b < 1024 ** 3 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${(b / 1024 ** 3).toFixed(2)} GB`;

function RetentionCard({ project }: { project: ProjectDetail }) {
  const qc = useQueryClient();
  const [maxEvents, setMaxEvents] = useState(String(project.retentionMaxEvents));
  const [days, setDays] = useState(String(project.retentionDays));
  const [slowOn, setSlowOn] = useState(project.slowTraceMs != null);
  const [slowMs, setSlowMs] = useState(String(project.slowTraceMs ?? 1000));
  useEffect(() => {
    setMaxEvents(String(project.retentionMaxEvents));
    setDays(String(project.retentionDays));
    setSlowOn(project.slowTraceMs != null);
    setSlowMs(String(project.slowTraceMs ?? 1000));
  }, [project.retentionMaxEvents, project.retentionDays, project.slowTraceMs]);
  const stats = useQuery({ queryKey: ["stats", project.id], queryFn: () => api.get<ProjectStats>(`/projects/${project.id}/stats`) });
  const save = useMutation({
    mutationFn: () => api.patch(`/projects/${project.id}/settings`, {
      retentionMaxEvents: Number(maxEvents), retentionDays: Number(days), slowTraceMs: slowOn ? Number(slowMs) : null,
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project", project.id] }),
  });
  const slowValue = slowOn ? Number(slowMs) : null;
  const dirty = maxEvents !== String(project.retentionMaxEvents) || days !== String(project.retentionDays) || slowValue !== (project.slowTraceMs ?? null);

  return (
    <div className="acc-it">
      <div className="h">Data retention</div>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", marginTop: 14 }}>
          <div><p className="lbl2">Max events stored</p>
            <label className="field"><input type="number" min={100} max={10000000} required value={maxEvents} onChange={(e) => setMaxEvents(e.target.value)} /></label></div>
          <div><p className="lbl2">Delete events older than (days)</p>
            <label className="field"><input type="number" min={1} max={3650} required value={days} onChange={(e) => setDays(e.target.value)} /></label></div>
        </div>
        <p className="sub" style={{ fontSize: 13, margin: "10px 0 0 8px" }}>
          Oldest events are deleted automatically every 10 minutes. Issues with no remaining events are deleted too.
        </p>
        <div className="row" style={{ gap: 8, marginTop: 14, flexWrap: "wrap" }}>
          <label className="row" style={{ gap: 8 }}>
            <input type="checkbox" className="check" checked={slowOn} onChange={(e) => setSlowOn(e.target.checked)} /> Keep slow traces ≥
          </label>
          <label className="field" style={{ width: 120 }}>
            <input type="number" min={50} max={600000} required={slowOn} disabled={!slowOn} value={slowMs} onChange={(e) => setSlowMs(e.target.value)} aria-label="Slow trace threshold (ms)" />
          </label>
          <span>ms</span>
        </div>
        <p className="sub" style={{ fontSize: 13, margin: "6px 0 0 8px" }}>Lite mode only; Scale mode keeps every trace.</p>
        {save.isError && <p className="err-msg">{save.error.message}</p>}
        <button className="btn dark sm" style={{ marginTop: 12 }} disabled={!dirty || save.isPending}>{save.isSuccess && !dirty ? "Saved" : "Save"}</button>
      </form>
      {stats.data && (
        <div className="row" style={{ gap: 18, marginTop: 16, fontSize: 13, flexWrap: "wrap" }}>
          <span className="row" style={{ gap: 6 }}><Database style={{ width: 16 }} /> <b className="num">{stats.data.events.toLocaleString("en-US")}</b> {stats.data.events === 1 ? "event" : "events"}</span>
          <span><b className="num">{stats.data.issues.toLocaleString("en-US")}</b> {stats.data.issues === 1 ? "issue" : "issues"}</span>
          {stats.data.oldestEventAt && <span className="sub">oldest {formatDate(stats.data.oldestEventAt)}</span>}
          {stats.data.dbSizeBytes != null && <span className="sub">database size (all projects): {fmtBytes(stats.data.dbSizeBytes)}</span>}
        </div>
      )}
    </div>
  );
}

function AlertsCard({ project }: { project: ProjectDetail }) {
  const qc = useQueryClient();
  const a = project.alerts!;
  const [url, setUrl] = useState("");
  const [newIssue, setNewIssue] = useState(a.newIssue);
  const [regression, setRegression] = useState(a.regression);
  const [spikeOn, setSpikeOn] = useState(a.spikeThreshold != null);
  const [threshold, setThreshold] = useState(String(a.spikeThreshold ?? 100));
  const [minutes, setMinutes] = useState(String(a.spikeMinutes));
  const [ongoingOn, setOngoingOn] = useState(a.ongoingSeconds != null);
  const [ongoingSec, setOngoingSec] = useState(String(a.ongoingSeconds ?? 60));
  const [backoff, setBackoff] = useState(a.ongoingBackoff ?? true);
  useEffect(() => {
    setNewIssue(a.newIssue);
    setRegression(a.regression);
    setSpikeOn(a.spikeThreshold != null);
    setThreshold(String(a.spikeThreshold ?? 100));
    setMinutes(String(a.spikeMinutes));
    setOngoingOn(a.ongoingSeconds != null);
    setOngoingSec(String(a.ongoingSeconds ?? 60));
    setBackoff(a.ongoingBackoff ?? true);
  }, [a.newIssue, a.regression, a.spikeThreshold, a.spikeMinutes, a.ongoingSeconds, a.ongoingBackoff]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["project", project.id] });
  const save = useMutation({
    mutationFn: () => api.patch(`/projects/${project.id}/alerts`, {
      ...(url.trim() && { discordWebhookUrl: url.trim() }),
      alertNewIssue: newIssue,
      alertRegression: regression,
      alertSpikeThreshold: spikeOn ? Number(threshold) : null,
      alertSpikeMinutes: Number(minutes),
      alertOngoingSeconds: ongoingOn ? Number(ongoingSec) : null,
      alertOngoingBackoff: backoff,
    }),
    onSuccess: () => { setUrl(""); refresh(); },
  });
  const disable = useMutation({ mutationFn: () => api.patch(`/projects/${project.id}/alerts`, { discordWebhookUrl: null }), onSuccess: refresh });
  const test = useMutation({ mutationFn: () => api.post(`/projects/${project.id}/alerts/test`, url.trim() ? { discordWebhookUrl: url.trim() } : {}) });
  const err = save.error ?? disable.error ?? test.error;
  const hasHook = Boolean(a.discordWebhook) || Boolean(url.trim());

  return (
    <div className="acc-it">
      <div className="h"><span className="row" style={{ gap: 8 }}><Bell style={{ width: 18 }} />Discord alerts</span></div>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <p className="lbl2" style={{ marginTop: 14 }}>Webhook URL</p>
        <label className="field">
          <input className="mono" style={{ fontSize: 12 }} value={url} onChange={(e) => setUrl(e.target.value)}
            placeholder={a.discordWebhook ?? "https://discord.com/api/webhooks/…"} autoComplete="off" />
        </label>
        <p className="sub" style={{ fontSize: 12, margin: "6px 0 0 8px" }}>
          Discord → Server Settings → Integrations → Webhooks → Copy URL. {a.discordWebhook && "Leave blank to keep the saved webhook."}
        </p>
        <div style={{ display: "grid", gap: 10, margin: "16px 0 0 8px", fontSize: 13 }}>
          <label className="row"><input type="checkbox" className="check" checked={newIssue} onChange={(e) => setNewIssue(e.target.checked)} /> New issue</label>
          <label className="row"><input type="checkbox" className="check" checked={regression} onChange={(e) => setRegression(e.target.checked)} /> Regression (resolved issue reappears)</label>
          <label className="row" style={{ flexWrap: "wrap" }}>
            <input type="checkbox" className="check" checked={spikeOn} onChange={(e) => setSpikeOn(e.target.checked)} /> Spike: ≥
            <input type="number" min={1} className="field" style={{ width: 90, height: 34, padding: "0 12px" }} value={threshold} disabled={!spikeOn} onChange={(e) => setThreshold(e.target.value)} />
            events within
            <input type="number" min={1} max={1440} className="field" style={{ width: 70, height: 34, padding: "0 12px" }} value={minutes} disabled={!spikeOn} onChange={(e) => setMinutes(e.target.value)} />
            minutes
          </label>
          <label className="row" style={{ flexWrap: "wrap" }}>
            <input type="checkbox" className="check" checked={ongoingOn} onChange={(e) => setOngoingOn(e.target.checked)} /> Ongoing errors: summary every
            <select className="select" style={{ height: 34 }} value={ongoingSec} disabled={!ongoingOn} onChange={(e) => setOngoingSec(e.target.value)}>
              <option value="30">30 seconds</option><option value="60">1 minute</option><option value="300">5 minutes</option><option value="900">15 minutes</option>
            </select>
            per issue while it keeps happening
          </label>
          <label className="row" style={{ marginLeft: 28, color: ongoingOn ? undefined : "var(--mute)" }}>
            <input type="checkbox" className="check" checked={backoff} disabled={!ongoingOn} onChange={(e) => setBackoff(e.target.checked)} /> After 10 minutes, slow down to every 15 minutes
          </label>
          {ongoingOn && <p className="sub" style={{ fontSize: 12, margin: "-4px 0 0 28px" }}>
            One message per issue with the number of events and users since the last one; at most 20 messages per minute per project.
          </p>}
        </div>
        {err && <p className="err-msg">{err.message}</p>}
        {test.isSuccess && <p className="sub" style={{ fontSize: 13, margin: "10px 0 0 8px" }}>✓ Test message sent — check your Discord channel.</p>}
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn dark sm" disabled={save.isPending}>{save.isSuccess ? "Saved" : "Save"}</button>
          <button type="button" className="btn sm" disabled={!hasHook || test.isPending} onClick={() => test.mutate()}><Send />Send test</button>
          {a.discordWebhook && <button type="button" className="btn sm" disabled={disable.isPending} onClick={() => confirm("Disable Discord alerts for this project?") && disable.mutate()}>Disable</button>}
        </div>
      </form>
      <AlertRules projectId={project.id} hasWebhook={Boolean(a.discordWebhook)} />
    </div>
  );
}

function SourceMapsCard({ project }: { project: ProjectDetail }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const tokens = useQuery({ queryKey: ["upload-tokens", project.id], queryFn: () => api.get<UploadToken[]>(`/projects/${project.id}/upload-tokens`) });
  const artifacts = useQuery({ queryKey: ["artifacts", project.id], queryFn: () => api.get<ArtifactList>(`/projects/${project.id}/artifacts`) });
  const create = useMutation({
    mutationFn: () => api.post<{ id: string; name: string; token: string }>(`/projects/${project.id}/upload-tokens`, { name: name.trim() }),
    onSuccess: () => { setName(""); qc.invalidateQueries({ queryKey: ["upload-tokens", project.id] }); },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/projects/${project.id}/upload-tokens/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["upload-tokens", project.id] }),
  });
  const delArtifact = useMutation({
    mutationFn: (id: string) => api.del(`/projects/${project.id}/artifacts/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["artifacts", project.id] }),
  });
  const origin = window.location.origin;
  const tokenValue = create.data?.token ?? "<token>";
  const envSnippet = `SENTRY_URL=${origin}\nSENTRY_ORG=bugtool\nSENTRY_PROJECT=${project.slug}\nSENTRY_AUTH_TOKEN=${tokenValue}`;
  const propsSnippet = `defaults.url=${origin}\ndefaults.org=bugtool\ndefaults.project=${project.slug}\n# pass the token via the SENTRY_AUTH_TOKEN env var — never commit it`;

  return (
    <div className="acc-it">
      <div className="h"><span className="row" style={{ gap: 8 }}><FileCode2 style={{ width: 18 }} />Source maps</span></div>
      <p className="sub" style={{ fontSize: 13, margin: "10px 0 0 8px" }}>
        Makes stacktraces from release builds (minified / Hermes) readable. Upload with <span className="mono">sentry-cli sourcemaps upload</span>.
        In React Native, the Sentry SDK's Gradle/Xcode plugins upload automatically on release builds using the config below.
      </p>

      <p className="lbl2" style={{ marginTop: 16 }}>Upload tokens</p>
      {create.data && (
        <div style={{ marginBottom: 10 }}>
          <p style={{ fontSize: 13, margin: "0 0 6px 8px" }}>Token <b>{create.data.name}</b> — shown only once, copy it now:</p>
          <label className="field"><input className="mono" style={{ fontSize: 12 }} value={create.data.token} readOnly onFocus={(e) => e.target.select()} /><CopyButton text={create.data.token} /></label>
        </div>
      )}
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (name.trim()) create.mutate(); }}>
        <label className="field" style={{ flex: 1, height: 44 }}><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Token name, e.g. CI Android" maxLength={100} /></label>
        <button className="btn dark sm" disabled={!name.trim() || create.isPending}><Plus />Create token</button>
      </form>
      {tokens.data?.map((t) => (
        <div key={t.id} className="row between" style={{ fontSize: 13, padding: "8px 8px 0" }}>
          <span><b>{t.name}</b> <span className="sub">· {t.lastUsedAt ? `last used ${formatDate(t.lastUsedAt)}` : "never used"}</span></span>
          <a className="sub" style={{ color: "var(--red)" }} onClick={() => confirm(`Revoke token "${t.name}"? CI jobs using it will fail to upload.`) && revoke.mutate(t.id)}>Revoke</a>
        </div>
      ))}

      <p className="lbl2" style={{ marginTop: 16 }}>Configuration (CI / build env)</p>
      <pre className="code" style={{ fontSize: 12 }}>{envSnippet}</pre>
      <p className="lbl2" style={{ marginTop: 10 }}>or React Native: android/sentry.properties & ios/sentry.properties</p>
      <pre className="code" style={{ fontSize: 12 }}>{propsSnippet}</pre>

      <p className="lbl2" style={{ marginTop: 16 }}>
        Uploaded: {artifacts.data ? `${artifacts.data.items.length < artifacts.data.count ? "latest 50 of " : ""}${artifacts.data.count} source maps · total ${fmtBytes(artifacts.data.totalBytes)}` : "…"}
      </p>
      {artifacts.data?.items.length === 0 && <p className="sub" style={{ fontSize: 13, marginLeft: 8 }}>No source maps yet.</p>}
      {artifacts.data?.items.map((a) => (
        <div key={a.id} className="row between mono" style={{ fontSize: 12, padding: "6px 8px", gap: 10 }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.url ?? "—"} <span className="sub">{a.debugId.slice(0, 8)} · {fmtBytes(a.size)}</span></span>
          <span className="row" style={{ gap: 10, flexShrink: 0 }}>
            <span className="sub">{a.lastUsedAt ? `last used ${formatDate(a.lastUsedAt)}` : formatDate(a.createdAt)}</span>
            <a title="Delete" onClick={() => confirm("Delete this source map?") && delArtifact.mutate(a.id)}><Trash2 style={{ width: 14, color: "var(--red)" }} /></a>
          </span>
        </div>
      ))}
      <p className="sub" style={{ fontSize: 12, margin: "8px 0 0 8px" }}>Source maps unused for 90 days are deleted automatically.</p>
      {(create.error ?? revoke.error ?? delArtifact.error) && <p className="err-msg">{(create.error ?? revoke.error ?? delArtifact.error)!.message}</p>}
    </div>
  );
}

function DangerZone({ project }: { project: ProjectDetail }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [confirmName, setConfirmName] = useState("");
  const del = useMutation({
    mutationFn: () => api.del(`/projects/${project.id}`),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["projects"] });
      navigate("/projects", { replace: true });
    },
  });
  return (
    <div className="acc-it">
      <div className="h" style={{ color: "var(--red)" }}>Delete project</div>
      <p className="sub" style={{ fontSize: 13, margin: "10px 0 10px 8px" }}>
        All issues, events, members, and DSNs will be permanently deleted. Type <b className="mono">{project.name}</b> to confirm.
      </p>
      <div className="row">
        <label className="field" style={{ flex: 1, height: 44 }}><input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={project.name} /></label>
        <button className="btn sm" style={{ background: "var(--red)", color: "#fff" }} disabled={confirmName !== project.name || del.isPending} onClick={() => del.mutate()}>
          <Trash2 />Delete permanently
        </button>
      </div>
      {del.isError && <p className="err-msg">{del.error.message}</p>}
    </div>
  );
}

const QUOTA_MAX = 10_000_000;
const n0 = (n: number) => n.toLocaleString("en-US");

// Satu input kuota per menit dengan toggle "Unlimited" (null).
function QuotaInput({ label, unlimited, value, onUnlimited, onValue }: {
  label: string; unlimited: boolean; value: string; onUnlimited: (v: boolean) => void; onValue: (v: string) => void;
}) {
  return (
    <div><p className="lbl2">{label}</p>
      <label className="field"><input type="number" min={1} max={QUOTA_MAX} required={!unlimited} disabled={unlimited} value={unlimited ? "" : value}
        placeholder={unlimited ? "Unlimited" : ""} onChange={(e) => onValue(e.target.value)} aria-label={label} /></label>
      <label className="row" style={{ gap: 8, margin: "8px 0 0 8px", fontSize: 13 }}>
        <input type="checkbox" className="check" checked={unlimited} onChange={(e) => onUnlimited(e.target.checked)} /> Unlimited
      </label>
    </div>
  );
}

function QuotasCard({ project }: { project: ProjectDetail }) {
  const qc = useQueryClient();
  const [evOff, setEvOff] = useState(project.quotaEventsPerMin == null);
  const [ev, setEv] = useState(String(project.quotaEventsPerMin ?? 6000));
  const [spOff, setSpOff] = useState(project.quotaSpansPerMin == null);
  const [sp, setSp] = useState(String(project.quotaSpansPerMin ?? 600000));
  // Server versi lama tidak mengirim quotaLogsPerMin (undefined): diperlakukan sebagai default 6000.
  const logsQuota = project.quotaLogsPerMin === undefined ? 6000 : project.quotaLogsPerMin;
  const [lgOff, setLgOff] = useState(logsQuota == null);
  const [lg, setLg] = useState(String(logsQuota ?? 6000));
  const [series, setSeries] = useState<"events" | "spans">("events");
  useEffect(() => {
    setEvOff(project.quotaEventsPerMin == null); setEv(String(project.quotaEventsPerMin ?? 6000));
    setSpOff(project.quotaSpansPerMin == null); setSp(String(project.quotaSpansPerMin ?? 600000));
    setLgOff(logsQuota == null); setLg(String(logsQuota ?? 6000));
  }, [project.quotaEventsPerMin, project.quotaSpansPerMin, logsQuota]);
  const usage = useQuery({
    queryKey: ["usage", project.id],
    queryFn: () => api.get<ProjectUsage>(`/projects/${project.id}/usage`),
    refetchInterval: 60_000,
  });
  const evValue = evOff ? null : Number(ev);
  const spValue = spOff ? null : Number(sp);
  const lgValue = lgOff ? null : Number(lg);
  const save = useMutation({
    mutationFn: () => api.patch(`/projects/${project.id}/settings`, { quotaEventsPerMin: evValue, quotaSpansPerMin: spValue, quotaLogsPerMin: lgValue }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["project", project.id] });
      void qc.invalidateQueries({ queryKey: ["usage", project.id] });
    },
  });
  const dirty = evValue !== project.quotaEventsPerMin || spValue !== project.quotaSpansPerMin || lgValue !== logsQuota;

  const u = usage.data;
  const rows = u?.hours.map((h) => series === "events"
    ? { hour: h.hour, ok: h.events, drop: h.droppedEvents }
    : { hour: h.hour, ok: h.spans, drop: h.droppedSpans }) ?? [];
  const max = Math.max(1, ...rows.map((r) => r.ok + r.drop));
  const hourLabel = (t: number) => new Date(t * 1000).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });

  return (
    <div className="acc-it">
      <div className="h">Quotas &amp; usage</div>
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", marginTop: 14 }}>
          <QuotaInput label="Error events per minute" unlimited={evOff} value={ev} onUnlimited={setEvOff} onValue={setEv} />
          <QuotaInput label="OTLP spans per minute" unlimited={spOff} value={sp} onUnlimited={setSpOff} onValue={setSp} />
          <QuotaInput label="OTLP logs per minute" unlimited={lgOff} value={lg} onUnlimited={setLgOff} onValue={setLg} />
        </div>
        <p className="sub" style={{ fontSize: 13, margin: "10px 0 0 8px" }}>
          Requests over the quota are rejected with 429 and Retry-After; SDKs and OTLP exporters back off until the next minute.
        </p>
        {save.isError && <p className="err-msg">{save.error.message}</p>}
        <button className="btn dark sm" style={{ marginTop: 12 }} disabled={!dirty || save.isPending}>{save.isSuccess && !dirty ? "Saved" : "Save"}</button>
      </form>
      {u && (
        <div style={{ marginTop: 18 }}>
          <div className="row between" style={{ flexWrap: "wrap", gap: 10 }}>
            <span className="sub" style={{ fontSize: 13 }}>
              Last 24 hours · this minute: {n0(u.currentMinute.events)} events, {n0(u.currentMinute.spans)} spans, {n0(u.currentMinute.logs ?? 0)} logs
            </span>
            <div className="ptabs">
              <a className={series === "events" ? "on" : ""} onClick={() => setSeries("events")}>Events</a>
              <a className={series === "spans" ? "on" : ""} onClick={() => setSeries("spans")}>Spans</a>
            </div>
          </div>
          <div className="bars usage" aria-label={`${series} per hour, dropped in red`}>
            {rows.map((r, i) => (
              <div key={r.hour} className={`bar ${r.ok + r.drop === 0 ? "ghost" : ""}`}
                title={`${hourLabel(r.hour)}: ${n0(r.ok)} accepted${r.drop ? `, ${n0(r.drop)} dropped (over quota)` : ""}`}>
                {r.drop > 0 && <i className="drop" style={{ height: `${Math.max(4, (r.drop / max) * 100)}%` }} />}
                <i style={{ height: `${r.ok + r.drop === 0 ? 20 : r.ok === 0 ? 0 : Math.max(4, (r.ok / max) * 100)}%` }} />
                <b />
                <span>{i % 6 === 0 ? hourLabel(r.hour) : ""}</span>
              </div>
            ))}
          </div>
          {u.totals.droppedEvents > 0 && (
            <p className="err-msg" style={{ marginTop: 10 }}>{n0(u.totals.droppedEvents)} events dropped (over quota) in the last 24 hours</p>
          )}
          {u.totals.droppedSpans > 0 && (
            <p className="err-msg" style={{ marginTop: 4 }}>{n0(u.totals.droppedSpans)} spans dropped (over quota) in the last 24 hours</p>
          )}
          {(u.totals.droppedLogs ?? 0) > 0 && (
            <p className="err-msg" style={{ marginTop: 4 }}>{n0(u.totals.droppedLogs!)} logs dropped (over quota) in the last 24 hours</p>
          )}
          <p className="sub" style={{ fontSize: 12, margin: "8px 0 0 8px" }}>
            Events: error events stored (after de-duplication and retention). Spans: OTLP spans accepted.
          </p>
        </div>
      )}
    </div>
  );
}

export function SettingsPage() {
  const { projectId } = useParams();
  const me = useMe().data!;
  const project = useProject();
  const qc = useQueryClient();
  const [inviting, setInviting] = useState(false);
  const members = useQuery({
    queryKey: ["members", projectId],
    queryFn: () => api.get<{ members: Member[]; invites: Invite[] }>(`/projects/${projectId}/members`),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["members", projectId] });
  const setRole = useMutation({ mutationFn: ({ userId, role }: { userId: string; role: Role }) => api.patch(`/projects/${projectId}/members/${userId}`, { role }), onSettled: refresh });
  const remove = useMutation({ mutationFn: (userId: string) => api.del(`/projects/${projectId}/members/${userId}`), onSettled: refresh });
  const revoke = useMutation({ mutationFn: (id: string) => api.del(`/projects/${projectId}/invites/${id}`), onSettled: refresh });
  // Link reset password (tanpa email): ditampilkan sekali di bawah member yang bersangkutan.
  const resetLink = useMutation({
    mutationFn: (userId: string) => api.post<{ username: string; link: string; expiresAt: string }>(`/projects/${projectId}/members/${userId}/password-reset`)
      .then((r) => ({ ...r, userId })),
  });

  if (project.isPending) return <div className="empty">Loading…</div>;
  if (project.isError) return <div className="empty">Project not found.</div>;
  const p = project.data;
  const isAdmin = p.role === "admin";
  const mutError = setRole.error ?? remove.error ?? revoke.error ?? resetLink.error;

  return (
    <section>
      <div className="hero"><div><h1>Settings</h1><p className="sub" style={{ marginTop: 8 }}>{p.name}</p></div></div>
      <div className="grid settings-grid">
        <div className="card">
          <ConnectCard dsnKeys={p.dsnKeys} traceStorage={p.traceStorage} />
          {isAdmin && p.alerts && <AlertsCard project={p} />}
          {isAdmin && <SourceMapsCard project={p} />}
          {isAdmin && <RetentionCard project={p} />}
          {isAdmin && <QuotasCard project={p} />}
          {me.isAdmin && <DangerZone project={p} />}
        </div>

        <div className="card dark">
          <div className="head">
            <h2 style={{ color: "#f1efe8" }}>Members</h2>
            {isAdmin && !inviting && <button className="btn acc sm" onClick={() => setInviting(true)}><UserPlus />Invite</button>}
          </div>
          {inviting && <InviteForm projectId={p.id} onDone={() => setInviting(false)} />}
          {mutError && <p className="err-msg">{mutError.message}</p>}
          <div className="dlist">
            {members.data?.members.map((m) => (
              <div key={m.id} className="it">
                <span className="who" style={{ width: 44, height: 44 }}>{initial(personName(m))}</span>
                <div className="t"><b>{personName(m)}{m.id === me.id ? " (you)" : ""}</b><span>@{m.username}{m.email ? ` · ${m.email}` : ""} · {m.role}</span></div>
                {isAdmin && (
                  <>
                    <select className="select" style={{ height: 34, background: "var(--dark-2)", color: "#f1efe8" }} value={m.role}
                      onChange={(e) => setRole.mutate({ userId: m.id, role: e.target.value as Role })}>
                      <option value="admin">admin</option><option value="member">member</option><option value="viewer">viewer</option>
                    </select>
                    {m.id !== me.id && (
                      <a className="iconbtn sm" style={{ background: "var(--dark-2)" }} title="Password reset link"
                        onClick={() => !resetLink.isPending && resetLink.mutate(m.id)}><KeyRound /></a>
                    )}
                    <a className="iconbtn sm" style={{ background: "var(--dark-2)" }} title="Remove"
                      onClick={() => confirm(`Remove ${personName(m)} from this project?`) && remove.mutate(m.id)}><Trash2 /></a>
                  </>
                )}
                {resetLink.data?.userId === m.id && (
                  <div className="reset-link">
                    <p style={{ fontSize: 13, margin: "0 0 8px" }}>
                      Send this link to <b>@{resetLink.data.username}</b>. They set a new password; other signed-in devices are signed out.
                      Works once, expires in 24 hours, shown only once.
                    </p>
                    <label className="field" style={{ background: "var(--dark-2)" }}>
                      <input className="mono" style={{ fontSize: 12 }} value={resetLink.data.link} readOnly onFocus={(e) => e.target.select()} />
                      <CopyButton text={resetLink.data.link} />
                    </label>
                    <button className="btn sm" style={{ marginTop: 8 }} onClick={() => resetLink.reset()}>Done</button>
                  </div>
                )}
              </div>
            ))}
            {members.data?.invites.map((inv) => (
              <div key={inv.id} className="it">
                <span className="ic"><Mail /></span>
                <div className="t"><b>{inv.email ?? "Invite link"}</b><span>invited as {inv.role} · expires {formatDate(inv.expiresAt)}</span></div>
                <a className="iconbtn sm" style={{ background: "var(--dark-2)" }} title="Revoke invite" onClick={() => revoke.mutate(inv.id)}><X /></a>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// Cara mengirim data: Sentry SDK (DSN) atau OpenTelemetry (OTLP/HTTP atau gRPC :4317, key = public key DSN).
function ConnectCard({ dsnKeys, traceStorage }: { dsnKeys: { id: string; dsn: string }[]; traceStorage: ProjectDetail["traceStorage"] }) {
  const [via, setVia] = useState<"sentry" | "otel">("sentry");
  const first = dsnKeys[0];
  const parsed = first ? new URL(first.dsn) : null;
  const endpoint = parsed ? `${parsed.protocol}//${parsed.host}/otlp` : "";
  const key = parsed?.username ?? "";
  const envSnippet = `OTEL_EXPORTER_OTLP_ENDPOINT=${endpoint}\nOTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf\nOTEL_EXPORTER_OTLP_HEADERS=x-bugtrail-key=${key}\nOTEL_SERVICE_NAME=my-api`;
  return (
    <div className="acc-it">
      <div className="row between" style={{ flexWrap: "wrap", gap: 10 }}>
        <div className="h">Connect your app</div>
        <div className="ptabs">
          <a className={via === "sentry" ? "on" : ""} onClick={() => setVia("sentry")}>Sentry SDK</a>
          <a className={via === "otel" ? "on" : ""} onClick={() => setVia("otel")}>OpenTelemetry</a>
        </div>
      </div>
      {!first ? (
        <p className="sub" style={{ fontSize: 13, marginTop: 10 }}>Viewers can't see the DSN.</p>
      ) : via === "sentry" ? (
        <>
          {dsnKeys.map((k) => (
            <label key={k.id} className="field" style={{ marginTop: 14 }}>
              <KeyRound /><input className="mono" style={{ fontSize: 12 }} value={k.dsn} readOnly onFocus={(e) => e.target.select()} /><CopyButton text={k.dsn} />
            </label>
          ))}
          <p className="sub" style={{ fontSize: 13, margin: "10px 0 0 8px" }}>
            For web, React Native and Flutter apps. Paste into <span className="mono">Sentry.init({"{ dsn }"})</span> via an env var.
          </p>
        </>
      ) : (
        <>
          <p className="sub" style={{ fontSize: 13, margin: "12px 0 10px 8px" }}>
            For backends already instrumented with OpenTelemetry. Add BugTrail as an OTLP destination for traces and logs: exceptions
            recorded on spans become issues, {traceStorage?.allSpans ? "every trace is stored" : "traces that contain an error are kept for the Trace tab"},
            and logs show up under Logs (linked to their trace).
          </p>
          {traceStorage && (
            <p className="sub" style={{ fontSize: 12, margin: "0 0 10px 8px" }}>
              Trace storage: <span className="tag" style={{ height: 22 }}>{traceStorage.kind === "clickhouse" ? "ClickHouse · all traces (Scale mode)" : "SQLite · error and slow traces (Lite mode)"}</span>
            </p>
          )}
          <label className="field"><span className="sub" style={{ fontSize: 12, width: 70 }}>Endpoint</span><input className="mono" style={{ fontSize: 12 }} value={endpoint} readOnly onFocus={(e) => e.target.select()} /><CopyButton text={endpoint} /></label>
          <label className="field" style={{ marginTop: 8 }}><span className="sub" style={{ fontSize: 12, width: 70 }}>Header</span><input className="mono" style={{ fontSize: 12 }} value={`x-bugtrail-key=${key}`} readOnly onFocus={(e) => e.target.select()} /><CopyButton text={`x-bugtrail-key=${key}`} /></label>
          <div className="row between" style={{ margin: "14px 0 6px 8px" }}><span className="sub" style={{ fontSize: 12 }}>Backend environment variables</span><CopyButton text={envSnippet} /></div>
          <pre className="code">{envSnippet}</pre>
          <p className="sub" style={{ fontSize: 12, margin: "10px 0 0 8px" }}>
            OTLP/HTTP with protobuf or JSON. For gRPC, use <span className="mono">OTEL_EXPORTER_OTLP_PROTOCOL=grpc</span> and
            {" "}<span className="mono">{parsed ? `${parsed.protocol}//${parsed.hostname}:4317` : "port 4317"}</span> (the port your server publishes for
            gRPC; plain gRPC unless a proxy adds TLS). Keep the key in your secrets, not in code.
          </p>
          {!traceStorage?.allSpans && <div className="otel-warn">
            <b><TriangleAlert />Good to know before you rely on it</b>
            <ul>
              <li><b>Not a full tracing backend.</b> BugTrail keeps only sampled traces that contain an error or are slow
                (≥ the threshold under Data retention, up to 10 per endpoint per hour). Other requests are not stored,
                so you can't see every request's trace. Run BugTrail in Scale mode (ClickHouse) to keep them all.</li>
              <li><b>One SQLite database, one writer.</b> Measured on one container: 15,000 spans/s used about one CPU core
                and p95 response time rose to ~330 ms (no data lost). Above that, sample in your backend or filter in an OTel Collector.</li>
              <li><b>Up to 20 traces per issue per hour.</b> Every error is counted, but only 20 example traces per issue per hour are
                kept for the Trace tab, so disk stays small. Many different errors still add up; keep retention short if that happens.</li>
              <li><b>Best with Node.js.</b> Stack traces are parsed from the Node.js format. Other languages still create issues,
                but grouping falls back to the error type and message.</li>
              <li><b>No breadcrumbs.</b> OpenTelemetry has no breadcrumbs. Use the trace and your logs instead.</li>
            </ul>
          </div>}
        </>
      )}
    </div>
  );
}
