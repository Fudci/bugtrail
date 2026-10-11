// k6: kirim batch OTLP/HTTP JSON (seperti BatchSpanProcessor) dengan laju tetap (RATE req/detik).
// Tiap request berisi SPANS span dari beberapa trace; ERROR_PCT% trace berisi exception.
import http from "k6/http";
import { check } from "k6";

const RATE = Number(__ENV.RATE);
const DURATION = __ENV.DURATION || "60s";
const URL = __ENV.URL;                       // https://<bugtrail>/otlp/v1/traces
const KEY = __ENV.KEY;                       // public key DSN project
const SPANS = Number(__ENV.SPANS || 50);     // span per request
const PER_TRACE = 5;                         // span per trace (server + 4 anak)
const ERROR_PCT = Number(__ENV.ERROR_PCT || 5);

export const options = {
  discardResponseBodies: true,
  scenarios: {
    otlp: {
      executor: "constant-arrival-rate",
      rate: RATE,
      timeUnit: "1s",
      duration: DURATION,
      preAllocatedVUs: Math.min(Math.max(RATE, 10), 2000),
      maxVUs: Math.min(Math.max(RATE * 4, 50), 8000),
      gracefulStop: "10s",
    },
  },
  summaryTrendStats: ["avg", "med", "p(95)", "p(99)", "max"],
};

const hex = (n) => {
  let s = "";
  for (let i = 0; i < n; i++) s += "0123456789abcdef"[(Math.random() * 16) | 0];
  return s;
};
const str = (key, v) => ({ key, value: { stringValue: v } });
const int = (key, v) => ({ key, value: { intValue: String(v) } });
const ROUTES = ["/attendance", "/profile", "/payroll/slips", "/leave/:id", "/announcements"];

function trace(nowNs) {
  const traceId = hex(32), root = hex(16), error = Math.random() * 100 < ERROR_PCT;
  const route = ROUTES[(Math.random() * ROUTES.length) | 0];
  const t0 = nowNs - 50_000_000;
  const spans = [{
    traceId, spanId: root, name: `POST ${route}`, kind: 2,
    startTimeUnixNano: String(t0), endTimeUnixNano: String(t0 + 40_000_000),
    attributes: [str("http.request.method", "POST"), str("http.route", route), int("http.response.status_code", error ? 500 : 200)],
    status: { code: error ? 2 : 0 },
  }];
  for (let i = 1; i < PER_TRACE; i++) {
    const s = t0 + i * 5_000_000;
    const last = i === PER_TRACE - 1;
    spans.push({
      traceId, spanId: hex(16), parentSpanId: root, name: i % 2 ? "SELECT shifts" : "middleware - auth", kind: i % 2 ? 3 : 1,
      startTimeUnixNano: String(s), endTimeUnixNano: String(s + 4_000_000),
      attributes: [str("db.system", "mssql"), str("db.statement", "SELECT * FROM shifts WHERE employee_id = @p0")],
      status: { code: error && last ? 2 : 0 },
      events: error && last ? [{ name: "exception", timeUnixNano: String(s + 3_000_000), attributes: [
        str("exception.type", "SequelizeDatabaseError"),
        str("exception.message", `Invalid column name 'shift_${route.length}'`),
        str("exception.stacktrace", `SequelizeDatabaseError: Invalid column name\n    at Query.run (/app/node_modules/sequelize/lib/dialects/mssql/query.js:115:25)\n    at async createAttendance (/app/services/attendance.service.js:142:5)\n    at async checkIn (/app/controllers${route}.controller.js:88:20)`),
      ] }] : [],
    });
  }
  return spans;
}

export default function () {
  const nowNs = Date.now() * 1_000_000;
  let spans = [];
  while (spans.length < SPANS) spans = spans.concat(trace(nowNs));
  const body = JSON.stringify({ resourceSpans: [{
    resource: { attributes: [str("service.name", "bench-api"), str("service.version", "1.0.0"), str("deployment.environment.name", "bench")] },
    scopeSpans: [{ scope: { name: "bench" }, spans }],
  }] });
  const res = http.post(URL, body, { headers: { "content-type": "application/json", "x-bugtrail-key": KEY } });
  check(res, { "2xx": (r) => r.status >= 200 && r.status < 300 });
}
