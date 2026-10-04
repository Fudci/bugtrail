import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Copy, Database, FileCode2, KeyRound, Mail, Plus, Send, Trash2, UserPlus, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { api, type ArtifactList, type Invite, type Member, type ProjectDetail, type ProjectStats, type Role, type UploadToken } from "../api";
import { formatDate, initial, useMe, useProject } from "../hooks";

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
        <p style={{ fontSize: 13, marginBottom: 8 }}>Send this link to <b>{invite.data.email}</b>. It is shown only once and expires in 7 days.</p>
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
        <label className="field" style={{ flex: 1, height: 44, color: "var(--ink)" }}><Mail /><input type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@company.com" /></label>
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
  useEffect(() => {
    setMaxEvents(String(project.retentionMaxEvents));
    setDays(String(project.retentionDays));
  }, [project.retentionMaxEvents, project.retentionDays]);
  const stats = useQuery({ queryKey: ["stats", project.id], queryFn: () => api.get<ProjectStats>(`/projects/${project.id}/stats`) });
  const save = useMutation({
    mutationFn: () => api.patch(`/projects/${project.id}/settings`, { retentionMaxEvents: Number(maxEvents), retentionDays: Number(days) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project", project.id] }),
  });
  const dirty = maxEvents !== String(project.retentionMaxEvents) || days !== String(project.retentionDays);

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
  useEffect(() => {
    setNewIssue(a.newIssue);
    setRegression(a.regression);
    setSpikeOn(a.spikeThreshold != null);
    setThreshold(String(a.spikeThreshold ?? 100));
    setMinutes(String(a.spikeMinutes));
  }, [a.newIssue, a.regression, a.spikeThreshold, a.spikeMinutes]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["project", project.id] });
  const save = useMutation({
    mutationFn: () => api.patch(`/projects/${project.id}/alerts`, {
      ...(url.trim() && { discordWebhookUrl: url.trim() }),
      alertNewIssue: newIssue,
      alertRegression: regression,
      alertSpikeThreshold: spikeOn ? Number(threshold) : null,
      alertSpikeMinutes: Number(minutes),
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
        </div>
        {err && <p className="err-msg">{err.message}</p>}
        {test.isSuccess && <p className="sub" style={{ fontSize: 13, margin: "10px 0 0 8px" }}>✓ Test message sent — check your Discord channel.</p>}
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn dark sm" disabled={save.isPending}>{save.isSuccess ? "Saved" : "Save"}</button>
          <button type="button" className="btn sm" disabled={!hasHook || test.isPending} onClick={() => test.mutate()}><Send />Send test</button>
          {a.discordWebhook && <button type="button" className="btn sm" disabled={disable.isPending} onClick={() => confirm("Disable Discord alerts for this project?") && disable.mutate()}>Disable</button>}
        </div>
      </form>
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

  if (project.isPending) return <div className="empty">Loading…</div>;
  if (project.isError) return <div className="empty">Project not found.</div>;
  const p = project.data;
  const isAdmin = p.role === "admin";
  const mutError = setRole.error ?? remove.error ?? revoke.error;

  return (
    <section>
      <div className="hero"><div><h1>Settings</h1><p className="sub" style={{ marginTop: 8 }}>{p.name}</p></div></div>
      <div className="grid settings-grid">
        <div className="card">
          <div className="acc-it">
            <div className="h">DSN</div>
            {p.dsnKeys.length === 0 ? (
              <p className="sub" style={{ fontSize: 13, marginTop: 10 }}>Viewers can't see the DSN.</p>
            ) : p.dsnKeys.map((k) => (
              <label key={k.id} className="field" style={{ marginTop: 14 }}>
                <KeyRound /><input className="mono" style={{ fontSize: 12 }} value={k.dsn} readOnly onFocus={(e) => e.target.select()} /><CopyButton text={k.dsn} />
              </label>
            ))}
            <p className="sub" style={{ fontSize: 13, margin: "10px 0 0 8px" }}>
              Paste into <span className="mono">Sentry.init({"{ dsn }"})</span> via an env var. No need to replace the Sentry SDK.
            </p>
          </div>
          {isAdmin && p.alerts && <AlertsCard project={p} />}
          {isAdmin && <SourceMapsCard project={p} />}
          {isAdmin && <RetentionCard project={p} />}
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
                <span className="who" style={{ width: 44, height: 44 }}>{initial(m.name ?? m.email)}</span>
                <div className="t"><b>{m.name ?? m.email}{m.id === me.id ? " (you)" : ""}</b><span>{m.name ? `${m.email} · ` : ""}{m.role}</span></div>
                {isAdmin && (
                  <>
                    <select className="select" style={{ height: 34, background: "var(--dark-2)", color: "#f1efe8" }} value={m.role}
                      onChange={(e) => setRole.mutate({ userId: m.id, role: e.target.value as Role })}>
                      <option value="admin">admin</option><option value="member">member</option><option value="viewer">viewer</option>
                    </select>
                    <a className="iconbtn sm" style={{ background: "var(--dark-2)" }} title="Remove"
                      onClick={() => confirm(`Remove ${m.email} from this project?`) && remove.mutate(m.id)}><Trash2 /></a>
                  </>
                )}
              </div>
            ))}
            {members.data?.invites.map((inv) => (
              <div key={inv.id} className="it">
                <span className="ic"><Mail /></span>
                <div className="t"><b>{inv.email}</b><span>invited as {inv.role} · expires {formatDate(inv.expiresAt)}</span></div>
                <a className="iconbtn sm" style={{ background: "var(--dark-2)" }} title="Revoke invite" onClick={() => revoke.mutate(inv.id)}><X /></a>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
