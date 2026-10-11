import type { HealthEndpoint, HealthList, HealthThreshold } from "../api";

export type Range = HealthList["range"];
export type Sort = "problems" | "requests" | "p95";

export const fmt = (n: number) => n.toLocaleString("en-US");
export const pct = (r: number) => `${(r * 100).toFixed(r * 100 >= 10 || r === 0 ? 0 : 1)}%`;
// Persen satu desimal untuk tooltip/label grafik, mis. "12.5%".
export const pct1 = (r: number) => `${(r * 100).toFixed(1)}%`;

// Persentil berasal dari batas atas bucket histogram; 10001 berarti melewati bucket terakhir (>10s).
export function fmtLatency(ms: number | null) {
  if (ms == null) return "—";
  if (ms === 10001) return ">10s";
  if (ms < 1000) return `≤${ms} ms`;
  return `≤${+(ms / 1000).toFixed(1)} s`;
}

// Label sumbu waktu: jam lokal untuk range pendek, tanggal untuk 7 hari; hanya tiap ~8 bar agar tidak padat.
export function bucketLabel(t: number, range: Range, total: number, i: number) {
  const every = Math.max(1, Math.ceil(total / 8));
  if (i % every !== 0) return "";
  const d = new Date(t * 1000);
  if (range === "7d") return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
}

// Waktu bucket untuk tooltip, mis. "Oct 10 09:36".
export const when = (t: number) =>
  new Date(t * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).replace(",", "");

// Melewati ambang: cukup request (>= minRequests) DAN rasio 5xx >= pct (aturan sama dengan alert).
export const breaches = (count: number, c5xx: number, t: HealthThreshold) =>
  count > 0 && count >= t.minRequests && (c5xx / count) * 100 >= t.pct;

// Label durasi pelanggaran per ukuran bucket, mis. "6 min" / "3 h".
export const breachLabel = (n: number, bucketSeconds: number) => `${n} ${bucketSeconds >= 3600 ? "h" : "min"}`;
export const breachTitle = (n: number, bucketSeconds: number, t: HealthThreshold) =>
  `${n} ${bucketSeconds >= 3600 ? (n === 1 ? "hour" : "hours") : n === 1 ? "minute" : "minutes"} above ${t.pct}% 5xx`;

// "problems": jumlah bucket melewati ambang (turun), lalu rasio 5xx keseluruhan (hanya yang request-nya cukup),
// lalu jumlah request.
export function sortEndpoints(list: HealthEndpoint[], sort: Sort, t: HealthThreshold) {
  const byCount = (a: HealthEndpoint, b: HealthEndpoint) => b.count - a.count;
  if (sort === "requests") return [...list].sort(byCount);
  if (sort === "p95") return [...list].sort((a, b) => (b.p95 ?? -1) - (a.p95 ?? -1) || byCount(a, b));
  const rate = (e: HealthEndpoint) => (e.count >= t.minRequests ? e.errorRate : -1);
  return [...list].sort((a, b) => b.breaches - a.breaches || rate(b) - rate(a) || byCount(a, b));
}

// Waktu lokal dengan milidetik, mis. "10 Oct 08:42:17.384".
export function fmtTime(us: number) {
  const d = new Date(Math.floor(us / 1000));
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const mon = d.toLocaleString("en-US", { month: "short" });
  return `${d.getDate()} ${mon} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
// Durasi tepat (bukan batas bucket seperti persentil).
export function fmtDuration(us: number) {
  if (us < 1000) return `${us} µs`;
  if (us < 1_000_000) return `${+(us / 1000).toFixed(1)} ms`;
  return `${+(us / 1_000_000).toFixed(2)} s`;
}

// "Type: message"; salah satu boleh kosong.
export const errText = (e: { type?: string; message?: string }) => [e.type, e.message].filter(Boolean).join(": ") || "Unknown error";
