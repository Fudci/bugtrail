// Paging bernomor: ukuran halaman yang diizinkan API dan batas offset (sama dengan MAX_PAGE_OFFSET di API).
export const PAGE_SIZES = [25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export const DEFAULT_SIZE: PageSize = 50;
export const MAX_OFFSET = 10_000;

/** Baca ?page=&size= dari URL; nilai tak sah kembali ke default (1 dan 50). */
export function readPaging(params: URLSearchParams): { page: number; size: PageSize } {
  const s = Number(params.get("size"));
  const size = (PAGE_SIZES as readonly number[]).includes(s) ? (s as PageSize) : DEFAULT_SIZE;
  const p = Number(params.get("page"));
  const page = Number.isInteger(p) && p >= 1 ? Math.min(p, lastAllowedPage(size)) : 1;
  return { page, size };
}

/** Halaman terakhir yang masih boleh diminta (offset < MAX_OFFSET). */
export const lastAllowedPage = (size: number) => Math.ceil(MAX_OFFSET / size);

/** Jumlah halaman yang bisa dibuka untuk total tertentu (minimal 1, dibatasi MAX_OFFSET). */
export const pageCount = (total: number, size: number) => Math.max(1, Math.min(Math.ceil(total / size), lastAllowedPage(size)));

/**
 * Nomor halaman yang ditampilkan: pertama, terakhir, dan current±2; celah diganti "…".
 * Celah satu halaman saja ditampilkan sebagai nomornya (tidak ada gunanya "…" untuk satu angka).
 */
export function pageItems(current: number, count: number): (number | "…")[] {
  const keep = new Set([1, count]);
  for (let p = current - 2; p <= current + 2; p++) if (p >= 1 && p <= count) keep.add(p);
  const sorted = [...keep].sort((a, b) => a - b);
  const out: (number | "…")[] = [];
  let prev = 0;
  for (const p of sorted) {
    if (p - prev === 2) out.push(prev + 1);
    else if (p - prev > 2) out.push("…");
    out.push(p);
    prev = p;
  }
  return out;
}

/** "Showing 51–100 of 1,000"; kosong -> "Showing 0 of 0". */
export function rangeText(page: number, size: number, rows: number, total: number) {
  const f = (n: number) => n.toLocaleString("en-US");
  if (rows === 0) return `Showing 0 of ${f(total)}`;
  const from = (page - 1) * size + 1;
  return `Showing ${f(from)}–${f(from + rows - 1)} of ${f(total)}`;
}
