import { ArrowLeft } from "lucide-react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { TraceLogs } from "../components/TraceLogs";
import { TraceView } from "../components/TraceView";

export function TracePage() {
  const { projectId, traceId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  // Datang dari API Health -> kembali lewat history supaya filter/endpoint terpilih tetap ada.
  const st = location.state as { fromHealth?: boolean; fromTraces?: string; fromLogs?: string } | null;
  const fromHealth = Boolean(st?.fromHealth);
  // Datang dari pencarian Traces -> kembali ke pencarian dengan query yang sama (string search tersimpan di state).
  const fromTraces = typeof st?.fromTraces === "string" ? st.fromTraces : null;
  // Datang dari halaman Logs -> kembali ke Logs dengan filter yang sama.
  const fromLogs = typeof st?.fromLogs === "string" ? st.fromLogs : null;
  const backUrl = fromLogs !== null ? `/p/${projectId}/logs${fromLogs}` : fromTraces !== null ? `/p/${projectId}/traces${fromTraces}` : `/p/${projectId}/health`;

  return (
    <section>
      <div className="hero" style={{ alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <Link className="btn sm" to={backUrl} onClick={(e) => { if (fromHealth) { e.preventDefault(); navigate(-1); } }}>
            <ArrowLeft /> {fromLogs !== null ? "Logs" : fromTraces !== null ? "Traces" : "API Health"}
          </Link>
          <h1 style={{ marginTop: 12 }}>Trace</h1>
          <p className="sub mono" style={{ marginTop: 8, wordBreak: "break-all" }}>{traceId}</p>
        </div>
      </div>
      <div className="card">
        <TraceView path={`/projects/${projectId}/traces/${traceId}`} traceId={traceId!} notFoundText="Trace not stored (it may have been removed by retention)" />
      </div>
      <div className="card" style={{ marginTop: "var(--s5)" }}>
        <div className="head"><h2>Logs</h2></div>
        <TraceLogs projectId={projectId!} traceId={traceId!} />
      </div>
    </section>
  );
}
