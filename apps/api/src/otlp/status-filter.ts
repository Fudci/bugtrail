// Filter status HTTP: daftar token dipisah koma. Token: kelas (1xx..5xx), kode persis (100-599),
// rentang ("520-529"), atau "error" (hanya pencarian trace). Kosong / "all" = tanpa filter.
// Hasil parse hanya berisi angka; SQL dibangun dari angka itu lewat parameter terikat.

export const MAX_STATUS_TOKENS = 20;

export interface StatusFilter {
  /** true = tanpa filter status. */
  all: boolean;
  /** Trace: status span root = 2 (error) ATAU HTTP >= 500. */
  error: boolean;
  /** Rentang inklusif [lo, hi]. */
  ranges: [number, number][];
}

const ALL: StatusFilter = { all: true, error: false, ranges: [] };
const code = (s: string) => {
  const n = Number(s);
  return n >= 100 && n <= 599 ? n : null;
};

/** Parse string filter; null kalau tidak sah. allowError: token "error" diizinkan (trace saja). */
export function parseStatusFilter(raw: string | undefined, opts: { allowError?: boolean } = {}): StatusFilter | null {
  const s = (raw ?? "").trim().toLowerCase();
  if (s === "" || s === "all") return ALL;
  const tokens = s.split(",").map((t) => t.trim());
  if (tokens.length > MAX_STATUS_TOKENS) return null;
  const out: StatusFilter = { all: false, error: false, ranges: [] };
  for (const t of tokens) {
    let m: RegExpExecArray | null;
    if (t === "all") return ALL;
    if (t === "error") {
      if (!opts.allowError) return null;
      out.error = true;
    } else if ((m = /^([1-5])xx$/.exec(t))) {
      const c = Number(m[1]) * 100;
      out.ranges.push([c, c + 99]);
    } else if (/^\d{3}$/.test(t)) {
      const c = code(t);
      if (c === null) return null;
      out.ranges.push([c, c]);
    } else if ((m = /^(\d{3})-(\d{3})$/.exec(t))) {
      const lo = code(m[1]!), hi = code(m[2]!);
      if (lo === null || hi === null || lo > hi) return null;
      out.ranges.push([lo, hi]);
    } else {
      return null;
    }
  }
  return out;
}

/** Sama dengan parseStatusFilter tapi melempar error (dipakai store; route sudah memvalidasi). */
export function statusFilterOf(raw: string, opts: { allowError?: boolean } = {}): StatusFilter {
  const f = parseStatusFilter(raw, opts);
  if (!f) throw new Error(`invalid status filter "${raw}"`);
  return f;
}

/**
 * Kondisi SQL (OR dari tiap token) atas kolom status `col`. `ph(i, which)` mengembalikan placeholder
 * untuk batas ke-i; nilainya dikembalikan di params (urutan sama dengan kemunculan placeholder).
 * errorSql: kondisi untuk token "error". Tanpa filter: "1 = 1".
 */
export function statusSql(f: StatusFilter, col: string, ph: (i: number, which: "lo" | "hi") => string, errorSql = "0 = 1") {
  if (f.all) return { sql: "1 = 1", params: [] as number[] };
  const parts: string[] = [];
  const params: number[] = [];
  if (f.error) parts.push(errorSql);
  f.ranges.forEach(([lo, hi], i) => {
    parts.push(`${col} BETWEEN ${ph(i, "lo")} AND ${ph(i, "hi")}`);
    params.push(lo, hi);
  });
  return { sql: `(${parts.join(" OR ")})`, params };
}
