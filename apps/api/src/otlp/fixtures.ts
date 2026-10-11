import protobuf from "protobufjs";
import descriptor from "./otlp-proto.json" with { type: "json" };

// Contoh ExportTraceServiceRequest (OTLP/JSON) untuk tes: request HTTP yang gagal karena error database.
const kv = (key: string, v: string | number | boolean) =>
  ({ key, value: typeof v === "string" ? { stringValue: v } : typeof v === "boolean" ? { boolValue: v } : Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v } });

export const sampleRequest = (traceId = "4bf92f3577b34da6a3ce929d0e0e4736") => ({
  resourceSpans: [{
    resource: { attributes: [kv("service.name", "checkout-api"), kv("service.version", "2.4.1"), kv("deployment.environment", "production"),
      { key: "process.command_args", value: { arrayValue: { values: [{ stringValue: "/usr/local/bin/node" }, { stringValue: "/app/app.js" }] } } }] },
    scopeSpans: [{ scope: { name: "@opentelemetry/instrumentation-http" }, spans: [
      { traceId, spanId: "00f067aa0ba902b7", name: "POST /orders", kind: 2,
        startTimeUnixNano: "1759586772418000000", endTimeUnixNano: "1759586773030400000",
        attributes: [kv("http.method", "POST"), kv("http.route", "/orders"), kv("http.status_code", 500), kv("enduser.id", "user-10233")],
        status: { code: 2, message: "Invalid column name 'coupon_id'." },
        events: [{ name: "exception", timeUnixNano: "1759586773000000000", attributes: [
          kv("exception.type", "SequelizeDatabaseError"), kv("exception.message", "Invalid column name 'coupon_id'."),
          kv("exception.stacktrace", "SequelizeDatabaseError: Invalid column name 'coupon_id'.\n    at Query.run (/app/node_modules/sequelize/lib/dialects/mssql/query.js:115:25)\n    at async createOrder (/app/services/order.service.js:142:5)\n    at async checkIn (/app/controllers/order.controller.js:88:20)")] }] },
      { traceId, spanId: "1111111111111111", parentSpanId: "00f067aa0ba902b7", name: "SELECT coupons", kind: 3,
        startTimeUnixNano: 1759586772442000000, endTimeUnixNano: 1759586772797200000, attributes: [kv("db.system", "mssql")] },
    ] }],
  }],
});


const Request = protobuf.Root.fromJSON(descriptor).lookupType("opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest");

// Ubah fixture OTLP/JSON ke protobuf: id hex -> bytes (seperti exporter protobuf sungguhan).
export function toProtobuf(json: unknown, type = Request): Uint8Array {
  const ids = (v: unknown, k = ""): unknown =>
    Array.isArray(v) ? v.map((x) => ids(x)) :
    v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([kk, x]) => [kk, ids(x, kk)])) :
    ["traceId", "spanId", "parentSpanId"].includes(k) && typeof v === "string" ? Buffer.from(v, "hex") : v;
  return type.encode(type.fromObject(ids(json) as Record<string, unknown>)).finish();
}

const LogsRequest = protobuf.Root.fromJSON(descriptor).lookupType("opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest");

// Contoh ExportLogsServiceRequest (OTLP/JSON): satu log terkait trace, satu log tanpa trace dengan body terstruktur.
export const sampleLogs = (traceId = "4bf92f3577b34da6a3ce929d0e0e4736", t = "1760000000000000000") => ({
  resourceLogs: [{
    resource: { attributes: [{ key: "service.name", value: { stringValue: "checkout-api" } }] },
    scopeLogs: [{
      logRecords: [
        {
          timeUnixNano: t, severityNumber: 17, severityText: "ERROR",
          body: { stringValue: "order insert failed: Invalid column name 'coupon_id'" },
          attributes: [{ key: "user.id", value: { stringValue: "user-10233" } }],
          traceId, spanId: "00f067aa0ba902b7",
        },
        {
          timeUnixNano: "0", observedTimeUnixNano: String(BigInt(t) + 1000n), severityText: "warn",
          body: { kvlistValue: { values: [{ key: "msg", value: { stringValue: "slow query" } }, { key: "ms", value: { intValue: "812" } }] } },
        },
      ],
    }],
  }],
});
export const logsToProtobuf = (json: unknown) => toProtobuf(json, LogsRequest);
