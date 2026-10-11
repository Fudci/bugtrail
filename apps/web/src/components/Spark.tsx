// Kolom sparkline sempit: lebih dari ini, celah 2px antar batang menghabiskan lebarnya (batang jadi 0px).
const MAX_BARS = 30;

// Sparkline batang kecil; dipakai di daftar Issues dan API Health.
// Opsional (API Health): err = deret paralel (mis. jumlah 5xx) dan hot(n, e) menandai batang merah,
// dievaluasi ulang pada jumlah hasil penggabungan.
export function Spark({ data: raw, err: rawErr, hot, title }: {
  data?: number[]; err?: number[]; hot?: (n: number, e: number) => boolean; title?: (total: number) => string;
}) {
  if (!raw) return <span />;
  // Gabungkan bucket berdekatan (dijumlah) supaya jumlah batang <= MAX_BARS.
  const step = Math.ceil(raw.length / MAX_BARS);
  const merge = (xs: number[]) => step <= 1 ? xs : Array.from({ length: Math.ceil(raw.length / step) }, (_, i) =>
    xs.slice(i * step, (i + 1) * step).reduce((a, b) => a + b, 0));
  const data = merge(raw);
  const err = rawErr && hot ? merge(rawErr) : null;
  const max = Math.max(1, ...data);
  const total = data.reduce((a, b) => a + b, 0);
  return (
    <span className="spark" title={title?.(total)}>
      {data.map((n, i) => <i key={i} className={!n ? "z" : err && hot!(n, err[i] ?? 0) ? "hot" : ""} style={{ height: `${n ? Math.max(12, (n / max) * 100) : 8}%` }} />)}
    </span>
  );
}
