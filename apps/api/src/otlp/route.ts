import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { decompress, EnvelopeError, MAX_ENVELOPE_BYTES } from "../ingest/envelope.js";
import { flattenSpans, OtlpError } from "./convert.js";
import type { LogIngest } from "./log-ingest.js";
import { flattenLogs } from "./logs.js";
import { decodeLogsRequest, decodeTraceRequest, encodeLogsSuccess, encodeStatus, encodeSuccess } from "./protobuf.js";
import { publicKeyOf, type IngestResult, type TraceIngest } from "./trace-ingest.js";

// Penerima OTLP/HTTP untuk trace dan log (https://opentelemetry.io/docs/specs/otlp/); logika ingest di trace-ingest.ts / log-ingest.ts.
// Exporter: OTEL_EXPORTER_OTLP_ENDPOINT=https://<bugtrail>/otlp  (SDK menambahkan /v1/traces dan /v1/logs)
//           OTEL_EXPORTER_OTLP_HEADERS=x-bugtrail-key=<public key DSN project>

// HTTP status -> kode google.rpc (https://github.com/googleapis/googleapis/blob/master/google/rpc/code.proto).
const GRPC_CODE: Record<number, number> = { 400: 3, 401: 16, 403: 7, 413: 3, 415: 3, 429: 8, 503: 14 };

export async function otlpRoutes(app: FastifyInstance, opts: { traces: TraceIngest; logs?: LogIngest | undefined }) {
  const { traces, logs } = opts;

  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: MAX_ENVELOPE_BYTES }, (_req, body, done) => done(null, body));

  // Alur yang sama untuk traces dan logs: auth -> decode (JSON/protobuf) -> ingest -> respons sesuai Content-Type.
  function handler<T>(decodeProto: (raw: Uint8Array) => unknown, flatten: (body: unknown) => T[], ingest: (projectId: string, items: T[]) => Promise<IngestResult>, success: () => Uint8Array) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const type = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
      const proto = type === "application/x-protobuf";
      // Spec OTLP/HTTP: balas dengan Content-Type yang sama; error protobuf = google.rpc.Status.
      const fail = (code: number, message: string) => proto
        ? reply.code(code).header("content-type", "application/x-protobuf").send(Buffer.from(encodeStatus(GRPC_CODE[code] ?? 2, message)))
        : reply.code(code).send({ message });
      if (!proto && type !== "application/json") return fail(415, "content-type must be application/json or application/x-protobuf");

      const publicKey = publicKeyOf(req.headers["x-bugtrail-key"], req.headers["authorization"]);
      if (!publicKey) return fail(401, "missing x-bugtrail-key header");
      const projectId = await traces.projectForKey(publicKey);
      if (!projectId) return fail(403, "invalid key");

      let items: T[];
      try {
        const raw = decompress(req.body as Buffer, req.headers["content-encoding"]);
        items = flatten(proto ? decodeProto(raw) : JSON.parse(raw.toString("utf8")));
      } catch (err) {
        // protobufjs melempar Error biasa (mis. "index out of range") untuk data yang rusak.
        if (err instanceof OtlpError || err instanceof EnvelopeError || err instanceof SyntaxError || proto) {
          return fail(400, (err as Error).message);
        }
        throw err;
      }

      const r = await ingest(projectId, items);
      if (!r.ok) {
        if (r.retryAfter) reply.header("retry-after", String(r.retryAfter));
        return fail(r.status, r.message);
      }
      // Export*ServiceResponse kosong = sukses penuh.
      return proto
        ? reply.header("content-type", "application/x-protobuf").send(Buffer.from(success()))
        : reply.header("content-type", "application/json").send({});
    };
  }

  app.post("/otlp/v1/traces", handler(decodeTraceRequest, flattenSpans, traces.ingest, encodeSuccess));
  if (logs) app.post("/otlp/v1/logs", handler(decodeLogsRequest, (b) => flattenLogs(b), logs.ingest, encodeLogsSuccess));
}
