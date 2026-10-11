import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { parseNodeStack } from "./stack.js";

// OTLP/HTTP JSON (ExportTraceServiceRequest) -> span datar + event error berformat Sentry.
// Spesifikasi: https://opentelemetry.io/docs/specs/otlp/ — id hex, enum angka, int64 boleh string atau number.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

export type Attrs = Record<string, unknown>;

export interface FlatSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string | undefined;
  name: string;
  kind: number;
  startUs: number;
  durationUs: number;
  statusCode: number; // 0 UNSET, 1 OK, 2 ERROR
  statusMessage?: string | undefined;
  attributes: Attrs;
  events: { name: string; timeUs: number; attributes: Attrs }[];
  resource: Attrs;
  service?: string | undefined;
}

export class OtlpError extends Error {}

function anyValue(v: unknown): unknown {
  if (!isObj(v)) return undefined;
  if ("stringValue" in v) return v["stringValue"];
  if ("boolValue" in v) return v["boolValue"];
  if ("intValue" in v) return Number(v["intValue"]);
  if ("doubleValue" in v) return Number(v["doubleValue"]);
  if (isObj(v["arrayValue"])) return ((v["arrayValue"]["values"] as unknown[]) ?? []).map(anyValue);
  if (isObj(v["kvlistValue"])) return attrs(v["kvlistValue"]["values"]);
  if ("bytesValue" in v) return v["bytesValue"];
  return undefined;
}

export function attrs(list: unknown): Attrs {
  const out: Attrs = {};
  if (!Array.isArray(list)) return out;
  for (const kv of list) if (isObj(kv) && typeof kv["key"] === "string") out[kv["key"]] = anyValue(kv["value"]);
  return out;
}

// int64 nanodetik (string atau number) -> mikrodetik. Mikrodetik masih aman di Number (< 2^53).
const nsToUs = (v: unknown): number => {
  if (typeof v === "number") return Math.floor(v / 1000);
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(BigInt(v) / 1000n);
  return 0;
};
const hexId = (v: unknown, len: number): string | undefined => {
  const s = str(v)?.toLowerCase();
  return s && s.length === len && /^[0-9a-f]+$/.test(s) && !/^0+$/.test(s) ? s : undefined;
};

export function flattenSpans(body: unknown): FlatSpan[] {
  if (!isObj(body) || !Array.isArray(body["resourceSpans"])) throw new OtlpError("expected resourceSpans");
  const out: FlatSpan[] = [];
  for (const rs of body["resourceSpans"]) {
    if (!isObj(rs)) continue;
    const resource = attrs(isObj(rs["resource"]) ? rs["resource"]["attributes"] : undefined);
    for (const ss of Array.isArray(rs["scopeSpans"]) ? rs["scopeSpans"] : []) {
      if (!isObj(ss) || !Array.isArray(ss["spans"])) continue;
      for (const s of ss["spans"]) {
        if (!isObj(s)) continue;
        const traceId = hexId(s["traceId"], 32), spanId = hexId(s["spanId"], 16);
        if (!traceId || !spanId) continue;
        const start = nsToUs(s["startTimeUnixNano"]), end = nsToUs(s["endTimeUnixNano"]);
        const status = isObj(s["status"]) ? s["status"] : {};
        out.push({
          traceId,
          spanId,
          parentSpanId: hexId(s["parentSpanId"], 16),
          name: str(s["name"]) ?? "<unnamed>",
          kind: Number(s["kind"] ?? 0) || 0,
          startUs: start,
          durationUs: Math.max(0, end - start),
          statusCode: Number(status["code"] ?? 0) || 0,
          statusMessage: str(status["message"]),
          attributes: attrs(s["attributes"]),
          events: (Array.isArray(s["events"]) ? s["events"] : []).filter(isObj).map((e) => ({
            name: str(e["name"]) ?? "",
            timeUs: nsToUs(e["timeUnixNano"]),
            attributes: attrs(e["attributes"]),
          })),
          resource,
          service: str(resource["service.name"]),
        });
      }
    }
  }
  return out;
}

export const hasException = (s: FlatSpan) => s.events.some((e) => e.name === "exception");

// Atribut lama dan baru (semconv HTTP berubah di v1.20; deployment.environment -> .name).
const pick = (a: Attrs, ...keys: string[]) => {
  for (const k of keys) if (a[k] !== undefined && a[k] !== null && a[k] !== "") return a[k];
  return undefined;
};

// Root aplikasi untuk memendekkan path frame: dari process.command_args ([node, /app/app.js]).
function appRoots(resource: Attrs): string[] {
  const args = resource["process.command_args"];
  const script = Array.isArray(args) ? args.find((a, i) => i > 0 && typeof a === "string" && a.startsWith("/")) : undefined;
  return typeof script === "string" ? [dirname(script)] : [];
}

// Satu event error berformat Sentry per exception event di span. Masuk ke pipeline ingest yang sama.
// `server`: span SERVER (kind 2) dari trace yang sama kalau ada di batch ini. Instrumentasi Express
// merekam exception di span middleware/handler yang tidak punya method/status/user; itu ada di span server.
export function exceptionEvents(span: FlatSpan, server?: FlatSpan): Record<string, unknown>[] {
  const a = server && server !== span ? { ...server.attributes, ...span.attributes } : span.attributes;
  const r = span.resource;
  const method = str(pick(a, "http.request.method", "http.method"));
  const route = str(pick(a, "http.route"));
  const path = str(pick(a, "url.path", "http.target"));
  const status = pick(a, "http.response.status_code", "http.status_code");
  const userId = pick(a, "enduser.id", "user.id");
  const where = route ?? path;
  const transaction = method && where ? `${method} ${where}` : (where ?? (server?.name || span.name));
  const roots = appRoots(r);

  return span.events.filter((e) => e.name === "exception").map((e) => {
    const type = str(e.attributes["exception.type"]);
    const message = str(e.attributes["exception.message"]);
    const stack = str(e.attributes["exception.stacktrace"]);
    const tags: Record<string, string> = { "otel.span": span.name };
    if (span.service) tags["service"] = span.service;
    if (method) tags["http.method"] = method;
    if (route) tags["http.route"] = route;
    if (status !== undefined) tags["http.status_code"] = String(status);
    return {
      event_id: randomUUID().replace(/-/g, ""),
      timestamp: (e.timeUs || span.startUs + span.durationUs) / 1e6,
      platform: "node",
      level: "error",
      logger: "opentelemetry",
      release: str(pick(r, "service.version")),
      environment: str(pick(r, "deployment.environment.name", "deployment.environment")),
      transaction,
      server_name: str(pick(r, "host.name")),
      exception: { values: [{ type: type ?? "Error", value: message, stacktrace: stack ? { frames: parseNodeStack(stack, roots) } : undefined }] },
      tags,
      user: userId !== undefined ? { id: String(userId) } : undefined,
      request: method ? { method, url: str(pick(a, "url.full", "http.url")) ?? path } : undefined,
      contexts: {
        trace: { trace_id: span.traceId, span_id: span.spanId, parent_span_id: span.parentSpanId, op: span.name, status: span.statusCode === 2 ? "internal_error" : undefined },
        otel: { attributes: a, resource: r },
        runtime: str(r["process.runtime.name"]) ? { name: r["process.runtime.name"], version: r["process.runtime.version"] } : undefined,
      },
      sdk: { name: "opentelemetry", version: str(r["telemetry.sdk.version"]) },
    };
  });
}
