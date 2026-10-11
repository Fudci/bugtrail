// Pilihan penyimpanan telemetry dari environment:
//   TELEMETRY_STORE=sqlite (default)  -> mode Lite: hanya trace yang berisi error, di SQLite
//   TELEMETRY_STORE=clickhouse        -> mode Scale: semua span ke ClickHouse (butuh CLICKHOUSE_URL)
export type TelemetryConfig =
  | { kind: "sqlite" }
  | { kind: "clickhouse"; url: string; username: string; password: string; database: string };

export class TelemetryConfigError extends Error {}

export function readTelemetryConfig(env: Record<string, string | undefined>): TelemetryConfig {
  const kind = (env["TELEMETRY_STORE"] ?? "sqlite").trim().toLowerCase();
  if (kind === "" || kind === "sqlite") return { kind: "sqlite" };
  if (kind !== "clickhouse") throw new TelemetryConfigError(`TELEMETRY_STORE must be "sqlite" or "clickhouse", got "${kind}"`);

  const url = env["CLICKHOUSE_URL"]?.trim();
  if (!url) throw new TelemetryConfigError("TELEMETRY_STORE=clickhouse needs CLICKHOUSE_URL (e.g. http://clickhouse:8123)");
  if (!/^https?:\/\//.test(url)) throw new TelemetryConfigError(`CLICKHOUSE_URL must start with http:// or https://, got "${url}"`);
  // Jangan biarkan ClickHouse tanpa password: data trace bisa berisi data pengguna.
  if (!env["CLICKHOUSE_PASSWORD"]) throw new TelemetryConfigError("TELEMETRY_STORE=clickhouse needs CLICKHOUSE_PASSWORD (set the same value for the clickhouse service)");
  return {
    kind: "clickhouse",
    url,
    username: env["CLICKHOUSE_USER"]?.trim() || "default",
    password: env["CLICKHOUSE_PASSWORD"],
    database: env["CLICKHOUSE_DATABASE"]?.trim() || "bugtrail",
  };
}
