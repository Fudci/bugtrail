// Tab rentang waktu yang sama di Overview, API Health, Services, Traces dan Logs.
export type RangeOption<K extends string> = { key: K; label: string };

/** Rentang rollup (API Health, Services), sama dengan ROLLUP_RANGES di API (dashboard/common.ts). */
export const ROLLUP_RANGES: RangeOption<"1h" | "24h" | "7d">[] = [{ key: "1h", label: "1 hour" }, { key: "24h", label: "24 hours" }, { key: "7d", label: "7 days" }];
/** Rentang pencarian (Traces, Logs), sama dengan SEARCH_RANGES di API. */
export const SEARCH_RANGES: RangeOption<"15m" | "1h" | "24h" | "7d">[] = [{ key: "15m", label: "15 min" }, ...ROLLUP_RANGES];

/** Nilai ?range= dari URL; nilai tak dikenal kembali ke `fallback`. */
export const readRange = <K extends string>(raw: string | null, ranges: RangeOption<K>[], fallback: K): K =>
  ranges.some((r) => r.key === raw) ? (raw as K) : fallback;

export const rangeLabel = <K extends string>(ranges: RangeOption<K>[], key: K) => ranges.find((r) => r.key === key)?.label ?? key;

export function RangeTabs<K extends string>({ ranges, value, onPick }: { ranges: RangeOption<K>[]; value: K; onPick: (key: K) => void }) {
  return (
    <div className="ptabs" aria-label="Time range">
      {ranges.map((r) => <a key={r.key} className={value === r.key ? "on" : ""} onClick={() => onPick(r.key)}>{r.label}</a>)}
    </div>
  );
}
