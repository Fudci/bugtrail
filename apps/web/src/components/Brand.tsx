// Logo BugTrail (sumber: brand/mark.svg dan brand/favicon.svg). Inline supaya tajam di semua ukuran tanpa request tambahan.
export function BrandMark({ size = 32 }: { size?: number }) {
  // Di bawah 48px pakai versi sederhana (brand/favicon.svg) supaya kumbangnya tetap terbaca.
  if (size < 48) return (
    <svg className="brand-mark" viewBox="0 0 64 64" width={size} height={size} aria-hidden>
      <rect width="64" height="64" rx="15" fill="#1f1f1d" />
      <circle cx="13" cy="51" r="3.6" fill="#f4cf4f" /><circle cx="22" cy="42" r="3.6" fill="#f4cf4f" />
      <g transform="translate(39 27) rotate(45)">
        <g stroke="#e5484d" strokeWidth="3.4" strokeLinecap="round">
          <path d="M-8 -4 L-16 -8" /><path d="M-9 4 L-17 6" /><path d="M8 -4 L16 -8" /><path d="M9 4 L17 6" />
        </g>
        <circle cx="0" cy="-13" r="6" fill="#e5484d" />
        <ellipse cx="0" cy="2" rx="10.5" ry="12.5" fill="#e5484d" />
        <path d="M0 -8 L0 13" stroke="#1f1f1d" strokeWidth="2.2" strokeLinecap="round" />
      </g>
    </svg>
  );
  return (
    <svg className="brand-mark" viewBox="0 0 512 512" width={size} height={size} aria-hidden>
      <rect width="512" height="512" rx="116" fill="#1f1f1d" />
      <path d="M104 420 C150 384 124 322 192 306 S254 282 268 262" fill="none" stroke="#f4cf4f" strokeWidth="24" strokeLinecap="round" strokeDasharray="0 50" />
      <g transform="translate(330 196) rotate(45) scale(.94)">
        <g stroke="#e5484d" strokeWidth="15" strokeLinecap="round" fill="none">
          <path d="M-38 -22 L-80 -42" /><path d="M-46 10 L-90 10" /><path d="M-38 42 L-78 66" />
          <path d="M38 -22 L80 -42" /><path d="M46 10 L90 10" /><path d="M38 42 L78 66" />
          <path d="M-10 -92 L-28 -124" strokeWidth="10" /><path d="M10 -92 L28 -124" strokeWidth="10" />
        </g>
        <circle cx="0" cy="-70" r="28" fill="#e5484d" />
        <ellipse cx="0" cy="12" rx="50" ry="60" fill="#e5484d" />
        <path d="M0 -44 L0 70" stroke="#1f1f1d" strokeWidth="8" strokeLinecap="round" />
        <circle cx="-22" cy="4" r="8" fill="#1f1f1d" /><circle cx="22" cy="28" r="8" fill="#1f1f1d" />
      </g>
    </svg>
  );
}

export function BrandLogo({ size = 32 }: { size?: number }) {
  return (
    <span className="brand" style={{ fontSize: size * 0.62 }}>
      <BrandMark size={size} />
      <span>Bug<b>Trail</b></span>
    </span>
  );
}
