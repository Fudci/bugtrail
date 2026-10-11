import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { MAX_OFFSET, PAGE_SIZES, pageCount, pageItems, rangeText, type PageSize } from "./pager-util";

// Pager bernomor bersama untuk tabel request (API Health) dan trace: ringkasan, Prev/Next, nomor halaman, ukuran halaman.
export function Pager({ page, size, total, rows, onPage, onSize, extra }: {
  page: number; size: PageSize; total: number; rows: number;
  onPage: (p: number) => void; onSize: (s: PageSize) => void; extra?: ReactNode;
}) {
  const count = pageCount(total, size);
  // Hasil lebih banyak dari batas offset API: halaman setelahnya tidak bisa dibuka.
  const capped = total > count * size;
  return (
    <>
      <div className="pager">
        <div className="pager-info" aria-live="polite">{rangeText(page, size, rows, total)}{extra}</div>
        {count > 1 || page > 1 ? (
          <nav className="pager-pages" aria-label="Pagination">
            <button type="button" onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label="Previous page"><ChevronLeft size={16} /></button>
            {pageItems(Math.min(page, count), count).map((p, i) => p === "…"
              ? <span key={`gap${i}`} className="pager-gap" aria-hidden="true">…</span>
              : <button key={p} type="button" onClick={() => onPage(p)} aria-label={`Page ${p}`}
                aria-current={p === page ? "page" : undefined}>{p.toLocaleString("en-US")}</button>)}
            <button type="button" onClick={() => onPage(page + 1)} disabled={page >= count} aria-label="Next page"><ChevronRight size={16} /></button>
          </nav>
        ) : null}
        <label className="pager-size">
          Rows per page
          <select className="select" value={size} onChange={(e) => onSize(Number(e.target.value) as PageSize)}>
            {PAGE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      </div>
      {capped && <div className="pager-note">Only the newest {MAX_OFFSET.toLocaleString("en-US")} results can be paged. Narrow the time range or filters to see older results.</div>}
    </>
  );
}
