# BugTrail — aset brand

Konsep: kumbang (bug) yang meninggalkan jejak titik (trail = stacktrace & breadcrumbs).
Warna: `#1f1f1d` (latar), `#e5484d` (kumbang), `#f4cf4f` (jejak) — sama dengan dashboard.

| File | Pakai untuk |
|---|---|
| `mark.svg` | Logo utama (ikon dengan latar gelap). Sumber semua PNG. |
| `mark-light.svg` | Logo tanpa latar, di atas warna terang. |
| `favicon.svg` | Versi sederhana untuk ukuran kecil (16–64 px). |
| `app-icon-1024.png`, `icon-512.png`, `icon-192.png` | Ikon app / PWA / store. |
| `favicon-32.png`, `favicon-180.png` | Favicon browser & apple-touch-icon. |
| `wordmark.png`, `wordmark-dark.png` | Logo + tulisan "BugTrail" (latar terang / gelap). |
| `og-image.png` | Gambar pratinjau link (1200×630) untuk website & media sosial. |

Render ulang PNG setelah mengubah SVG: `node render.mjs` (butuh Chrome + playwright-core).
