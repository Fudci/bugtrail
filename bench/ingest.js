// k6: kirim envelope Sentry dengan laju tetap (RATE req/detik) selama DURATION.
// Dipakai sama persis untuk Bugsink dan bugtool supaya perbandingannya adil.
import http from "k6/http";
import { check } from "k6";

const RATE = Number(__ENV.RATE);
const DURATION = __ENV.DURATION || "60s";
const URL = __ENV.URL;           // .../api/<project>/envelope/
const KEY = __ENV.KEY;           // public key dari DSN

export const options = {
  discardResponseBodies: true,
  scenarios: {
    ingest: {
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

// 20 jenis error berbeda (fungsi/file beda → issue beda), payload ~4 KB mirip event React Native.
const VARIANTS = Array.from({ length: 20 }, (_, i) => ({
  type: ["TypeError", "ReferenceError", "Error", "RangeError"][i % 4],
  value: `bench failure ${i}: undefined is not an object (evaluating 'user.profile.id')`,
  file: `src/Screens/Screen${i}.tsx`,
  fn: `handleSubmit${i}`,
}));

function event(v) {
  const now = Date.now() / 1000;
  return {
    event_id: hex(32),
    timestamp: now,
    platform: "javascript",
    level: "error",
    release: "example-app@2.4.1+412",
    environment: "production",
    user: { id: String(10000 + ((Math.random() * 500) | 0)), username: "bench user" },
    contexts: {
      os: { name: "Android", version: "14" },
      device: { manufacturer: "Samsung", model: "SM-A546E", family: "Android", memory_size: 7812345856 },
      app: { app_identifier: "com.example.app", app_version: "2.4.1", app_build: "412" },
    },
    tags: { screen: v.file, network: "wifi" },
    sdk: { name: "sentry.javascript.react-native", version: "8.23.0" },
    breadcrumbs: {
      values: Array.from({ length: 12 }, (_, j) => ({
        timestamp: now - 30 + j,
        category: j % 3 === 0 ? "navigation" : j % 3 === 1 ? "http" : "ui.tap",
        message: j % 3 === 1 ? `GET https://api.example.com/v1/resource/${j} [200]` : `step ${j} on ${v.file}`,
        level: "info",
      })),
    },
    exception: {
      values: [{
        type: v.type,
        value: v.value,
        mechanism: { type: "onerror", handled: false },
        stacktrace: {
          frames: [
            ...Array.from({ length: 10 }, (_, j) => ({
              filename: `node_modules/react-native/Libraries/Renderer/implementations/ReactFabric-dev.js`,
              function: `commitHookEffectListMount${j}`,
              lineno: 1000 + j * 37,
              colno: 12,
              in_app: false,
            })),
            { filename: "src/Hooks/useAttendance.ts", function: "submitAttendance", lineno: 42, colno: 18, in_app: true,
              pre_context: ["  const payload = {", "    location,"], context_line: "    userId: user.profile.id,", post_context: ["  };"] },
            { filename: v.file, function: v.fn, lineno: 88, colno: 5, in_app: true },
          ],
        },
      }],
    },
  };
}

export default function () {
  const v = VARIANTS[(Math.random() * VARIANTS.length) | 0];
  const ev = event(v);
  const item = JSON.stringify(ev);
  const body = `${JSON.stringify({ event_id: ev.event_id, sent_at: new Date().toISOString() })}\n${JSON.stringify({ type: "event", length: item.length })}\n${item}\n`;
  const res = http.post(URL, body, {
    headers: {
      "content-type": "application/x-sentry-envelope",
      "x-sentry-auth": `Sentry sentry_version=7, sentry_client=bench/1.0, sentry_key=${KEY}`,
    },
    timeout: "10s",
  });
  check(res, { "2xx": (r) => r.status >= 200 && r.status < 300 });
}
