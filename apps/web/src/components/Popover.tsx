import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

// Popover sederhana; tutup saat klik di luar atau Escape. Membuka ke atas kalau di bawah tidak cukup ruang.
export function Popover({ trigger, children, align = "left" }: { trigger: (toggle: () => void) => ReactNode; children: (close: () => void) => ReactNode; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [up, setUp] = useState(false);
  useLayoutEffect(() => {
    if (!open || !ref.current || !pop.current) return setUp(false);
    const below = window.innerHeight - ref.current.getBoundingClientRect().bottom;
    setUp(below < pop.current.offsetHeight + 16 && ref.current.getBoundingClientRect().top > below);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="rel" ref={ref}>
      {trigger(() => setOpen((o) => !o))}
      <div ref={pop} className={`pop ${open ? "open" : ""} ${up ? "up" : ""}`} style={align === "right" ? { right: 0 } : { left: 0 }}>
        {open && children(() => setOpen(false))}
      </div>
    </div>
  );
}
