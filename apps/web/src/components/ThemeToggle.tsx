import { Moon, Sun } from "lucide-react";
import { useTheme } from "../theme";

export function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const dark = theme === "dark";
  return (
    <button type="button" className="iconbtn ghost" title={dark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label="Toggle theme" onClick={(e) => {
        const b = e.currentTarget.getBoundingClientRect();
        setTheme(dark ? "light" : "dark", { x: b.left + b.width / 2, y: b.top + b.height / 2 });
      }}>
      {dark ? <Sun /> : <Moon />}
    </button>
  );
}
