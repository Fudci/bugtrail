import { useQuery } from "@tanstack/react-query";
import { api, type TraceLogs as TraceLogsData } from "../api";
import { LogList } from "./LogList";

/** Log OTLP satu trace (kronologis); dipakai di halaman trace dan tab Logs halaman issue. */
export function TraceLogs({ projectId, traceId, emptyText = "No logs for this trace." }: { projectId: string; traceId: string; emptyText?: string }) {
  const q = useQuery({
    queryKey: ["trace-logs", projectId, traceId],
    queryFn: () => api.get<TraceLogsData>(`/projects/${projectId}/traces/${traceId}/logs`),
  });
  if (q.isPending) return <p className="sub">Loading…</p>;
  if (q.isError) return <p className="sub">Failed to load logs: {q.error.message}</p>;
  if (!q.data.enabled) return <p className="sub">Log ingest is not enabled on this server.</p>;
  if (q.data.logs.length === 0) return <p className="sub">{emptyText} Logs are linked when the OTLP log record carries this trace ID.</p>;
  return (
    <>
      <LogList projectId={projectId} logs={q.data.logs} />
      {q.data.truncated && <p className="sub" style={{ fontSize: 12, marginTop: 8 }}>Showing the first {q.data.logs.length} logs of this trace.</p>}
    </>
  );
}
