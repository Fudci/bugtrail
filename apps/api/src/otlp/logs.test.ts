import { describe, expect, it } from "vitest";
import { sampleLogs } from "./fixtures.js";
import { flattenLogs, severityName, severityOf } from "./logs.js";
import { decodeLogsRequest } from "./protobuf.js";
import { logsToProtobuf } from "./fixtures.js";

describe("flattenLogs", () => {
  it("reads time, severity, body, trace link and service", () => {
    const [a, b] = flattenLogs(sampleLogs());
    expect(a).toMatchObject({
      timeUs: 1760000000000000, severityNumber: 17, severityText: "ERROR", service: "checkout-api",
      body: "order insert failed: Invalid column name 'coupon_id'", attributes: { "user.id": "user-10233" },
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7",
    });
    // time 0 -> observed time; severity dari teks; body map -> JSON
    expect(b).toMatchObject({ timeUs: 1760000000000001, severityNumber: 13, body: '{"msg":"slow query","ms":812}' });
    expect(b!.traceId).toBeUndefined();
  });

  it("decodes the same from protobuf", () => {
    expect(flattenLogs(decodeLogsRequest(logsToProtobuf(sampleLogs())))).toEqual(flattenLogs(sampleLogs()));
  });

  it("rejects bodies without resourceLogs", () => {
    expect(() => flattenLogs({ resourceSpans: [] })).toThrow("expected resourceLogs");
  });
});

describe("severity", () => {
  it("prefers the number, falls back to text", () => {
    expect(severityOf(9, "ERROR")).toBe(9);
    expect(severityOf(0, "Warning")).toBe(13);
    expect(severityOf(undefined, "nope")).toBe(0);
    expect([1, 5, 9, 13, 17, 21, 0].map(severityName)).toEqual(["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL", ""]);
  });
});
