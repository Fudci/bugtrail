export interface AuthSources {
  authHeader?: string | undefined;
  queryKey?: string | undefined;
  envelopeDsn?: unknown;
}

// Format: "Sentry sentry_version=7, sentry_key=<key>, sentry_client=..."
export function keyFromAuthHeader(header: string): string | undefined {
  const body = header.replace(/^\s*Sentry\s+/i, "");
  for (const part of body.split(",")) {
    const [k, v] = part.split("=", 2).map((s) => s.trim());
    if (k === "sentry_key" && v) return v;
  }
  return undefined;
}

// DSN: https://<public_key>@host/<project_id>
export function keyFromDsn(dsn: string): string | undefined {
  try {
    return new URL(dsn).username || undefined;
  } catch {
    return undefined;
  }
}

export function extractPublicKey(src: AuthSources): string | undefined {
  if (src.authHeader) {
    const k = keyFromAuthHeader(src.authHeader);
    if (k) return k;
  }
  if (src.queryKey) return src.queryKey;
  if (typeof src.envelopeDsn === "string") return keyFromDsn(src.envelopeDsn);
  return undefined;
}
