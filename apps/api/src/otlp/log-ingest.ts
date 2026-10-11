import type { QuotaMeter } from "../process/quota.js";
import type { FlatLog, LogStore, StoredLog } from "./logs.js";
import { QueueFullError, type TelemetryQueue } from "./telemetry-queue.js";
import type { IngestResult } from "./trace-ingest.js";

// Ingest log OTLP, dipakai bersama OTLP/HTTP (/otlp/v1/logs) dan OTLP/gRPC (LogsService).
// Lite: langsung ke SQLite. Scale: ke antrian di disk (log_queue) lalu ke ClickHouse.
export function createLogIngest(deps: {
  store: LogStore;
  queue?: TelemetryQueue<StoredLog> | undefined;
  quota?: QuotaMeter | undefined;
  log: { error: (err: unknown, msg: string) => void };
}) {
  const { store, queue, quota, log } = deps;
  return {
    async ingest(projectId: string, logs: FlatLog[]): Promise<IngestResult> {
      if (!logs.length) return { ok: true };
      // Kuota log per menit: request ditolak utuh, exporter mengirim ulang setelah Retry-After.
      const q = quota?.consume(projectId, "logs", logs.length);
      if (q && !q.ok) return { ok: false, status: 429, message: "project quota exceeded", retryAfter: q.retryAfter };
      const stored = logs.map((l) => ({ ...l, projectId }));
      try {
        if (queue) queue.enqueue(stored);
        else await store.writeLogs(stored);
      } catch (err) {
        quota?.refund(projectId, "logs", logs.length);
        if (err instanceof QueueFullError) return { ok: false, status: 429, message: "log queue full", retryAfter: 10 };
        log.error(err, "otlp log write failed");
        return { ok: false, status: 503, message: "storage unavailable", retryAfter: 10 };
      }
      return { ok: true };
    },
  };
}

export type LogIngest = ReturnType<typeof createLogIngest>;
