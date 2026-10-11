import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Send, Trash2 } from "lucide-react";
import { api, type AlertRule, type AlertRuleInput, type HealthList } from "../api";
import { customToken, toggleToken } from "./status-util";

// Aturan alert per project (Settings → Discord alerts): kode status (persen atau jumlah) atau latency, per endpoint atau semua.
const PRESET_CODES = ["5xx", "4xx", "500", "502", "503", "504", "401", "403", "404", "429"];
const NEW_RULE: AlertRuleInput = {
  name: "5xx rate", enabled: true, kind: "status", statusFilter: "5xx", mode: "pct", percentile: 95,
  threshold: 5, windowMinutes: 5, minRequests: 20, method: null, route: null,
};
// Default saat berganti jenis aturan; nama bawaan ikut diganti kalau belum diubah user.
const KIND_DEFAULTS = {
  status: { name: "5xx rate", threshold: 5, mode: "pct" as const },
  latency: { name: "Slow requests", threshold: 1000, mode: "pct" as const },
};
const toInput = (r: AlertRule): AlertRuleInput => ({
  name: r.name, enabled: r.enabled, kind: r.kind, statusFilter: r.statusFilter ?? "5xx", mode: r.mode, percentile: r.percentile ?? 95,
  threshold: r.threshold, windowMinutes: r.windowMinutes, minRequests: r.minRequests, method: r.method, route: r.route,
});

export function AlertRules({ projectId, hasWebhook }: { projectId: string; hasWebhook: boolean }) {
  const qc = useQueryClient();
  const key = ["alert-rules", projectId];
  const rules = useQuery({ queryKey: key, queryFn: () => api.get<{ rules: AlertRule[]; max: number }>(`/projects/${projectId}/alert-rules`) });
  // null = tidak sedang mengedit; "new" = aturan baru; selain itu id aturan.
  const [editing, setEditing] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const toggle = useMutation({
    mutationFn: (r: AlertRule) => api.put(`/projects/${projectId}/alert-rules/${r.id}`, { ...toInput(r), enabled: !r.enabled }),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: (id: string) => api.del(`/projects/${projectId}/alert-rules/${id}`), onSuccess: refresh });
  const test = useMutation({ mutationFn: (id: string) => api.post(`/projects/${projectId}/alert-rules/${id}/test`) });
  const list = rules.data?.rules ?? [];
  const err = toggle.error ?? remove.error ?? test.error;

  return (
    <div className="alert-rules">
      <div className="row between" style={{ marginTop: 18 }}>
        <p className="lbl2" style={{ margin: 0 }}>API alert rules</p>
        {editing === null && list.length < (rules.data?.max ?? 20) && (
          <button type="button" className="btn sm" onClick={() => setEditing("new")}><Plus />Add rule</button>
        )}
      </div>
      <p className="sub" style={{ fontSize: 12, margin: "4px 0 10px 8px" }}>
        From OpenTelemetry server spans (API Health). Checked every minute; at most one alert per rule and endpoint every 30 minutes.
        {!hasWebhook && " Save a webhook above to receive them."}
      </p>
      {rules.isPending && <p className="sub" style={{ fontSize: 13 }}>Loading…</p>}
      {rules.data && list.length === 0 && editing === null && <p className="sub" style={{ fontSize: 13, marginLeft: 8 }}>No rules yet.</p>}
      <div className="rule-list">
        {list.map((r) => editing === r.id
          ? <RuleEditor key={r.id} projectId={projectId} rule={r} onDone={() => { setEditing(null); refresh(); }} />
          : (
            <div key={r.id} className={`rule-row ${r.enabled ? "" : "off"}`}>
              <input type="checkbox" className="check" checked={r.enabled} aria-label={`Enable ${r.name}`} onChange={() => toggle.mutate(r)} />
              <div style={{ minWidth: 0 }}>
                <div className="rule-name">{r.name}</div>
                <div className="sub rule-sum">
                  {r.summary} · {r.method && r.route ? <span className="mono">{r.method} {r.route}</span> : "all endpoints"}
                </div>
              </div>
              <div className="row" style={{ gap: 4 }}>
                <button type="button" className="iconbtn sm" title="Send test" disabled={!hasWebhook || test.isPending} onClick={() => test.mutate(r.id)}><Send /></button>
                <button type="button" className="iconbtn sm" title="Edit" onClick={() => setEditing(r.id)}><Pencil /></button>
                <button type="button" className="iconbtn sm" title="Delete" onClick={() => confirm(`Delete alert rule "${r.name}"?`) && remove.mutate(r.id)}><Trash2 /></button>
              </div>
            </div>
          ))}
        {editing === "new" && <RuleEditor projectId={projectId} onDone={() => { setEditing(null); refresh(); }} />}
      </div>
      {err && <p className="err-msg">{err.message}</p>}
      {test.isSuccess && <p className="sub" style={{ fontSize: 13, margin: "8px 0 0 8px" }}>✓ Test message sent — check your Discord channel.</p>}
    </div>
  );
}

function RuleEditor({ projectId, rule, onDone }: { projectId: string; rule?: AlertRule; onDone: () => void }) {
  const [f, setF] = useState<AlertRuleInput>(rule ? toInput(rule) : NEW_RULE);
  const [custom, setCustom] = useState("");
  const [customBad, setCustomBad] = useState(false);
  const set = (patch: Partial<AlertRuleInput>) => setF((x) => ({ ...x, ...patch }));
  // Daftar endpoint untuk aturan satu endpoint: dari API Health 7 hari terakhir.
  const endpoints = useQuery({
    queryKey: ["health", projectId, "7d"],
    queryFn: () => api.get<HealthList>(`/projects/${projectId}/health?range=7d`),
  });
  const save = useMutation({
    mutationFn: () => rule ? api.put(`/projects/${projectId}/alert-rules/${rule.id}`, f) : api.post(`/projects/${projectId}/alert-rules`, f),
    onSuccess: onDone,
  });
  const tokensOf = (x: AlertRuleInput) => (x.statusFilter ?? "").split(",").filter(Boolean);
  const tokens = tokensOf(f);
  // Dari state terbaru (bukan render ini), supaya dua klik cepat tidak saling menimpa.
  const toggleCode = (t: string) => setF((x) => ({ ...x, statusFilter: toggleToken(tokensOf(x), t).join(",") }));
  const addCustom = () => {
    const t = customToken(custom);
    if (!t) { setCustomBad(true); return; }
    if (!tokens.includes(t)) toggleCode(t);
    setCustom(""); setCustomBad(false);
  };
  const scope = f.method && f.route ? `${f.method} ${f.route}` : "";
  const eps = endpoints.data?.endpoints ?? [];
  const usesMin = !(f.kind === "status" && f.mode === "count");
  const noisy = usesMin && f.minRequests < 10;
  const num = (v: string) => (v === "" ? 0 : Number(v));

  return (
    <form className="rule-edit" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <div className="rule-grid">
        <label><span className="lbl2">Name</span>
          <span className="field"><input value={f.name} maxLength={80} required onChange={(e) => set({ name: e.target.value })} /></span>
        </label>
        <label><span className="lbl2">Type</span>
          <span className="ptabs" style={{ display: "inline-flex" }}>
            {(["status", "latency"] as const).map((k) => (
              <a key={k} className={f.kind === k ? "on" : ""} onClick={() => f.kind !== k && setF((x) => ({
                ...x, kind: k, threshold: KIND_DEFAULTS[k].threshold, mode: KIND_DEFAULTS[k].mode,
                name: x.name === KIND_DEFAULTS[x.kind].name ? KIND_DEFAULTS[k].name : x.name,
              }))}>{k === "status" ? "Status codes" : "Latency"}</a>
            ))}
          </span>
        </label>
      </div>

      {f.kind === "status" ? (
        <>
          <p className="lbl2" style={{ marginTop: 12 }}>Status codes</p>
          <div className="rule-codes">
            {[...PRESET_CODES, ...tokens.filter((t) => !PRESET_CODES.includes(t))].map((t) => (
              <button key={t} type="button" className={`schip ${tokens.includes(t) ? "on" : ""}`} aria-pressed={tokens.includes(t)}
                onClick={() => toggleCode(t)}><span>{t}</span></button>
            ))}
            <span className="field" style={{ height: 32, width: 140 }}>
              <input value={custom} placeholder="+ 418 or 520-529" aria-label="Custom status code or range"
                onChange={(e) => { setCustom(e.target.value); setCustomBad(false); }}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addCustom(); } }} onBlur={() => custom && addCustom()} />
            </span>
          </div>
          {customBad && <p className="err-msg" style={{ margin: "4px 0 0 8px" }}>Use a code (100–599) or a range like 520-529.</p>}
          <div className="rule-cond">
            Alert when
            <select className="select" value={f.mode} onChange={(e) => set({ mode: e.target.value as "pct" | "count", threshold: e.target.value === "pct" ? 5 : 20 })}>
              <option value="pct">the share of matching requests is ≥</option>
              <option value="count">the number of matching requests is ≥</option>
            </select>
            <span className="field num-in"><input type="number" min={f.mode === "pct" ? 0.1 : 1} max={f.mode === "pct" ? 100 : 10_000_000} step={f.mode === "pct" ? 0.1 : 1}
              value={f.threshold} required onChange={(e) => set({ threshold: num(e.target.value) })} /></span>
            {f.mode === "pct" ? "%" : "requests"}
          </div>
        </>
      ) : (
        <div className="rule-cond">
          Alert when
          <select className="select" value={f.percentile ?? 95} onChange={(e) => set({ percentile: Number(e.target.value) as 50 | 95 | 99 })}>
            <option value={50}>p50</option><option value={95}>p95</option><option value={99}>p99</option>
          </select>
          latency is ≥
          <span className="field num-in"><input type="number" min={1} max={10000} value={f.threshold} required onChange={(e) => set({ threshold: num(e.target.value) })} /></span>
          ms
        </div>
      )}

      <div className="rule-cond">
        within the last
        <span className="field num-in"><input type="number" min={1} max={60} value={f.windowMinutes} required onChange={(e) => set({ windowMinutes: num(e.target.value) })} /></span>
        minutes
        {usesMin && <>, with at least
          <span className="field num-in"><input type="number" min={1} max={1_000_000} value={f.minRequests} required onChange={(e) => set({ minRequests: num(e.target.value) })} /></span>
          requests</>}
      </div>
      {noisy && <p className="sub rule-hint">With fewer than 10 requests, a single failed request can trigger the alert.</p>}
      {f.kind === "latency" && <p className="sub rule-hint">Percentiles are approximate (latency bucket upper bounds: …, 500, 1000, 2500, 5000, 10000 ms).</p>}

      <div className="rule-cond">
        On
        <select className="select" value={scope} onChange={(e) => {
          const ep = eps.find((x) => `${x.method} ${x.route}` === e.target.value);
          set(ep ? { method: ep.method, route: ep.route } : { method: null, route: null });
        }}>
          <option value="">every endpoint (each one checked on its own)</option>
          {scope && !eps.some((x) => `${x.method} ${x.route}` === scope) && <option value={scope}>{scope}</option>}
          {eps.map((x) => <option key={`${x.method} ${x.route}`} value={`${x.method} ${x.route}`}>{x.method} {x.route}</option>)}
        </select>
      </div>

      {save.error && <p className="err-msg">{save.error.message}</p>}
      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn dark sm" disabled={save.isPending || (f.kind === "status" && tokens.length === 0)}>{rule ? "Save rule" : "Add rule"}</button>
        <button type="button" className="btn sm" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}
