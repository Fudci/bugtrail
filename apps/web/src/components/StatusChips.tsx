import { useState } from "react";
import { Plus } from "lucide-react";
import { CLASSES, classCounts, customToken, groupCodes, toggleToken, type StatusCount } from "./status-util";

const tone = (code: number) => (code >= 500 ? "err" : code >= 400 ? "warn" : "");

function Chip({ on, label, n, cls = "", onClick, title }: { on: boolean; label: string; n?: number | undefined; cls?: string; onClick: () => void; title?: string }) {
  return (
    <button type="button" className={`schip ${cls}${on ? " on" : ""}`} aria-pressed={on} onClick={onClick} title={title}>
      <span>{label}</span>{n !== undefined && <span className="schip-n num">×{n.toLocaleString("en-US")}</span>}
    </button>
  );
}

/**
 * Filter status HTTP dengan jumlah per kode (multi-pilih). Baris 1: All + kelas (+ Errors untuk Traces);
 * baris 2: kode yang ada (5xx | 4xx | lainnya) + token kustom yang dipilih. Jumlah diredupkan saat memuat.
 */
export function StatusChips({ value, counts, loading, onChange, withError = false }: {
  value: string[]; counts: StatusCount[] | undefined; loading: boolean; onChange: (tokens: string[]) => void; withError?: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const [bad, setBad] = useState(false);
  const list = counts ?? [];
  const byClass = classCounts(list);
  const total = list.reduce((s, c) => s + c.count, 0);
  const groups = groupCodes(list).filter((g) => g.length);
  const known = new Set(list.map((c) => String(c.code)));
  // Token terpilih yang tidak punya chip sendiri (rentang, kode tanpa request): tetap tampil supaya bisa dilepas.
  const extra = value.filter((t) => t !== "error" && !/^[1-5]xx$/.test(t) && !known.has(t));
  const toggle = (t: string) => onChange(toggleToken(value, t));
  const add = () => {
    const t = customToken(text);
    if (!t) { setBad(true); return; }
    if (!value.includes(t)) toggle(t);
    setText(""); setAdding(false); setBad(false);
  };

  return (
    <div className={`schips${loading ? " loading" : ""}`} aria-busy={loading}>
      <div className="schip-row" role="group" aria-label="Status class">
        <Chip on={value.length === 0} label="All" n={counts ? total : undefined} onClick={() => onChange([])} />
        {withError && <Chip on={value.includes("error")} label="Errors" cls="err" title="Span error or HTTP 5xx" onClick={() => toggle("error")} />}
        {CLASSES.filter((c) => (byClass.get(c) ?? 0) > 0 || value.includes(c)).map((c) => (
          <Chip key={c} on={value.includes(c)} label={c} n={counts ? byClass.get(c) ?? 0 : undefined} cls={tone(Number(c[0]) * 100)} onClick={() => toggle(c)} />
        ))}
      </div>
      <div className="schip-row" role="group" aria-label="Status code">
        {groups.map((g, i) => (
          <span key={i} className="schip-group">
            {g.map((c) => <Chip key={c.code} on={value.includes(String(c.code))} label={String(c.code)} n={c.count} cls={tone(c.code)} onClick={() => toggle(String(c.code))} />)}
          </span>
        ))}
        {extra.map((t) => <Chip key={t} on label={t} cls={tone(Number(t.slice(0, 3)))} onClick={() => toggle(t)} />)}
        {adding ? (
          <form className="schip-add" onSubmit={(e) => { e.preventDefault(); add(); }}>
            <input autoFocus value={text} maxLength={7} placeholder="499 or 520-529" aria-label="Status code or range"
              aria-invalid={bad} onChange={(e) => { setText(e.target.value); setBad(false); }}
              onKeyDown={(e) => { if (e.key === "Escape") { setAdding(false); setText(""); setBad(false); } }}
              onBlur={() => { if (!text) setAdding(false); }} />
            {bad && <span className="schip-hint" role="alert">Use a code 100–599 or a range like 520-529</span>}
          </form>
        ) : (
          <button type="button" className="schip schip-plus" aria-label="Add status code or range" title="Add status code or range" onClick={() => setAdding(true)}><Plus /></button>
        )}
      </div>
    </div>
  );
}
