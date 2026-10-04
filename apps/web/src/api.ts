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
  del: <T = void>(p: string) => request<T>("DELETE", p),
};

export type Role = "admin" | "member" | "viewer";
export type Level = "fatal" | "error" | "warning" | "info" | "debug";
export type IssueStatus = "unresolved" | "resolved" | "ignored";

export interface Me { id: string; email: string; name: string | null; isAdmin: boolean }
export interface ProjectSummary { id: string; name: string; slug: string; platform: string | null; role: Role; unresolvedIssues: number }
export interface ProjectDetail {
  id: string; name: string; slug: string; platform: string | null; role: Role;
  dsnKeys: { id: string; label: string; dsn: string }[];
  retentionMaxEvents: number; retentionDays: number;
  alerts: { discordWebhook: string | null; newIssue: boolean; regression: boolean; spikeThreshold: number | null; spikeMinutes: number } | null;
}
export interface ProjectStats { events: number; issues: number; oldestEventAt: string | null; dbSizeBytes: number | null }
export interface Person { id: string; name: string | null; email: string }
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
export interface UploadToken { id: string; name: string; createdAt: string; lastUsedAt: string | null; createdBy: { email: string } | null }
export interface ArtifactList {
  items: { id: string; debugId: string; url: string | null; size: number; createdAt: string; lastUsedAt: string | null }[];
  count: number; totalBytes: number;
}
export interface Member extends Person { role: Role; joinedAt: string }
export interface Invite { id: string; email: string; role: Role; expiresAt: string }
