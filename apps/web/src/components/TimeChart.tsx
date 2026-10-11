import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { HealthPoint, HealthThreshold } from "../api";
import { areaPath, breachBands, bucketAt, compact, indicesOf, lastInProgress, linePath, niceTicks, splitLive, windowOf } from "./chart-math";
import { bucketLabel, fmt, fmtLatency, pct1, when, type Range } from "./health-util";

export type TimeWindow = { from: number; to: number };
type Props = {
  s: HealthPoint[]; range: Range; bucketSeconds: number; threshold: HealthThreshold;
  window: TimeWindow | null; onSelect: (w: TimeWindow | null) => void;
  /** Label deret error (default "5xx"); halaman Services memakai "error" (status ERROR atau 5xx). */
  errLabel?: string;
};

// Padding area plot (piksel). Kiri/kanan untuk label sumbu; kedua grafik memakai skala x yang sama.
const PL = 44, PR = 48;
const MAIN = { h: 220, top: 12, bottom: 26 };
const P95 = { h: 90, top: 8, bottom: 6 };
const rate = (p: HealthPoint) => (p.count ? p.c5xx / p.count : 0);

// Grafik deret waktu: requests (area abu, sumbu kiri) + 5xx rate (garis merah, sumbu kanan) + p95 kecil di bawah.
// Hover = crosshair + panel angka; seret = pilih rentang waktu; klik = pilih satu bucket; Esc = batal.
export function TimeChart({ s, range, bucketSeconds, threshold, window: win, onSelect, errLabel = "5xx" }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<{ a: number; b: number } | null>(null);

  // Lebar mengikuti kartu (SVG digambar 1:1 piksel agar teks tidak ikut terskala).
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setWidth(Math.max(240, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const n = s.length;
  const pw = width - PL - PR;
  const bw = n ? pw / n : pw;
  const cx = (i: number) => PL + (i + 0.5) * bw;

  // Bucket terakhir yang masih berjalan berisi data parsial: tidak ikut skala/puncak, digambar putus-putus.
  const live = lastInProgress(s, bucketSeconds, Date.now() / 1000);
  const done = live ? s.slice(0, -1) : s;

  // Skala requests (kiri) dan 5xx rate dalam persen (kanan).
  const maxCount = Math.max(0, ...done.map((p) => p.count));
  const cTicks = niceTicks(maxCount || 1);
  const cTop = cTicks[cTicks.length - 1]!;
  const maxRate = Math.max(0, ...done.map(rate));
  const rTicks = niceTicks(Math.min(100, Math.max(maxRate * 100, threshold.pct * 1.5)) || 1);
  const rTop = rTicks[rTicks.length - 1]!;
  const mh = MAIN.h - MAIN.top - MAIN.bottom;
  // Dijepit ke atas plot: bucket berjalan bisa melebihi skala karena tidak ikut dihitung.
  const yC = (v: number) => MAIN.top + mh - (Math.min(v, cTop) / cTop) * mh;
  const yR = (pctV: number) => MAIN.top + mh - (Math.min(pctV, rTop) / rTop) * mh;

  const reqPts = s.map((p, i) => [cx(i), yC(p.count)] as [number, number]);
  // Bucket tanpa request = gap di garis rate (bukan turun ke 0%).
  const ratePts = s.map((p, i) => (p.count ? [cx(i), yR(rate(p) * 100)] as [number, number] : null));

  // Skala p95 (dibatasi 10001 = ">10s").
  const maxP95 = Math.max(0, ...done.map((p) => Math.min(p.p95 ?? 0, 10001)));
  const lTicks = niceTicks(maxP95 || 1, 2);
  const lTop = lTicks[lTicks.length - 1]!;
  const ph = P95.h - P95.top - P95.bottom;
  const yL = (v: number) => P95.top + ph - (Math.min(v, 10001, lTop) / lTop) * ph;
  const p95Pts = s.map((p, i) => (p.p95 == null ? null : [cx(i), yL(p.p95)] as [number, number]));

  const req = splitLive(reqPts, live), rt = splitLive(ratePts, live), lat = splitLive(p95Pts, live);
  // Segmen bucket berjalan: garis putus-putus (atau titik bila tetangganya kosong).
  const tail = (t: ([number, number] | null)[], cls: string) =>
    t.length > 1 ? <path className={`${cls} tc-live`} d={linePath(t)} /> : t[0] ? <circle className={`${cls} tc-live`} cx={t[0][0]} cy={t[0][1]} r={2} /> : null;

  const bands = breachBands(s, threshold);
  const sel = drag ? { start: Math.min(drag.a, drag.b), end: Math.max(drag.a, drag.b) } : indicesOf(s, win);
  const peakIdx = done.findIndex((p) => p.count === maxCount && maxCount > 0);
  const peakP95 = done.find((p) => p.p95 != null && Math.min(p.p95, 10001) === maxP95);

  const idxAt = (e: PointerEvent<SVGSVGElement>) => bucketAt(e.clientX - e.currentTarget.getBoundingClientRect().left - PL, pw, n);
  const track = (e: PointerEvent<SVGSVGElement>) => {
    const r = wrap.current!.getBoundingClientRect();
    setPos({ x: e.clientX - r.left, y: e.clientY - r.top });
  };
  const handlers = {
    onPointerDown: (e: PointerEvent<SVGSVGElement>) => {
      if (!n || e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      const i = idxAt(e);
      setDrag({ a: i, b: i });
    },
    onPointerMove: (e: PointerEvent<SVGSVGElement>) => {
      if (!n) return;
      const i = idxAt(e);
      setHover(i);
      track(e);
      if (drag && drag.b !== i) setDrag({ ...drag, b: i });
    },
    onPointerUp: () => {
      if (drag) onSelect(windowOf(s, drag.a, drag.b, bucketSeconds));
      setDrag(null);
    },
    onPointerCancel: () => setDrag(null),
    onPointerLeave: () => { if (!drag) { setHover(null); setPos(null); } },
  };

  // Keyboard: panah kiri/kanan menggeser crosshair, Enter memilih bucket, Esc membatalkan pilihan.
  const onKey = (e: KeyboardEvent) => {
    if (!n) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const d = e.key === "ArrowLeft" ? -1 : 1;
      setHover((h) => Math.min(n - 1, Math.max(0, h == null ? (d > 0 ? 0 : n - 1) : h + d)));
      setPos(null);
    } else if (e.key === "Enter" && hover != null) {
      onSelect(windowOf(s, hover, hover, bucketSeconds));
    } else if (e.key === "Escape") {
      // Hanya tulis URL kalau memang ada pilihan.
      if (drag) setDrag(null);
      if (win) onSelect(null);
    }
  };

  const hp = hover != null ? s[hover] : undefined;
  const crossX = hover != null ? cx(hover) : 0;
  // Panel angka: dekat kursor, dibalik ke kiri bila mendekati tepi kanan; mode keyboard -> ikut crosshair di atas.
  const panelW = 200;
  const px = pos?.x ?? crossX;
  const left = px + 14 + panelW > width ? Math.max(0, px - 14 - panelW) : px + 14;
  const top = Math.min(Math.max(0, (pos?.y ?? 40) - 20), MAIN.h + P95.h - 150);

  const selRect = (h: number, t: number, b: number) =>
    sel && <rect className="tc-sel" x={PL + sel.start * bw} y={t} width={(sel.end - sel.start + 1) * bw} height={h - t - b} />;
  const cross = (h: number, t: number, b: number) =>
    hover != null && <line className="tc-cross" x1={crossX} x2={crossX} y1={t} y2={h - b} />;

  return (
    <div className="tc">
      <div className="tc-legend">
        <span><i className="sw req" />Requests</span>
        <span><i className="sw rate" />{errLabel} rate</span>
        <span><i className="sw thr" />alert threshold ({threshold.pct}% with ≥ {fmt(threshold.minRequests)} req)</span>
        <span className="tc-peaks">
          {peakIdx >= 0 && `peak ${fmt(maxCount)} req`}
          {maxRate > 0 && ` · peak ${pct1(maxRate)} ${errLabel}`}
          {peakP95 && ` · peak p95 ${fmtLatency(peakP95.p95)}`}
        </span>
      </div>
      <div ref={wrap} className="tc-wrap" tabIndex={0} onKeyDown={onKey} onBlur={() => { setHover(null); setPos(null); }}
        role="group" aria-label={`Requests, ${errLabel} rate and p95 latency over time. Use left and right arrows to inspect buckets, Enter to filter requests, Escape to clear.`}>
        <svg width={width} height={MAIN.h} {...handlers}>
          {cTicks.map((v) => (
            <g key={`c${v}`}>
              <line className="tc-grid" x1={PL} x2={width - PR} y1={yC(v)} y2={yC(v)} />
              <text className="tc-ax" x={PL - 6} y={yC(v) + 4} textAnchor="end">{compact(v)}</text>
            </g>
          ))}
          {rTicks.map((v) => <text key={`r${v}`} className="tc-ax rate" x={width - PR + 6} y={yR(v) + 4}>{`${+v.toFixed(1)}%`}</text>)}
          {bands.map((b) => <rect key={b.start} className="tc-band" x={PL + b.start * bw} y={MAIN.top} width={(b.end - b.start + 1) * bw} height={mh} />)}
          {selRect(MAIN.h, MAIN.top, MAIN.bottom)}
          <path className="tc-req-area" d={areaPath(req.solid, MAIN.top + mh)} />
          <path className="tc-req-line" d={linePath(req.solid)} />
          {req.tail.length > 1 && <path className="tc-req-area tc-live-area" d={areaPath(req.tail, MAIN.top + mh)} />}
          {tail(req.tail, "tc-req-line")}
          <line className="tc-thr" x1={PL} x2={width - PR} y1={yR(threshold.pct)} y2={yR(threshold.pct)} />
          <text className="tc-thr-label" x={width - PR - 4} y={yR(threshold.pct) - 4} textAnchor="end">alert {threshold.pct}%</text>
          <path className="tc-rate" d={linePath(rt.solid)} />
          {/* Titik tunggal (tetangga kosong) tetap terlihat sebagai bulatan kecil. */}
          {rt.solid.map((p, i) => p && !rt.solid[i - 1] && !rt.solid[i + 1] && <circle key={i} className="tc-rate-dot" cx={p[0]} cy={p[1]} r={2} />)}
          {tail(rt.tail, "tc-rate")}
          {s.map((p, i) => {
            const l = bucketLabel(p.t, range, n, i);
            return l && <text key={p.t} className="tc-ax" x={cx(i)} y={MAIN.h - 8} textAnchor="middle">{l}</text>;
          })}
          {cross(MAIN.h, MAIN.top, MAIN.bottom)}
          {hp && hp.count > 0 && <circle className="tc-rate-dot hl" cx={crossX} cy={yR(rate(hp) * 100)} r={3.5} />}
        </svg>
        <div className="tc-sub">p95 latency <span>(approximate)</span></div>
        <svg width={width} height={P95.h} {...handlers}>
          {lTicks.map((v) => (
            <g key={`l${v}`}>
              <line className="tc-grid" x1={PL} x2={width - PR} y1={yL(v)} y2={yL(v)} />
              {v > 0 && <text className="tc-ax" x={PL - 6} y={yL(v) + 4} textAnchor="end">{fmtLatency(v).replace("≤", "")}</text>}
            </g>
          ))}
          {selRect(P95.h, P95.top, P95.bottom)}
          <path className="tc-p95-area" d={areaPath(lat.solid, P95.top + ph)} />
          <path className="tc-p95" d={linePath(lat.solid)} />
          {tail(lat.tail, "tc-p95")}
          {cross(P95.h, P95.top, P95.bottom)}
        </svg>
        <div aria-live="polite" aria-atomic="true">
        {hp && (
          <div className="tc-readout" style={{ left, top, width: panelW }}>
            <b>{when(hp.t)}{live && hover === n - 1 && <span className="tc-live-tag"> (in progress)</span>}</b>
            <div><span>Requests</span><span>{fmt(hp.count)}</span></div>
            <div className="bad"><span>{errLabel}</span><span>{fmt(hp.c5xx)} ({pct1(rate(hp))})</span></div>
            <div><span>4xx</span><span>{fmt(hp.c4xx)}</span></div>
            <div><span>p50 / p95</span><span>{fmtLatency(hp.p50)} / {fmtLatency(hp.p95)}</span></div>
            <div><span>p99</span><span>{fmtLatency(hp.p99)}</span></div>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}
