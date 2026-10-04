import { createHash } from "node:crypto";

export type Level = "fatal" | "error" | "warning" | "info" | "debug";
const LEVELS = new Set<string>(["fatal", "error", "warning", "info", "debug"]);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

export interface Frame {
  filename?: string | undefined;
  module?: string | undefined;
  function?: string | undefined;
  lineno?: number | undefined;
  inApp?: boolean | undefined;
}

export interface ExceptionValue {
  type?: string | undefined;
  value?: string | undefined;
  frames: Frame[];
}

export interface NormalizedEvent {
  eventId: string;
  timestamp: Date;
  level: Level;
  release?: string | undefined;
  environment?: string | undefined;
  userId?: string | undefined;
  message?: string | undefined;
  exceptions: ExceptionValue[];
  fingerprint?: string[] | undefined;
  title: string;
  culprit?: string | undefined;
}

// event_id SDK: 32 hex tanpa tanda hubung -> bentuk uuid untuk kolom @db.Uuid.
export function toUuid(eventId: string): string {
  const h = eventId.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(h)) throw new Error(`invalid event_id: ${eventId}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function parseTimestamp(v: unknown, fallback: Date): Date {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v * 1000);
  if (typeof v === "string") {
    const asNum = Number(v);
    const d = Number.isFinite(asNum) && v.trim() !== "" ? new Date(asNum * 1000) : new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return fallback;
}

function parseFrames(stacktrace: unknown): Frame[] {
  if (!isObj(stacktrace) || !Array.isArray(stacktrace["frames"])) return [];
  return stacktrace["frames"].filter(isObj).map((f) => ({
    filename: str(f["filename"]) ?? str(f["abs_path"]),
    module: str(f["module"]),
    function: str(f["function"]),
    lineno: typeof f["lineno"] === "number" ? f["lineno"] : undefined,
    inApp: typeof f["in_app"] === "boolean" ? f["in_app"] : undefined,
  }));
}

function parseExceptions(exc: unknown): ExceptionValue[] {
  // Bisa {values:[...]} atau array langsung (bentuk lama).
  const values = isObj(exc) ? exc["values"] : exc;
  if (!Array.isArray(values)) return [];
  return values.filter(isObj).map((v) => ({
    type: str(v["type"]),
    value: str(v["value"]),
    frames: parseFrames(v["stacktrace"]),
  }));
}

function parseMessage(e: Obj): string | undefined {
  const le = e["logentry"] ?? e["sentry.interfaces.Message"];
  if (isObj(le)) return str(le["formatted"]) ?? str(le["message"]);
  if (isObj(e["message"])) return str(e["message"]["formatted"]) ?? str(e["message"]["message"]);
  return str(e["message"]);
}

// Frame paling relevan = frame in_app terakhir (paling dalam), fallback frame terakhir.
function topFrame(frames: Frame[]): Frame | undefined {
  return [...frames].reverse().find((f) => f.inApp) ?? frames.at(-1);
}

export function normalizeEvent(payload: unknown, receivedAt: Date): NormalizedEvent {
  if (!isObj(payload)) throw new Error("event payload must be an object");
  const eventId = str(payload["event_id"]);
  if (!eventId) throw new Error("event_id missing");

  const exceptions = parseExceptions(payload["exception"]);
  const message = parseMessage(payload);
  const level = str(payload["level"]);
  const user = payload["user"];
  const fp = payload["fingerprint"];

  // Exception terakhir di values = exception utama (urutan chain dari yang paling awal).
  const main = exceptions.at(-1);
  const title = main
    ? [main.type, main.value].filter(Boolean).join(": ") || "<unknown error>"
    : (message?.split("\n")[0] ?? "<no message>");
  const tf = main ? topFrame(main.frames) : undefined;
  const culprit = str(payload["culprit"]) ?? str(payload["transaction"]) ??
    (tf ? [tf.module ?? tf.filename, tf.function].filter(Boolean).join(" in ") || undefined : undefined);

  return {
    eventId: toUuid(eventId),
    timestamp: parseTimestamp(payload["timestamp"], receivedAt),
    level: level && LEVELS.has(level) ? (level as Level) : "error",
    release: str(payload["release"]),
    environment: str(payload["environment"]),
    userId: isObj(user) ? (str(user["id"]) ?? str(user["email"]) ?? str(user["username"])) : undefined,
    message,
    exceptions,
    fingerprint: Array.isArray(fp) && fp.length > 0 ? fp.map(String) : undefined,
    title: title.slice(0, 500),
    culprit: culprit?.slice(0, 500),
  };
}

const sha = (parts: string[]) => createHash("sha256").update(parts.join("\x00")).digest("hex");

// Ganti uuid, hex panjang, dan angka supaya pesan dengan id berbeda tetap satu grup.
export function scrubMessage(msg: string): string {
  return msg
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\b0x[0-9a-f]+\b|\b[0-9a-f]{16,}\b/gi, "<hex>")
    .replace(/\d+(\.\d+)?/g, "<n>");
}

export function defaultFingerprint(e: NormalizedEvent): string {
  const withFrames = e.exceptions.filter((x) => x.frames.length > 0);
  if (withFrames.length > 0) {
    const parts: string[] = [];
    for (const x of withFrames) {
      const inApp = x.frames.filter((f) => f.inApp);
      const frames = inApp.length > 0 ? inApp : x.frames;
      parts.push(`type:${x.type ?? ""}`);
      for (const f of frames) parts.push(`${f.module ?? f.filename ?? "?"}|${f.function ?? "?"}`);
    }
    return sha(["stack", ...parts]);
  }
  const main = e.exceptions.at(-1);
  if (main) return sha(["exc", main.type ?? "", scrubMessage(main.value ?? "")]);
  return sha(["msg", scrubMessage(e.message ?? e.title)]);
}

export function computeFingerprint(e: NormalizedEvent): string {
  if (!e.fingerprint) return defaultFingerprint(e);
  const resolved = e.fingerprint.map((p) => (p === "{{ default }}" ? defaultFingerprint(e) : p));
  return sha(["custom", ...resolved]);
}
