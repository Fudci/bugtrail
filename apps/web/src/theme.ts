import { useState } from "react";

export type Theme = "light" | "dark";
const KEY = "bt_theme";

// Tema awal dipasang oleh skrip inline di index.html (pilihan tersimpan, atau ikut OS); hook ini membaca hasilnya.
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => (document.documentElement.dataset["theme"] === "dark" ? "dark" : "light"));
  const setTheme = (t: Theme) => {
    document.documentElement.dataset["theme"] = t;
    localStorage.setItem(KEY, t);
    setThemeState(t);
  };
  return [theme, setTheme] as const;
}
