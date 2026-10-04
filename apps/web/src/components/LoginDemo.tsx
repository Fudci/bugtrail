import { Bell, FileCode2, Layers, MousePointerClick, Route, Zap } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

// Demo panel login dengan data CONTOH: error masuk -> digabung -> kursor klik issue -> scroll -> zoom ke breadcrumbs -> alert.
// Timeline berupa daftar waktu (ms); React hanya render ulang di tiap titik, gerakan dikerjakan CSS transition.
const T = {
  a: 0, b: 900, x2: 1900, x3: 2600, cursorIn: 3500, hover: 4700, click: 5100, detail: 5500,
  cursorMid: 6700, scroll: 7400, zoom: 9400, bc0: 10000, bc1: 10600, bc2: 11200, bc3: 11800,
  zoomOut: 13600, back: 14600, toast: 15000, end: 18000,
};
const MARKS = Object.values(T).sort((x, y) => x - y);
const ZOOM = 1.35;

const CAPTIONS: [number, ReactNode, string][] = [
  [T.a, <Zap />, "Errors captured from the SDK, live"],
  [T.x2, <Layers />, "Same error, grouped into one issue"],
  [T.cursorIn, <MousePointerClick />, "Open an issue to see the full story"],
  [T.cursorMid, <FileCode2 />, "Source-mapped stacktrace, down to the line"],
  [T.zoom, <Route />, "Breadcrumbs: exactly what the user did before the crash"],
  [T.back, <Bell />, "Your team gets alerted on Discord"],
];

const BREADCRUMBS = [
  { time: "09:41:02", cat: "navigation", msg: "Home → Attendance" },
  { time: "09:41:05", cat: "ui.tap", msg: "Check in button" },
  { time: "09:41:05", cat: "http", msg: "POST /attendance → 500", bad: true },
  { time: "09:41:06", cat: "error", msg: "TypeError: reading 'id'", bad: true },
];

function useTimeline() {
  const [t, setT] = useState(0);
  const [loop, setLoop] = useState(0);
  const [still] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    if (still) {
      setT(T.bc3); // tampilan statis: detail di-scroll ke breadcrumbs, tanpa kursor dan zoom
      return;
    }
    let timers: number[] = [];
    const run = () => {
      timers.forEach(clearTimeout);
      setT(0);
      timers = MARKS.map((m) => window.setTimeout(() => (m === T.end ? (setLoop((l) => l + 1), run()) : setT(m)), m));
    };
    // Berhenti saat tab tidak terlihat; mulai dari awal saat kembali.
    const onVis = () => (document.hidden ? timers.forEach(clearTimeout) : run());
    run();
    document.addEventListener("visibilitychange", onVis);
    return () => { timers.forEach(clearTimeout); document.removeEventListener("visibilitychange", onVis); };
  }, [still]);
  return { t, loop, still, at: (m: number) => t >= m };
}

export function LoginDemo() {
  const { t, loop, still, at } = useTimeline();
  const stage = useRef<HTMLDivElement>(null);
  const cardA = useRef<HTMLDivElement>(null);
  const bc = useRef<HTMLDivElement>(null);
  const [geo, setGeo] = useState({ w: 520, h: 420, card: { x: 300, y: 200 }, bcTop: 300, bcH: 160 });

  // Ukur posisi target (kartu, breadcrumbs) relatif ke stage, untuk kursor, scroll dan zoom.
  useLayoutEffect(() => {
    const s = stage.current?.getBoundingClientRect();
    if (!s) return;
    const c = cardA.current?.getBoundingClientRect();
    setGeo((g) => ({
      w: s.width, h: s.height,
      card: c ? { x: c.left - s.left + c.width * 0.62, y: c.top - s.top + c.height * 0.55 } : g.card,
      bcTop: bc.current?.offsetTop ?? g.bcTop,
      bcH: bc.current?.offsetHeight ?? g.bcH,
    }));
  }, [t >= T.b, t >= T.detail]);

  const inDetail = at(T.detail) && !at(T.back);
  const scrolled = at(T.scroll) && !at(T.back);
  const zoomed = !still && at(T.zoom) && !at(T.zoomOut);
  // Scroll sampai breadcrumbs berada di bawah layar mini, tanpa sisa ruang kosong.
  const scrollY = scrolled ? Math.max(0, geo.bcTop + geo.bcH + 18 - geo.h * 0.92) : 0;

  const cursor = still || !at(T.cursorIn) || at(T.zoom)
    ? { x: geo.w + 30, y: geo.h + 30, show: false }
    : at(T.cursorMid) ? { x: geo.w * 0.55, y: geo.h * 0.6, show: true } : { ...geo.card, show: true };

  const count = at(T.x3) ? 3 : at(T.x2) ? 2 : 1;
  const caption = [...CAPTIONS].reverse().find(([m]) => t >= m)!;
  const lit = [T.bc0, T.bc1, T.bc2, T.bc3].filter((m) => t >= m).length;

  return (
    <div className="ld" key={loop}>
      <div className="ld-cap" key={String(caption[2])}>{caption[1]}{caption[2]}</div>
      <div className="ld-stage" ref={stage}>
        <div className="ld-zoom" style={{
          transform: zoomed ? `scale(${ZOOM})` : "none",
          // Titik zoom di tepi kiri breadcrumbs: teks tetap terbaca, yang terpotong hanya ruang kosong di kanan.
          transformOrigin: `24px ${geo.bcTop - scrollY + geo.bcH / 2}px`,
        }}>
          {/* Layar 1: feed */}
          <div className={`ld-view ${inDetail ? "out" : ""}`}>
            {at(T.b) && <MiniCard level="error" title="NetworkError: Request failed with status 502" where="api/client.ts:88" meta="iOS 18" />}
            <MiniCard ref={cardA} level="error" title="TypeError: Cannot read properties of undefined (reading 'id')"
              where="hooks/useAttendance.ts:42" meta="Android 14" count={count}
              state={at(T.click) && !at(T.detail) ? "press" : at(T.hover) && !at(T.detail) ? "hover" : ""} />
            {!at(T.b) && <div className="ld-ghost" />}
          </div>

          {/* Layar 2: detail issue */}
          <div className={`ld-view detail ${inDetail ? "in" : ""}`}>
            <div className="ld-scroll" style={{ transform: `translateY(${-scrollY}px)` }}>
              <span className="tag err">● error</span>
              <div className="ld-title">TypeError: Cannot read properties of undefined (reading 'id')</div>
              <div className="ld-stats"><span><b>3</b>events</span><span><b>2</b>users</span><span><b>1.4.2</b>release</span></div>
              <div className="ld-box">
                <div className="ld-h">Stacktrace</div>
                <div className="ld-frame mono">hooks/useAttendance.ts <span>in checkIn</span> :42</div>
                <pre className="ld-code mono">
                  <span>41  const res = await api.post(url)</span>
                  <span className="hl">42  setUser(res.data.user.id)</span>
                  <span>43  setStatus("checked-in")</span>
                </pre>
                <div className="ld-frame mono dim">screens/Attendance.tsx <span>in onPress</span> :88</div>
              </div>
              <div className="ld-box">
                <div className="ld-h">Context</div>
                <div className="ld-kv"><span>Device</span><b>Pixel 7 · Android 14</b><span>Network</span><b>4G · online</b><span>Battery</span><b>23%</b></div>
              </div>
              <div className="ld-box" ref={bc}>
                <div className="ld-h">Breadcrumbs</div>
                {BREADCRUMBS.map((b, i) => (
                  <div key={i} className={`ld-bc ${i < lit ? "on" : ""} ${b.bad ? "bad" : ""}`}>
                    <span className="mono">{b.time}</span><span className="cat">{b.cat}</span><span>{b.msg}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className={`ld-cursor ${cursor.show ? "" : "hide"} ${at(T.scroll) && !at(T.zoom) ? "wheel" : ""}`}
          style={{ transform: `translate(${cursor.x}px, ${cursor.y}px)` }}>
          <svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 2l16 9.5-7 1.6-3.6 6.9z" fill="#fff" stroke="#1d1d1b" strokeWidth="1.5" strokeLinejoin="round" /></svg>
          {at(T.click) && !at(T.detail) && <i className="ld-ripple" />}
        </div>
        {at(T.toast) && <div className="lf-toast" style={{ top: 12, right: 12 }}><Bell />New issue · TypeError in useAttendance.ts</div>}
      </div>
    </div>
  );
}

interface CardProps { level: "error" | "warning"; title: string; where: string; meta: string; count?: number; state?: string; ref?: React.Ref<HTMLDivElement> }
function MiniCard({ level, title, where, meta, count = 1, state = "", ref }: CardProps) {
  return (
    <div ref={ref} className={`lf-card ${level} ${state}`}>
      <div className="row between" style={{ gap: 8 }}>
        <span className={`tag ${level === "warning" ? "" : "err"}`}>● {level}</span>
        <span className="lf-meta">{meta} · just now</span>
      </div>
      <div className="lf-title">{title}</div>
      <div className="row between">
        <span className="mono lf-where">{where}</span>
        {count > 1 && <span key={count} className="lf-count">×{count}</span>}
      </div>
    </div>
  );
}
