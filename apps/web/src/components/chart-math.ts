import type { HealthPoint, HealthThreshold } from "../api";
import { breaches } from "./health-util";

// Langkah "rapi" (1, 2, 2.5, 5 x 10^k) yang >= raw.
function niceStep(raw: number) {
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

// Tick sumbu dari 0 sampai kelipatan rapi >= max, kira-kira `count` interval (3–4 label).
export function niceTicks(max: number, count = 3): number[] {
  if (!(max > 0)) return [0, 1];
  const step = niceStep(max / count);
  const n = Math.ceil(max / step - 1e-9);
  return Array.from({ length: n + 1 }, (_, i) => +(i * step).toPrecision(12));
}

// Angka ringkas untuk sumbu, mis. 2000 -> "2k", 1500000 -> "1.5M".
export function compact(n: number) {
  const a = Math.abs(n);
  if (a >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${+(n / 1e3).toFixed(1)}k`;
  return `${+n.toFixed(2)}`;
}

// Indeks bucket di posisi x (piksel relatif area plot), dijepit ke [0, n-1].
export function bucketAt(x: number, plotWidth: number, n: number) {
  if (n <= 0 || plotWidth <= 0) return 0;
  return Math.min(n - 1, Math.max(0, Math.floor((x / plotWidth) * n)));
}

// Rentang indeks (inklusif) bucket berurutan yang melewati ambang; bucket bersebelahan digabung jadi satu pita.
export function breachBands(s: HealthPoint[], t: HealthThreshold): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  s.forEach((p, i) => {
    if (!breaches(p.count, p.c5xx, t)) return;
    const last = out[out.length - 1];
    if (last && last.end === i - 1) last.end = i;
    else out.push({ start: i, end: i });
  });
  return out;
}

// Path SVG garis; titik null memutus garis (gap), segmen satu titik digambar sebagai titik kecil lewat "h0".
export function linePath(pts: ([number, number] | null)[]) {
  let d = "";
  let open = false;
  for (const p of pts) {
    if (!p) { open = false; continue; }
    d += `${open ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`;
    open = true;
  }
  return d;
}

// Path area (tertutup ke baseline) per segmen kontinu.
export function areaPath(pts: ([number, number] | null)[], base: number) {
  let d = "";
  let seg: [number, number][] = [];
  const flush = () => {
    if (seg.length) {
      d += `M${seg[0]![0].toFixed(1)},${base}` + seg.map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`).join("") + `L${seg[seg.length - 1]![0].toFixed(1)},${base}Z`;
    }
    seg = [];
  };
  for (const p of pts) p ? seg.push(p) : flush();
  flush();
  return d;
}

// Jendela waktu (detik epoch) dari rentang indeks bucket: from = awal bucket pertama, to = akhir bucket terakhir.
export function windowOf(s: HealthPoint[], a: number, b: number, bucketSeconds: number) {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  return { from: s[lo]!.t, to: s[hi]!.t + bucketSeconds };
}

// Kebalikan windowOf: indeks bucket yang tercakup jendela, atau null bila tidak ada.
export function indicesOf(s: HealthPoint[], w: { from: number; to: number } | null) {
  if (!w) return null;
  const idx = s.flatMap((p, i) => (p.t >= w.from && p.t < w.to ? [i] : []));
  return idx.length ? { start: idx[0]!, end: idx[idx.length - 1]! } : null;
}

// Bucket terakhir masih berjalan (belum selesai) bila akhirnya melewati `nowSec`; datanya parsial sehingga digambar
// putus-putus dan tidak ikut skala sumbu y maupun label puncak.
export function lastInProgress(s: HealthPoint[], bucketSeconds: number, nowSec: number) {
  const last = s[s.length - 1];
  return !!last && last.t + bucketSeconds > nowSec;
}

// Pisahkan titik garis: `solid` = semua kecuali bucket berjalan; `tail` = segmen dari titik sebelumnya ke bucket berjalan
// (hanya titik terakhir bila titik sebelumnya kosong).
export function splitLive(pts: ([number, number] | null)[], live: boolean) {
  if (!live || !pts.length) return { solid: pts, tail: [] as ([number, number] | null)[] };
  const last = pts[pts.length - 1] ?? null;
  const prev = pts.length > 1 ? pts[pts.length - 2] ?? null : null;
  return { solid: [...pts.slice(0, -1), null], tail: last ? (prev ? [prev, last] : [last]) : [] };
}
