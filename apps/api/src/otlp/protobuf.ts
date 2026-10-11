import protobuf from "protobufjs";
import descriptor from "./otlp-proto.json" with { type: "json" };

// OTLP/HTTP protobuf (application/x-protobuf). Deskriptor dari apps/api/proto (opentelemetry-proto v1.11.1),
// dibuat ulang dengan scripts/gen-otlp-proto.mjs. Hasil decode dibentuk sama dengan OTLP/JSON
// (id hex, int64 sebagai string, enum angka) supaya diurai oleh flattenSpans yang sama.
const root = protobuf.Root.fromJSON(descriptor);
const Request = root.lookupType("opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest");
const Response = root.lookupType("opentelemetry.proto.collector.trace.v1.ExportTraceServiceResponse");
const LogsRequest = root.lookupType("opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest");
const LogsResponse = root.lookupType("opentelemetry.proto.collector.logs.v1.ExportLogsServiceResponse");
const Status = root.lookupType("google.rpc.Status");
// google.rpc.RetryInfo (error_details.proto) untuk gRPC RESOURCE_EXHAUSTED: tanpa ini exporter OTLP tidak me-retry.
const RetryInfo = new protobuf.Type("RetryInfo").add(new protobuf.Field("retryDelay", 1, "Duration"))
  .add(new protobuf.Type("Duration").add(new protobuf.Field("seconds", 1, "int64")).add(new protobuf.Field("nanos", 2, "int32")));
new protobuf.Root().define("google.rpc").add(RetryInfo);

const ID_FIELDS = new Set(["traceId", "spanId", "parentSpanId"]);

// Bytes -> hex untuk id span/trace (spec OTLP/JSON memakai hex, protobuf memakai bytes).
function hexIds(v: unknown, key = ""): unknown {
  if (v instanceof Uint8Array) return ID_FIELDS.has(key) ? Buffer.from(v).toString("hex") : Buffer.from(v).toString("base64");
  if (Array.isArray(v)) return v.map((x) => hexIds(x));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = hexIds(x, k);
    return out;
  }
  return v;
}

export function decodeTraceRequest(body: Uint8Array): unknown {
  const msg = Request.decode(body);
  // longs: String = int64 sebagai string desimal (seperti OTLP/JSON); bytes tetap Uint8Array lalu di-hex.
  return hexIds(Request.toObject(msg, { longs: String, enums: Number, defaults: false, oneofs: false }));
}

export function decodeLogsRequest(body: Uint8Array): unknown {
  const msg = LogsRequest.decode(body);
  return hexIds(LogsRequest.toObject(msg, { longs: String, enums: Number, defaults: false, oneofs: false }));
}

/** ExportLogsServiceResponse kosong = sukses penuh. */
export function encodeLogsSuccess(): Uint8Array {
  return LogsResponse.encode(LogsResponse.create({})).finish();
}

/** ExportTraceServiceResponse kosong = sukses penuh. */
export function encodeSuccess(): Uint8Array {
  return Response.encode(Response.create({})).finish();
}

/** Error untuk klien protobuf: google.rpc.Status (spec OTLP/HTTP untuk respons 4xx/5xx). */
export function encodeStatus(code: number, message: string): Uint8Array {
  return Status.encode(Status.create({ code, message })).finish();
}

/** google.rpc.Status berisi RetryInfo, untuk trailer grpc-status-details-bin. */
export function encodeStatusWithRetry(code: number, message: string, retryAfterSec: number): Uint8Array {
  const info = RetryInfo.encode(RetryInfo.create({ retryDelay: { seconds: retryAfterSec } })).finish();
  return Status.encode(Status.create({ code, message, details: [{ type_url: "type.googleapis.com/google.rpc.RetryInfo", value: info }] })).finish();
}
