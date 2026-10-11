// Filter status HTTP di URL / API: token dipisah koma (aturan sama dengan apps/api/src/otlp/status-filter.ts).
// Token: kelas "5xx", kode "500", rentang "520-529", atau "error" (Traces). [] = semua (tanpa filter).

export interface StatusCount { code: number; count: number }

export const CLASSES = ["2xx", "3xx", "4xx", "5xx"] as const;
const MAX_TOKENS = 20;

const inCodes = (n: number) => n >= 100 && n <= 599;

/** Kode persis atau rentang dari input "+" (mis. 499, 520-529); hasil dinormalkan, null kalau tidak sah. */
export function customToken(raw: string): string | null {
  const s = raw.trim();
  let m: RegExpExecArray | null;
  if (/^\d{3}$/.test(s)) return inCodes(Number(s)) ? s : null;
  if ((m = /^(\d{3})\s*-\s*(\d{3})$/.exec(s))) {
    const lo = Number(m[1]), hi = Number(m[2]);
    if (!inCodes(lo) || !inCodes(hi) || lo > hi) return null;
    return lo === hi ? String(lo) : `${lo}-${hi}`;
  }
  return null;
}

/** Baca nilai URL; null kalau tidak sah (pemanggil memakai default). Token ganda dibuang. */
export function parseStatus(raw: string | null, opts: { allowError?: boolean } = {}): string[] | null {
  const s = (raw ?? "").trim().toLowerCase();
  if (s === "" || s === "all") return [];
  const out: string[] = [];
  const tokens = s.split(",").map((t) => t.trim());
  if (tokens.length > MAX_TOKENS) return null;
  for (const t of tokens) {
    let tok: string | null;
    if (t === "all") return [];
    if (t === "error") tok = opts.allowError ? t : null;
    else if (/^[1-5]xx$/.test(t)) tok = t;
    else tok = customToken(t);
    if (!tok) return null;
    if (!out.includes(tok)) out.push(tok);
  }
  return out;
}

/** Rentang inklusif satu token (bukan "error"). */
export function tokenRange(t: string): [number, number] | null {
  if (/^[1-5]xx$/.test(t)) { const c = Number(t[0]) * 100; return [c, c + 99]; }
  const m = /^(\d{3})(?:-(\d{3}))?$/.exec(t);
  return m ? [Number(m[1]), Number(m[2] ?? m[1])] : null;
}

export const classOf = (code: number) => `${Math.floor(code / 100)}xx`;

/**
 * Pilih/lepas satu token. Memilih kelas menghapus kode/rentang di dalam kelas itu;
 * memilih kode saat kelasnya terpilih mengganti kelas dengan kode itu (mempersempit).
 */
export function toggleToken(tokens: string[], t: string): string[] {
  if (tokens.includes(t)) return tokens.filter((x) => x !== t);
  if (/^[1-5]xx$/.test(t)) {
    const [lo, hi] = tokenRange(t)!;
    const rest = tokens.filter((x) => {
      const r = tokenRange(x);
      return !r || /^[1-5]xx$/.test(x) || r[0] < lo || r[1] > hi;
    });
    return [...rest, t].slice(-MAX_TOKENS);
  }
  const r = tokenRange(t);
  const cls = r && classOf(r[0]) === classOf(r[1]) ? classOf(r[0]) : null;
  return [...tokens.filter((x) => x !== cls), t].slice(-MAX_TOKENS);
}

/** Jumlah per kelas (2xx..5xx) dari daftar per kode. */
export function classCounts(counts: StatusCount[]) {
  const m = new Map<string, number>();
  for (const c of counts) m.set(classOf(c.code), (m.get(classOf(c.code)) ?? 0) + c.count);
  return m;
}

/** Kode per baris kedua: 5xx dulu, lalu 4xx, lalu lainnya; masing-masing urut jumlah terbanyak. */
export function groupCodes(counts: StatusCount[]) {
  const by = (lo: number, hi: number) => counts.filter((c) => c.code >= lo && c.code <= hi).sort((a, b) => b.count - a.count || a.code - b.code);
  return [by(500, 599), by(400, 499), counts.filter((c) => c.code < 400).sort((a, b) => b.count - a.count || a.code - b.code)];
}
