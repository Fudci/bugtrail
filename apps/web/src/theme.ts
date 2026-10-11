import { useState } from "react";
import { flushSync } from "react-dom";

export type Theme = "light" | "dark";
const KEY = "bt_theme";

// Tema awal dipasang oleh skrip inline di index.html (pilihan tersimpan, atau ikut OS); hook ini membaca hasilnya.
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => (document.documentElement.dataset["theme"] === "dark" ? "dark" : "light"));
  const apply = (t: Theme) => {
    document.documentElement.dataset["theme"] = t;
    localStorage.setItem(KEY, t);
    flushSync(() => setThemeState(t)); // ikon tombol ikut berganti di dalam snapshot transisi
  };
  /** Ganti tema. Dengan titik asal (x, y): tema baru melebar sebagai lingkaran dari titik itu (gaya Telegram). */
  const setTheme = (t: Theme, from?: { x: number; y: number }) => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!from || reduce || !document.startViewTransition) return apply(t);
    const r = Math.hypot(Math.max(from.x, innerWidth - from.x), Math.max(from.y, innerHeight - from.y));
    document.startViewTransition(() => apply(t)).ready.then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${from.x}px ${from.y}px)`, `circle(${r}px at ${from.x}px ${from.y}px)`] },
        { duration: 500, easing: "cubic-bezier(.4, 0, .2, 1)", pseudoElement: "::view-transition-new(root)" },
      );
    }).catch(() => {}); // transisi dibatalkan browser: tema tetap sudah terpasang
  };
  return [theme, setTheme] as const;
}
