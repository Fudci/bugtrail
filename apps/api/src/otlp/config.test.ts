import { describe, expect, it } from "vitest";
import { readTelemetryConfig, TelemetryConfigError } from "./config.js";

describe("readTelemetryConfig", () => {
  it("defaults to SQLite", () => {
    expect(readTelemetryConfig({})).toEqual({ kind: "sqlite" });
    expect(readTelemetryConfig({ TELEMETRY_STORE: " SQLite " })).toEqual({ kind: "sqlite" });
  });

  it("reads ClickHouse settings with defaults for user and database", () => {
    expect(readTelemetryConfig({ TELEMETRY_STORE: "clickhouse", CLICKHOUSE_URL: "http://clickhouse:8123", CLICKHOUSE_PASSWORD: "x" }))
      .toEqual({ kind: "clickhouse", url: "http://clickhouse:8123", username: "default", password: "x", database: "bugtrail" });
  });

  it("explains what is missing or wrong", () => {
    expect(() => readTelemetryConfig({ TELEMETRY_STORE: "postgres" })).toThrow(/sqlite" or "clickhouse/);
    expect(() => readTelemetryConfig({ TELEMETRY_STORE: "clickhouse" })).toThrow(/CLICKHOUSE_URL/);
    expect(() => readTelemetryConfig({ TELEMETRY_STORE: "clickhouse", CLICKHOUSE_URL: "clickhouse:8123", CLICKHOUSE_PASSWORD: "x" })).toThrow(TelemetryConfigError);
    expect(() => readTelemetryConfig({ TELEMETRY_STORE: "clickhouse", CLICKHOUSE_URL: "http://clickhouse:8123" })).toThrow(/CLICKHOUSE_PASSWORD/);
  });
});
