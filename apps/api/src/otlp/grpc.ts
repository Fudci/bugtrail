import * as grpc from "@grpc/grpc-js";
import { MAX_ENVELOPE_BYTES } from "../ingest/envelope.js";
import { flattenSpans } from "./convert.js";
import type { LogIngest } from "./log-ingest.js";
import { flattenLogs } from "./logs.js";
import { decodeLogsRequest, decodeTraceRequest, encodeLogsSuccess, encodeStatusWithRetry, encodeSuccess } from "./protobuf.js";
import { publicKeyOf, type IngestResult, type TraceIngest } from "./trace-ingest.js";

// Penerima OTLP/gRPC untuk trace dan log (https://opentelemetry.io/docs/specs/otlp/#otlpgrpc), port standar 4317.
// Exporter: OTEL_EXPORTER_OTLP_PROTOCOL=grpc, OTEL_EXPORTER_OTLP_ENDPOINT=http://<bugtrail>:4317
//           OTEL_EXPORTER_OTLP_HEADERS=x-bugtrail-key=<public key DSN project>
// Pesan diteruskan sebagai bytes dan di-decode oleh protobuf.ts yang sama dengan OTLP/HTTP.

const raw = (b: Buffer) => b;

const TRACE_EXPORT: grpc.MethodDefinition<Buffer, Buffer> = {
  path: "/opentelemetry.proto.collector.trace.v1.TraceService/Export",
  requestStream: false, responseStream: false,
  requestSerialize: raw, requestDeserialize: raw, responseSerialize: raw, responseDeserialize: raw,
};

const LOGS_EXPORT: grpc.MethodDefinition<Buffer, Buffer> = { ...TRACE_EXPORT, path: "/opentelemetry.proto.collector.logs.v1.LogsService/Export" };

// HTTP status dari ingest -> kode gRPC. Kode yang tidak dikenal = INTERNAL; 400/413 tidak boleh jatuh ke sana
// karena exporter me-retry INTERNAL, padahal payload yang sama akan selalu ditolak.
const CODE: Record<number, grpc.status> = {
  400: grpc.status.INVALID_ARGUMENT, 413: grpc.status.RESOURCE_EXHAUSTED,
  401: grpc.status.UNAUTHENTICATED, 403: grpc.status.PERMISSION_DENIED,
  429: grpc.status.RESOURCE_EXHAUSTED, 503: grpc.status.UNAVAILABLE,
};

/** Error gRPC; RESOURCE_EXHAUSTED/UNAVAILABLE membawa RetryInfo supaya exporter me-retry setelah jeda. */
function grpcError(r: Exclude<IngestResult, { ok: true }>): grpc.ServerErrorResponse {
  const code = CODE[r.status] ?? grpc.status.INTERNAL;
  const metadata = new grpc.Metadata();
  if (r.retryAfter) metadata.set("grpc-status-details-bin", Buffer.from(encodeStatusWithRetry(code, r.message, r.retryAfter)));
  return Object.assign(new Error(r.message), { code, details: r.message, metadata });
}

const invalid = (message: string): grpc.ServerErrorResponse => Object.assign(new Error(message), { code: grpc.status.INVALID_ARGUMENT, details: message });

export function createOtlpGrpcServer(traces: TraceIngest, log: { error: (err: unknown, msg: string) => void }, logs?: LogIngest) {
  // Batas ukuran pesan sama dengan OTLP/HTTP (setelah dekompresi, grpc-js menangani grpc-encoding gzip).
  const server = new grpc.Server({ "grpc.max_receive_message_length": MAX_ENVELOPE_BYTES });

  // Alur yang sama untuk traces dan logs: auth metadata -> decode -> ingest -> status gRPC.
  function unary<T>(decode: (raw: Buffer) => T[], ingest: (projectId: string, items: T[]) => Promise<IngestResult>, success: () => Uint8Array) {
    return (call: grpc.ServerUnaryCall<Buffer, Buffer>, cb: grpc.sendUnaryData<Buffer>) => {
      void (async () => {
        const md = call.metadata;
        const publicKey = publicKeyOf(md.get("x-bugtrail-key")[0], md.get("authorization")[0]);
        if (!publicKey) return cb(grpcError({ ok: false, status: 401, message: "missing x-bugtrail-key metadata" }));
        const projectId = await traces.projectForKey(publicKey);
        if (!projectId) return cb(grpcError({ ok: false, status: 403, message: "invalid key" }));
        let items: T[];
        try {
          items = decode(call.request);
        } catch (err) {
          return cb(invalid((err as Error).message));
        }
        const r = await ingest(projectId, items);
        if (!r.ok) return cb(grpcError(r));
        cb(null, Buffer.from(success()));
      })().catch((err) => {
        log.error(err, "otlp grpc export failed");
        cb(grpcError({ ok: false, status: 503, message: "internal error", retryAfter: 10 }));
      });
    };
  }

  server.addService({ Export: TRACE_EXPORT }, { Export: unary((b) => flattenSpans(decodeTraceRequest(b)), traces.ingest, encodeSuccess) });
  if (logs) server.addService({ Export: LOGS_EXPORT }, { Export: unary((b) => flattenLogs(decodeLogsRequest(b)), logs.ingest, encodeLogsSuccess) });

  return {
    /** Mulai mendengarkan; mengembalikan port sebenarnya (berguna untuk port 0 di test). */
    listen: (port: number, host = "0.0.0.0") => new Promise<number>((resolve, reject) =>
      server.bindAsync(`${host}:${port}`, grpc.ServerCredentials.createInsecure(), (err, p) => (err ? reject(err) : resolve(p)))),
    /** Selesaikan panggilan yang sedang berjalan, paksa tutup setelah 5 detik. */
    close: () => new Promise<void>((resolve) => {
      const t = setTimeout(() => { server.forceShutdown(); resolve(); }, 5000);
      server.tryShutdown(() => { clearTimeout(t); resolve(); });
    }),
  };
}
