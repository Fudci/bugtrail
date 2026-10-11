import { useState } from "react";
import { Link } from "react-router";
import type { LogRow } from "../api";
import { fmtTime } from "./health-util";

// Tingkat severity OTLP (1-24) -> label dan kelas warna.
export const severityLabel = (n: number, text?: string) =>
  n >= 21 ? "FATAL" : n >= 17 ? "ERROR" : n >= 13 ? "WARN" : n >= 9 ? "INFO" : n >= 5 ? "DEBUG" : n >= 1 ? "TRACE" : (text?.toUpperCase() || "LOG");
const severityClass = (n: number) => (n >= 17 ? "err" : n >= 13 ? "warn" : "");

/** Daftar log; klik baris = atribut + resource. showTrace = tautan ke trace (halaman Logs). */
export function LogList({ projectId, logs, showTrace = false, backSearch }: {
  projectId: string; logs: LogRow[]; showTrace?: boolean; backSearch?: string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="log-list" role="list">
      {logs.map((l) => {
        const on = open === l.id;
        return (
          <div key={l.id} role="listitem">
            <button type="button" className={`log-row ${on ? "on" : ""}`} aria-expanded={on} onClick={() => setOpen(on ? null : l.id)}>
              <span className="mono log-time">{fmtTime(l.timeUs)}</span>
              <span className={`tag log-sev ${severityClass(l.severityNumber)}`}>{severityLabel(l.severityNumber, l.severityText)}</span>
              <span className="log-svc" title={l.service}>{l.service ?? ""}</span>
              <span className="mono log-body">{l.body}</span>
            </button>
            {on && (
              <div className="log-detail">
                <pre className="log-full">{l.body}</pre>
                <dl>
                  {l.traceId && (
                    <><dt>Trace</dt><dd className="mono">
                      {showTrace ? <Link to={`/p/${projectId}/traces/${l.traceId}`} state={{ fromLogs: backSearch ?? "" }}>{l.traceId}</Link> : l.traceId}
                      {l.spanId && <span className="sub"> · span {l.spanId}</span>}
                    </dd></>
                  )}
                  {Object.entries(l.attributes).map(([k, v]) => <Attr key={`a:${k}`} k={k} v={v} />)}
                  {Object.entries(l.resource).map(([k, v]) => <Attr key={`r:${k}`} k={k} v={v} resource />)}
                </dl>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Attr({ k, v, resource }: { k: string; v: unknown; resource?: boolean }) {
  return (
    <>
      <dt className="mono" title={resource ? "resource attribute" : undefined}>{resource ? <span className="sub">{k}</span> : k}</dt>
      <dd className="mono">{typeof v === "string" ? v : JSON.stringify(v)}</dd>
    </>
  );
}
