import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { api } from "../api";
import { TraceResults, type TraceFilters, type TraceStatus } from "../components/TraceResults";
import { DEFAULT_SIZE, readPaging } from "../components/pager-util";
import { parseStatus } from "../components/status-util";
import { RangeTabs, SEARCH_RANGES, readRange } from "../components/RangeTabs";

type Range = TraceFilters["range"];
const MIN_MS: { v: string; label: string }[] = [{ v: "", label: "Any duration" }, { v: "100", label: "> 100 ms" }, { v: "500", label: "> 500 ms" }, { v: "1000", label: "> 1 s" }, { v: "5000", label: "> 5 s" }];

export function TracesPage() {
  const { projectId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  // Semua filter dibaca dari URL; nilai tak dikenal kembali ke default.
  const rawRange = params.get("range");
  const range: Range = readRange(rawRange, SEARCH_RANGES, "1h");
  // ?status=error,500,520-529; tidak ada atau tidak sah = semua.
  const status: TraceStatus = parseStatus(params.get("status"), { allowError: true }) ?? [];
  const service = params.get("service") ?? "";
  const rawMin = params.get("minMs") ?? "";
  const minMs = MIN_MS.some((m) => m.v === rawMin) ? rawMin : "";
  const urlQ = params.get("q") ?? "";
  // Halaman hasil (?page=&size=; 1 dan 50 tidak ditulis).
  const { page, size } = readPaging(params);
  const setQuery = (patch: Record<string, string>) => {
    // Baca URL saat ini langsung dari window.location: `prev` di setParams(fn) react-router bisa basi
    // (diambil dari render saat timer debounce dibuat), sehingga filter yang baru diklik ikut tertimpa.
    const next = new URLSearchParams(window.location.search);
    // Filter apa pun berubah -> kembali ke halaman 1.
    if (!("page" in patch)) next.delete("page");
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    setParams(next, { replace: true });
  };

  // Teks endpoint: state lokal, ditulis ke URL setelah 300 ms tanpa ketikan.
  const [text, setText] = useState(urlQ);
  useEffect(() => { setText((t) => (t.trim() === urlQ ? t : urlQ)); }, [urlQ]);
  useEffect(() => {
    const v = text.trim();
    if (v === urlQ) return;
    const id = setTimeout(() => setQuery({ q: v }), 300);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  // Trace id: 32 karakter hex -> langsung buka halaman trace; selain itu tampilkan petunjuk.
  const [tid, setTid] = useState("");
  const [tidHint, setTidHint] = useState(false);
  const jump = () => {
    const v = tid.trim().toLowerCase();
    if (/^[0-9a-f]{32}$/.test(v)) navigate(`/p/${projectId}/traces/${v}`, { state: { fromTraces: location.search } });
    else setTidHint(true);
  };

  const services = useQuery({
    queryKey: ["trace-services", projectId, range],
    queryFn: () => api.get<{ services: string[] }>(`/projects/${projectId}/traces/services?range=${range}`),
    placeholderData: (prev) => prev,
  });
  const svcList = services.data?.services ?? [];

  return (
    <section>
      <div className="hero" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
        <div>
          <h1>Traces</h1>
          <p className="sub" style={{ marginTop: 8 }}>Search requests by their root span, newest first.</p>
        </div>
      </div>

      <div className="row trace-filters">
        <RangeTabs ranges={SEARCH_RANGES} value={range} onPick={(k) => setQuery({ range: k === "1h" ? "" : k })} />
      </div>
      <div className="row trace-filters">
        <select className="select" aria-label="Service" value={service} onChange={(e) => setQuery({ service: e.target.value })}>
          <option value="">All services</option>
          {service && !svcList.includes(service) && <option value={service}>{service}</option>}
          {svcList.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="select" aria-label="Minimum duration" value={minMs} onChange={(e) => setQuery({ minMs: e.target.value })}>
          {MIN_MS.map((m) => <option key={m.v} value={m.v}>{m.label}</option>)}
        </select>
        <label className="field trace-text">
          <Search size={16} />
          <input value={text} maxLength={200} placeholder="Endpoint or span name" aria-label="Endpoint or span name" onChange={(e) => setText(e.target.value)} />
        </label>
        <form className="trace-id" onSubmit={(e) => { e.preventDefault(); jump(); }}>
          <label className="field">
            <input value={tid} placeholder="Trace ID" aria-label="Trace ID" spellCheck={false}
              onChange={(e) => { setTid(e.target.value); setTidHint(false); }} />
          </label>
          <button type="submit" className="btn sm">Open</button>
          {tidHint && <span className="trace-id-hint" role="alert">Trace IDs are 32 hex characters</span>}
        </form>
      </div>

      <TraceResults projectId={projectId!} filters={{ range, status, service, q: urlQ, minMs }} backSearch={location.search}
        onStatus={(v) => setQuery({ status: v.join(",") })}
        page={page} size={size} onPage={(p) => setQuery({ page: p > 1 ? String(p) : "" })}
        onSize={(v) => setQuery({ size: v === DEFAULT_SIZE ? "" : String(v) })} />
    </section>
  );
}
