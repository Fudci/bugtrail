import { Server } from "lucide-react";
import { useEffect, useRef, useState } from "react";

// Hiasan: kumbang merayap acak (di seluruh layar, atau dibatasi di satu area "lane"). Kursor di atas
// kumbang berubah jadi jaring; klik = tertangkap -> mati -> terbang ke ikon server yang menghitung tangkapan.
// Overlay tidak menangkap klik (pointer-events: none) kecuali badan kumbang.
type Pt = { x: number; y: number };
type Phase = "crawl" | "dying" | "fly";
interface Bug {
  id: number; path: Pt[]; duration: number; size: number; wobble: number;
  phase: Phase; phaseAt: number; pos: Pt; angle: number; from?: Pt;
  t: number; hover: boolean; // progres di jalur (0..1); melambat saat kursor di atasnya
}

const DIE_MS = 650, FLY_MS = 800;
export const CAUGHT_EVENT = "bt-bug-caught";

const rand = (a: number, b: number) => a + Math.random() * (b - a);
function bez([a, b, c, d]: Pt[], t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * u * a!.x + 3 * u * u * t * b!.x + 3 * u * t * t * c!.x + t * t * t * d!.x,
    y: u * u * u * a!.y + 3 * u * u * t * b!.y + 3 * u * t * t * c!.y + t * t * t * d!.y,
  };
}
type Box = { x: number; y: number; w: number; h: number };
let nextId = 1;

// Jalur acak lewat kotak, masuk/keluar dari sisi acak (atas, bawah, kiri, kanan).
// Lane: titik tengah jalur tetap di dalam kotak; overlay dipotong setinggi header (lihat .bc.lane).
function spawn(now: number, box: Box, lane: boolean, size: [number, number], duration: [number, number]): Bug {
  const s = rand(size[0], size[1]);
  const m = lane ? s : 50;
  const y = () => box.y + (lane ? rand(s / 2, box.h - s / 2) : rand(0.08, 0.92) * box.h);
  const x = () => box.x + rand(0.08, 0.92) * box.w;
  const edge = (side: number): Pt => [{ x: box.x - m, y: y() }, { x: box.x + box.w + m, y: y() }, { x: x(), y: box.y - m }, { x: x(), y: box.y + box.h + m }][side]!;
  // Di lane (header lebar & pendek) kebanyakan masuk dari kiri/kanan supaya melintas dari ujung ke ujung.
  const side = lane && rand(0, 1) < 0.75 ? Math.floor(rand(0, 2)) : Math.floor(rand(0, 4));
  const exit = side < 2 && lane ? side ^ 1 : rand(0, 1) < 0.6 ? side ^ 1 : (side + 2) % 4;
  const mid = () => ({ x: box.x + rand(0.1, 0.9) * box.w, y: lane ? y() : box.y + rand(0.1, 0.9) * box.h });
  const path = [edge(side), mid(), mid(), edge(exit)];
  return { id: nextId++, path, duration: rand(duration[0], duration[1]), size: s, wobble: rand(0, 6), phase: "crawl", phaseAt: now, pos: path[0]!, angle: 0, t: 0, hover: false };
}

interface Props {
  serverId: string;          // elemen tujuan terbang (ikon server)
  laneId?: string;           // batasi kumbang di area elemen ini; kosong = seluruh layar
  count?: [number, number];  // jumlah kumbang di layar (min, max)
  size?: [number, number];
  duration?: [number, number];
}

export function BugCatcher({ serverId, laneId, count = [3, 5], size = [42, 58], duration = [9000, 16_000] }: Props) {
  const serverPoint = (): Pt => {
    const r = document.getElementById(serverId)?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: window.innerWidth - 60, y: 60 };
  };
  const box = (): Box | null => {
    if (!laneId) return { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
    const r = document.getElementById(laneId)?.getBoundingClientRect();
    return r && r.width > 40 ? { x: r.left, y: r.top, w: r.width, h: r.height } : null;
  };
  const bugs = useRef<Bug[]>([]);
  const nodes = useRef(new Map<number, HTMLDivElement>());
  const [ids, setIds] = useState<{ id: number; size: number }[]>([]);
  const [swooshes, setSwooshes] = useState<{ id: number; x: number; y: number }[]>([]);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    let target = Math.round(rand(count[0], count[1]));
    let nextSpawn = performance.now() + (laneId ? 300 : 1200);
    let last = performance.now();
    const sync = () => setIds(bugs.current.map((b) => ({ id: b.id, size: b.size })));

    const frame = (now: number) => {
      const dt = Math.min(100, now - last); // dibatasi supaya tidak melompat setelah tab aktif lagi
      last = now;
      // Isi ulang bertahap sampai jumlah target, dengan jeda acak antar kumbang.
      const area = bugs.current.length < target && now >= nextSpawn ? box() : null;
      if (area) {
        bugs.current.push(spawn(now, area, !!laneId, size, duration));
        nextSpawn = now + (laneId ? rand(300, 1200) : rand(1000, 4000));
        sync();
      }
      let removed = false;
      for (const b of bugs.current) {
        const el = nodes.current.get(b.id);
        if (b.phase === "crawl") {
          b.t = Math.min(1, b.t + (dt / b.duration) * (1 + 0.3 * Math.sin(now / 380 + b.wobble)) * (b.hover ? 0.12 : 1));
          const t = b.t;
          const p = bez(b.path, t), q = bez(b.path, Math.min(1, t + 0.01));
          b.pos = p;
          if (q.x !== p.x || q.y !== p.y) b.angle = (Math.atan2(q.y - p.y, q.x - p.x) * 180) / Math.PI + 90;
          if (t >= 1) { b.phase = "fly"; b.phaseAt = -1; removed = true; } // keluar layar tanpa tertangkap
        } else if (b.phase === "dying" && now - b.phaseAt >= DIE_MS) {
          b.phase = "fly"; b.phaseAt = now; b.from = { ...b.pos };
          el?.classList.add("flying");
        } else if (b.phase === "fly" && b.phaseAt > 0) {
          // Lintasan melengkung ke server, makin cepat di akhir.
          const t = Math.min(1, (now - b.phaseAt) / FLY_MS), e = t * t;
          const to = serverPoint(), from = b.from!;
          const mid = { x: (from.x + to.x) / 2, y: Math.max(30, Math.min(from.y, to.y) - 90) };
          b.pos = { x: (1 - e) * (1 - e) * from.x + 2 * (1 - e) * e * mid.x + e * e * to.x, y: (1 - e) * (1 - e) * from.y + 2 * (1 - e) * e * mid.y + e * e * to.y };
          if (t >= 1) {
            b.phaseAt = -1; removed = true;
            window.dispatchEvent(new CustomEvent(CAUGHT_EVENT, { detail: serverId }));
          }
        }
        if (el) el.style.transform = `translate(${b.pos.x - b.size / 2}px, ${b.pos.y - b.size / 2}px) rotate(${b.angle}deg)`;
      }
      if (removed) {
        bugs.current = bugs.current.filter((b) => !(b.phase === "fly" && b.phaseAt === -1));
        target = Math.round(rand(count[0], count[1]));
        nextSpawn = Math.max(nextSpawn, now + (laneId ? rand(300, 1200) : rand(1000, 4000)));
        sync();
      }
      raf = requestAnimationFrame(frame);
    };
    const start = () => { cancelAnimationFrame(raf); last = performance.now(); raf = requestAnimationFrame(frame); };
    const onVis = () => (document.hidden ? cancelAnimationFrame(raf) : start());
    start();
    document.addEventListener("visibilitychange", onVis);
    return () => { cancelAnimationFrame(raf); document.removeEventListener("visibilitychange", onVis); };
  }, []);

  const setHover = (id: number, on: boolean) => {
    const b = bugs.current.find((b) => b.id === id);
    if (b) b.hover = on;
  };

  const catchBug = (id: number, x: number, y: number) => {
    const b = bugs.current.find((b) => b.id === id);
    if (!b || b.phase !== "crawl") return;
    b.phase = "dying";
    b.phaseAt = performance.now();
    nodes.current.get(id)?.classList.add("dying");
    const s = { id: b.id, x, y };
    setSwooshes((list) => [...list, s]);
    setTimeout(() => setSwooshes((list) => list.filter((w) => w !== s)), 900);
  };

  return (
    <div className={`bc ${laneId ? "lane" : ""}`} aria-hidden>
      {ids.map(({ id, size }) => (
        <div key={id} className="bc-bug" style={{ width: size, height: size, transform: "translate(-100px, -100px)" }}
          ref={(el) => { if (el) nodes.current.set(id, el); else nodes.current.delete(id); }}
          onPointerEnter={() => setHover(id, true)} onPointerLeave={() => setHover(id, false)}
          onPointerDown={(e) => { e.preventDefault(); catchBug(id, e.clientX, e.clientY); }}>
          <svg viewBox="0 0 32 32" width="100%" height="100%">
            <g className="legs" stroke="#1d1d1b" strokeWidth="1.6" strokeLinecap="round" fill="none">
              <path d="M10 12 4 9M10 16H3M10 20l-6 4" /><path d="M22 12l6-3M22 16h7M22 20l6 4" />
            </g>
            <path className="ant" d="M13 6.5l-2-3M19 6.5l2-3" stroke="#1d1d1b" strokeWidth="1.4" strokeLinecap="round" />
            <circle className="head" cx="16" cy="8.5" r="3.6" fill="#1d1d1b" />
            <ellipse className="shell" cx="16" cy="18" rx="7" ry="9" fill="#e5484d" stroke="#1d1d1b" strokeWidth="1.4" />
            <path d="M16 9.5v17" stroke="#1d1d1b" strokeWidth="1.2" />
            <circle cx="12.6" cy="15.5" r="1.6" fill="#1d1d1b" /><circle cx="19.4" cy="15.5" r="1.6" fill="#1d1d1b" />
            <circle cx="13.4" cy="21.5" r="1.3" fill="#1d1d1b" /><circle cx="18.6" cy="21.5" r="1.3" fill="#1d1d1b" />
            <path className="x" d="M11 13l10 10M21 13 11 23" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
          </svg>
        </div>
      ))}
      {swooshes.map((s) => (
        <div key={s.id} className="bc-hit" style={{ left: s.x, top: s.y }}>
          <div className="bc-swoosh" />
          <div className="bc-ring" />
          {Array.from({ length: 10 }, (_, i) => <i key={i} style={{ transform: `rotate(${i * 36}deg)` }} />)}
          <b>Gotcha!</b>
        </div>
      ))}
    </div>
  );
}

// Ikon server di panel login: berkedip dan menambah hitungan setiap kumbang tertangkap.
export function BugServer({ id = "bt-server", compact = false }: { id?: string; compact?: boolean }) {
  const [n, setN] = useState(0);
  const [pulse, setPulse] = useState(0);
  useEffect(() => {
    const on = (e: Event) => { if ((e as CustomEvent).detail === id) { setN((v) => v + 1); setPulse((p) => p + 1); } };
    window.addEventListener(CAUGHT_EVENT, on);
    return () => window.removeEventListener(CAUGHT_EVENT, on);
  }, [id]);
  return (
    <span className={`bc-server ${compact ? "compact" : ""} ${pulse ? "hit" : ""}`} key={pulse} title="Bugs caught">
      <span id={id} className="bc-srv"><Server /></span>
      {!compact && <span className="bc-label">Bugs caught</span>}
      <b className="num bc-n">{n}</b>
      {pulse > 0 && <span className="bc-plus">+1</span>}
    </span>
  );
}
