// Urai stacktrace teks Node.js/V8 (isi `exception.stacktrace` dari OpenTelemetry) menjadi frame
// berformat Sentry: urutan dari paling luar ke paling dalam (frame terakhir = tempat error terjadi).
export interface SentryFrame {
  function?: string;
  filename: string;
  abs_path: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
}

// "    at fn (file:line:col)"  |  "    at file:line:col"  |  "    at async fn (file:line:col)"
const AT_WITH_FN = /^\s*at\s+(?:async\s+)?(.+?)\s+\((.+?)(?::(\d+))?(?::(\d+))?\)\s*$/;
const AT_BARE = /^\s*at\s+(?:async\s+)?(.+?)(?::(\d+))?(?::(\d+))?\s*$/;

function cleanPath(p: string): string {
  return p.startsWith("file://") ? decodeURIComponent(p.slice("file://".length)) : p;
}

// Path relatif terhadap root aplikasi supaya grouping sama di semua server/container.
export function shortPath(p: string, roots: string[]): string {
  for (const r of roots) if (r && p.startsWith(r)) return p.slice(r.length).replace(/^\/+/, "");
  const nm = p.lastIndexOf("/node_modules/");
  return nm >= 0 ? p.slice(nm + 1) : p;
}

function isInApp(p: string): boolean {
  return !(p.includes("node_modules/") || p.startsWith("node:") || p.startsWith("internal/") || p === "<anonymous>" || p === "native");
}

export function parseNodeStack(stack: string, roots: string[] = []): SentryFrame[] {
  const frames: SentryFrame[] = [];
  for (const line of stack.split("\n")) {
    if (!/^\s*at\s/.test(line)) continue;
    let fn: string | undefined, loc: string, ln: string | undefined, col: string | undefined;
    const m = AT_WITH_FN.exec(line);
    if (m) [, fn, loc, ln, col] = m as unknown as [string, string, string, string | undefined, string | undefined];
    else {
      const b = AT_BARE.exec(line);
      if (!b) continue;
      [, loc, ln, col] = b as unknown as [string, string, string | undefined, string | undefined];
    }
    const abs = cleanPath(loc);
    const frame: SentryFrame = { filename: shortPath(abs, roots), abs_path: abs, in_app: isInApp(abs) };
    if (fn) frame.function = fn.replace(/^new\s+/, "new ");
    if (ln) frame.lineno = Number(ln);
    if (col) frame.colno = Number(col);
    frames.push(frame);
  }
  return frames.reverse();
}
