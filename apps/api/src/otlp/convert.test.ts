import { describe, expect, it } from "vitest";
import { exceptionEvents, flattenSpans, hasException, OtlpError } from "./convert.js";
import { normalizeEvent } from "../process/normalize.js";
import { sampleRequest } from "./fixtures.js";

describe("flattenSpans", () => {
  it("reads ids, times (string and number int64), status, attributes and resource", () => {
    const spans = flattenSpans(sampleRequest());
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", kind: 2, statusCode: 2, durationUs: 612400, service: "checkout-api" });
    expect(spans[0]?.attributes).toMatchObject({ "http.status_code": 500, "enduser.id": "user-10233" });
    expect(spans[1]).toMatchObject({ parentSpanId: "00f067aa0ba902b7", durationUs: 355200 });
    expect(spans[0]?.resource["process.command_args"]).toEqual(["/usr/local/bin/node", "/app/app.js"]);
    expect(spans.map(hasException)).toEqual([true, false]);
  });

  it("rejects bodies without resourceSpans and skips spans with invalid ids", () => {
    expect(() => flattenSpans({})).toThrow(OtlpError);
    expect(flattenSpans({ resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: "00000000000000000000000000000000", spanId: "x" }] }] }] })).toEqual([]);
  });
});

describe("exceptionEvents", () => {
  it("builds a Sentry-shaped event that the existing pipeline normalizes and groups by in-app frames", () => {
    const span = flattenSpans(sampleRequest())[0]!;
    const [ev] = exceptionEvents(span);
    expect(ev).toMatchObject({ platform: "node", release: "2.4.1", environment: "production", transaction: "POST /orders",
      user: { id: "user-10233" }, tags: { service: "checkout-api", "http.status_code": "500" },
      contexts: { trace: { trace_id: "4bf92f3577b34da6a3ce929d0e0e4736", span_id: "00f067aa0ba902b7" } }, sdk: { name: "opentelemetry" } });

    const n = normalizeEvent(ev, new Date());
    expect(n.title).toBe("SequelizeDatabaseError: Invalid column name 'coupon_id'.");
    expect(n.culprit).toBe("POST /orders");
    const frames = n.exceptions[0]!.frames;
    expect(frames.at(-1)).toMatchObject({ filename: "node_modules/sequelize/lib/dialects/mssql/query.js", inApp: false });
    expect(frames.filter((f) => f.inApp).map((f) => f.filename)).toEqual(["controllers/order.controller.js", "services/order.service.js"]);
  });

  it("takes method/status/user from the trace's server span when the exception is on a middleware span", () => {
    const server = { ...flattenSpans(sampleRequest())[0]!, events: [] };
    const mw = { ...server, spanId: "2222222222222222", name: "middleware - <anonymous>", kind: 1,
      attributes: { "http.route": "/orders" }, events: flattenSpans(sampleRequest())[0]!.events };
    const [alone] = exceptionEvents(mw);
    expect(alone).toMatchObject({ transaction: "/orders" });
    const [ev] = exceptionEvents(mw, server);
    expect(ev).toMatchObject({ transaction: "POST /orders", user: { id: "user-10233" }, tags: { "http.status_code": "500" } });
  });
});

