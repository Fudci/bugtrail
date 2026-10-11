export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/0${path}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { detail?: string }).detail ?? res.statusText);
  return data as T;
}

export const api = {
  get: <T>(p: string) => request<T>("GET", p),
  post: <T>(p: string, b: unknown = {}) => request<T>("POST", p, b),
  patch: <T>(p: string, b: unknown) => request<T>("PATCH", p, b),
  put: <T>(p: string, b: unknown) => request<T>("PUT", p, b),
  del: <T = void>(p: string) => request<T>("DELETE", p),
};

export type Role = "admin" | "member" | "viewer";
export type Level = "fatal" | "error" | "warning" | "info" | "debug";
export type IssueStatus = "unresolved" | "resolved" | "ignored";

export interface Me { id: string; username: string; email: string | null; name: string | null; isAdmin: boolean }
export interface ProjectSummary { id: string; name: string; slug: string; platform: string | null; role: Role; unresolvedIssues: number }
export interface UsageHour { hour: number; events: number; spans: number; droppedEvents: number; droppedSpans: number }
export interface ProjectUsage {
  hours: UsageHour[];
  quotaEventsPerMin: number | null; quotaSpansPerMin: number | null;
  /** logs/droppedLogs kosong dari server versi lama. */
  currentMinute: { events: number; spans: number; logs?: number };
  totals: { events: number; spans: number; droppedEvents: number; droppedSpans: number; droppedLogs?: number };
}

export interface ProjectDetail {
  id: string; name: string; slug: string; platform: string | null; role: Role;
  dsnKeys: { id: string; label: string; dsn: string }[];
  retentionMaxEvents: number; retentionDays: number; slowTraceMs: number | null;
  quotaEventsPerMin: number | null; quotaSpansPerMin: number | null; overQuota: boolean;
  /** undefined dari server versi lama. */
  quotaLogsPerMin?: number | null;
  traceStorage: { kind: string; allSpans: boolean } | null;
  alerts: { discordWebhook: string | null; newIssue: boolean; regression: boolean; spikeThreshold: number | null; spikeMinutes: number;
    /** Interval ringkasan "ongoing errors" (detik), null = mati; undefined dari server versi lama. */
    ongoingSeconds?: number | null; ongoingBackoff?: boolean } | null;
}
export interface ProjectStats { events: number; issues: number; oldestEventAt: string | null; dbSizeBytes: number | null }
export interface Person { id: string; username: string; name: string | null; email: string | null }
export interface IssueSummary {
  id: string; title: string; culprit: string | null; level: Level; status: IssueStatus;
  eventCount: number; firstSeen: string; lastSeen: string; assignee: Person | null;
  spark?: number[]; // event per hari, 14 hari terakhir (hanya di daftar issues)
}
export interface EventDetail {
  id: string; receivedAt: string; timestamp: string; level: Level;
  release: string | null; environment: string | null; userId: string | null;
  payload: Record<string, unknown>;
}
export interface IssueDetail extends IssueSummary {
  projectId: string; role: Role; userCount: number; latestEvent: EventDetail | null;
  /** Debug ID yang dirujuk event tapi source map-nya belum diunggah. */
  sourcemapsMissing: string[];
}
export interface UploadToken { id: string; name: string; createdAt: string; lastUsedAt: string | null; createdBy: { email: string | null; username: string } | null }
export interface ArtifactList {
  items: { id: string; debugId: string; url: string | null; size: number; createdAt: string; lastUsedAt: string | null }[];
  count: number; totalBytes: number;
}
export interface Member extends Person { role: Role; joinedAt: string }
export interface Invite { id: string; email: string | null; role: Role; expiresAt: string }
export interface HealthEndpoint { method: string; route: string; count: number; c4xx: number; c5xx: number; errorRate: number; p50: number | null; p95: number | null; p99: number | null; series: number[]; errSeries: number[]; breaches: number }
export interface HealthThreshold { pct: number; minRequests: number }
export interface HealthList { range: "1h" | "24h" | "7d"; bucketSeconds: number; threshold: HealthThreshold; endpoints: HealthEndpoint[] }
export interface RequestError { type?: string; message?: string; stacktrace?: string; spanName?: string }
export interface HealthRequest { traceId: string; spanId: string; startUs: number; durationUs: number; status: number; method: string; route: string; service?: string; error: RequestError | null; slow?: boolean }
export interface TopError { type?: string; message: string; count: number }
/**
 * topErrors merangkum seluruh jendela filter (sama di setiap halaman). total = request tersimpan yang cocok filter;
 * observed (Lite saja) = jumlah request sebenarnya dari rollup.
 */
/** Body span server (dimuat saat baris dibuka); tiap field dipotong 64K karakter, truncatedFields = yang terpotong. */
export interface RequestBody {
  request?: string; query?: string; response?: string; userId?: string;
  truncated?: true; truncatedFields?: ("request" | "query" | "response" | "userId")[];
}
export interface HealthRequests {
  sampled: boolean; requests: HealthRequest[]; topErrors: TopError[] | null; nextBefore: string | null;
  total: number; page: number; size: number; observed?: number;
  /** Jumlah per kode status untuk filter yang sama tanpa filter status (server lama: tidak ada). */
  statusCounts?: { code: number; count: number }[];
}
export interface TraceRow { traceId: string; spanId: string; startUs: number; durationUs: number; service?: string; name: string; statusCode: number; httpStatus?: number; spanCount: number; error: RequestError | null; slow?: boolean }
export interface TraceSearch { sampled: boolean; traces: TraceRow[]; nextBefore: string | null; total: number; page: number; size: number; statusCounts?: { code: number; count: number }[] }
export interface HealthPoint { t: number; count: number; c4xx: number; c5xx: number; p50: number | null; p95: number | null; p99: number | null }

// Service map (GET /projects/:id/services). Latensi dalam ms (10001 = > 10 s), errors = status ERROR atau HTTP 5xx.
export interface ServiceStats { count: number; errors: number; errorRate: number; p50: number | null; p95: number | null; p99: number | null }
export interface ServiceNode extends ServiceStats { name: string; series: number[]; errSeries: number[] }
export interface ServiceEdge extends ServiceStats { source: string; target: string; external: boolean }
export interface ServiceList { range: "1h" | "24h" | "7d"; bucketSeconds: number; services: ServiceNode[]; edges: ServiceEdge[] }
export interface ServicePoint { t: number; count: number; errors: number; p50: number | null; p95: number | null; p99: number | null }
export interface ServiceEndpoint { method: string; route: string; count: number; c4xx: number; c5xx: number; errorRate: number; p50: number | null; p95: number | null; p99: number | null }
export interface ServiceDetail extends ServiceStats {
  bucketSeconds: number; service: string; series: ServicePoint[]; upstream: ServiceEdge[]; downstream: ServiceEdge[];
  /** Kosong dari server versi lama. */
  endpoints?: ServiceEndpoint[];
}

// OTLP logs (GET /projects/:id/logs, /traces/:traceId/logs). severityNumber 1-24 (0 = tidak diketahui).
export interface LogRow {
  id: string; timeUs: number; severityNumber: number; severityText?: string; service?: string; body: string;
  attributes: Record<string, unknown>; resource: Record<string, unknown>; traceId?: string; spanId?: string;
}
export interface LogPage { enabled: boolean; logs: LogRow[]; nextBefore: string | null; fromUs?: number }
export interface TraceLogs { enabled: boolean; logs: LogRow[]; truncated: boolean }

// Aturan alert (GET/POST/PUT /projects/:id/alert-rules), hanya admin.
export interface AlertRuleInput {
  name: string; enabled: boolean; kind: "status" | "latency";
  /** Token status seperti di API Health ("5xx,403"); hanya untuk kind "status". */
  statusFilter: string | null; mode: "pct" | "count"; percentile: 50 | 95 | 99 | null;
  threshold: number; windowMinutes: number; minRequests: number;
  /** Keduanya null = semua endpoint. */
  method: string | null; route: string | null;
}
export interface AlertRule extends AlertRuleInput { id: string; summary: string }
