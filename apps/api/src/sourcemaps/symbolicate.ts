import { GREATEST_LOWER_BOUND, LEAST_UPPER_BOUND, originalPositionFor, sourceContentFor, TraceMap } from "@jridgewell/trace-mapping";
import { toDbDate, type RawDb } from "@bugtool/db";
import type { FileStore } from "./storage.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const CONTEXT_BEFORE = 5;
const CONTEXT_AFTER = 5;
const MAX_LINE_LEN = 300;

/** Debug ID dinormalisasi ke uuid lowercase dengan tanda hubung (SDK kadang kirim tanpa / huruf besar). */
export function normalizeDebugId(id: unknown): string | null {
  if (typeof id !== "string") return null;
  const h = id.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}/.test(h)) return null;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** code_file -> debug_id dari debug_meta.images (type "sourcemap"). */
export function sourcemapImages(payload: Obj): Map<string, string> {
  const out = new Map<string, string>();
  const dm = payload["debug_meta"];
  const images = isObj(dm) ? dm["images"] : null;
  if (!Array.isArray(images)) return out;
  for (const img of images) {
    if (!isObj(img) || img["type"] !== "sourcemap") continue;
    const id = normalizeDebugId(img["debug_id"]);
    if (id && typeof img["code_file"] === "string") out.set(img["code_file"], id);
  }
  return out;
}

function frameLists(payload: Obj): Obj[][] {
  const lists: Obj[][] = [];
  const exc = payload["exception"];
  const values = isObj(exc) ? exc["values"] : exc;
  if (Array.isArray(values)) {
    for (const v of values) {
      if (isObj(v) && isObj(v["stacktrace"]) && Array.isArray(v["stacktrace"]["frames"])) {
        lists.push((v["stacktrace"]["frames"] as unknown[]).filter(isObj));
      }
    }
  }
  return lists;
}

// Path sumber dari bundler sering berawalan "webpack://", "../", "./" — rapikan untuk tampilan & grouping.
export function cleanSourcePath(source: string) {
  return source.replace(/^webpack:\/\/[^/]*\//, "").replace(/^(\.\.?\/)+/, "").replace(/^\/+/, "");
}

const clip = (s: string) => (s.length > MAX_LINE_LEN ? s.slice(0, MAX_LINE_LEN) + "…" : s);

export interface SymbolicateResult {
  /** Payload baru (sudah diterjemahkan) atau payload asli kalau tidak ada yang berubah. */
  payload: Obj;
  symbolicated: number;
  /** Debug ID yang dirujuk event tapi source map-nya belum diunggah. */
  missing: string[];
}

interface CachedMap { map: TraceMap; lines: Map<string, string[]>; size: number }

/**
 * Menerjemahkan frame stacktrace JavaScript lewat source map yang diunggah sentry-cli.
 * - frame dicocokkan ke debug ID lewat debug_meta.images (code_file == abs_path atau filename)
 * - posisi: Sentry mengirim lineno & colno mulai dari 1; source map memakai kolom mulai dari 0
 * - frame asli disimpan di exception.values[].raw_stacktrace (konvensi Sentry)
 */
export class Symbolicator {
  private cache = new Map<string, CachedMap>(); // key: sha1 file, urutan = LRU
  private cacheBytes = 0;
  private findArtifact;
  private touch;

  constructor(private db: RawDb, private files: FileStore, private maxCacheBytes = 128 * 1024 * 1024) {
    this.findArtifact = db.prepare<[string, string], { sha1: string; last_used_at: string | null }>(
      "SELECT sha1, last_used_at FROM artifacts WHERE project_id = ? AND debug_id = ? AND file_type = 'source_map'",
    );
    this.touch = db.prepare("UPDATE artifacts SET last_used_at = ? WHERE project_id = ? AND debug_id = ? AND file_type = 'source_map'");
  }

  private load(projectId: string, debugId: string): CachedMap | null {
    const art = this.findArtifact.get(projectId, debugId);
    if (!art) return null;
    // Catat pemakaian (untuk retensi), paling sering sekali per jam per artifact.
    if (!art.last_used_at || Date.now() - new Date(art.last_used_at).getTime() > 3_600_000) {
      try {
        this.touch.run(toDbDate(new Date()), projectId, debugId);
      } catch {} // lock sibuk: tidak penting, coba lagi lain kali
    }
    const hit = this.cache.get(art.sha1);
    if (hit) {
      this.cache.delete(art.sha1);
      this.cache.set(art.sha1, hit);
      return hit;
    }
    const buf = this.files.readFile(art.sha1);
    if (!buf) return null;
    let map: TraceMap;
    try {
      map = new TraceMap(buf.toString("utf8"));
    } catch {
      return null;
    }
    const entry: CachedMap = { map, lines: new Map(), size: buf.length };
    this.cache.set(art.sha1, entry);
    this.cacheBytes += entry.size;
    for (const [k, v] of this.cache) {
      if (this.cacheBytes <= this.maxCacheBytes || this.cache.size <= 1) break;
      this.cache.delete(k);
      this.cacheBytes -= v.size;
    }
    return entry;
  }

  private sourceLines(entry: CachedMap, source: string): string[] | null {
    let lines = entry.lines.get(source);
    if (lines) return lines;
    const content = sourceContentFor(entry.map, source);
    if (content == null) return null;
    lines = content.split(/\r?\n/);
    entry.lines.set(source, lines);
    return lines;
  }

  symbolicate(projectId: string, payload: Obj): SymbolicateResult {
    const images = sourcemapImages(payload);
    const res: SymbolicateResult = { payload, symbolicated: 0, missing: [] };
    if (images.size === 0) return res;

    // Salin dalam (payload dari queue/DB tidak boleh dimutasi di tempat).
    const out = structuredClone(payload) as Obj;
    const missing = new Set<string>();
    const exc = out["exception"];
    const values = (isObj(exc) ? exc["values"] : exc) as unknown;
    if (!Array.isArray(values)) return res;

    for (const v of values) {
      if (!isObj(v) || !isObj(v["stacktrace"]) || !Array.isArray(v["stacktrace"]["frames"])) continue;
      if (v["raw_stacktrace"]) continue; // sudah diterjemahkan sebelumnya
      const original = structuredClone(v["stacktrace"]);
      const frames = (v["stacktrace"]["frames"] as unknown[]).filter(isObj);
      // Lewat 1: cari posisi asli tiap frame.
      const resolved: ({ entry: CachedMap; debugId: string; source: string; line: number; column: number | null; name: string | null } | null)[] =
        frames.map((f) => {
          const file = (typeof f["abs_path"] === "string" && images.has(f["abs_path"]) ? f["abs_path"] : f["filename"]) as string | undefined;
          const debugId = file ? images.get(file) : undefined;
          if (!debugId || typeof f["lineno"] !== "number") return null;
          const entry = this.load(projectId, debugId);
          if (!entry) {
            missing.add(debugId);
            return null;
          }
          const line = f["lineno"];
          // Sentry: kolom mulai dari 1. Source map: kolom mulai dari 0.
          const column = typeof f["colno"] === "number" ? Math.max(0, f["colno"] - 1) : 0;
          let pos = originalPositionFor(entry.map, { line, column, bias: GREATEST_LOWER_BOUND });
          if (pos.source == null) pos = originalPositionFor(entry.map, { line, column, bias: LEAST_UPPER_BOUND });
          if (pos.source == null || pos.line == null) return null;
          return { entry, debugId, source: pos.source, line: pos.line, column: pos.column, name: pos.name };
        });

      // Lewat 2: tulis ulang frame. Nama fungsi sebuah frame diambil dari posisi PEMANGGILNYA
      // (frame sebelumnya; frames urut dari terluar ke terdalam): di titik panggil, source map
      // memberi nama fungsi yang dipanggil. Nama di posisi frame itu sendiri justru nama yang
      // dipanggil berikutnya, jadi tidak dipakai.
      frames.forEach((f, idx) => {
        const r = resolved[idx];
        if (!r) return;
        const source = cleanSourcePath(r.source);
        const callerName = idx > 0 ? resolved[idx - 1]?.name : null;
        f["abs_path"] = r.source;
        f["filename"] = source;
        delete f["module"]; // module dari SDK merujuk ke file hasil build
        if (callerName) f["function"] = callerName;
        else if (idx === 0) delete f["function"]; // frame terluar: nama minify tidak berarti
        f["lineno"] = r.line;
        if (r.column != null) f["colno"] = r.column + 1;
        f["in_app"] = !/(^|\/)node_modules\//.test(source);
        delete f["pre_context"];
        delete f["context_line"];
        delete f["post_context"];
        const lines = this.sourceLines(r.entry, r.source);
        if (lines && r.line - 1 < lines.length) {
          const i = r.line - 1;
          f["pre_context"] = lines.slice(Math.max(0, i - CONTEXT_BEFORE), i).map(clip);
          f["context_line"] = clip(lines[i] ?? "");
          f["post_context"] = lines.slice(i + 1, i + 1 + CONTEXT_AFTER).map(clip);
        }
        f["data"] = { ...(isObj(f["data"]) ? f["data"] : {}), sourcemap: r.debugId, symbolicated: true };
        res.symbolicated++;
      });
      const changed = resolved.some(Boolean);
      if (changed) v["raw_stacktrace"] = original;
    }

    res.missing = [...missing];
    if (res.symbolicated > 0) res.payload = out;
    return res;
  }
}

/** Untuk tampilan: debug ID di event yang belum bisa diterjemahkan (frame belum punya data.symbolicated). */
export function unsymbolicatedDebugIds(payload: Obj): string[] {
  const images = sourcemapImages(payload);
  if (images.size === 0) return [];
  const ids = new Set<string>();
  for (const frames of frameLists(payload)) {
    for (const f of frames) {
      if (isObj(f["data"]) && f["data"]["symbolicated"]) continue;
      const file = (typeof f["abs_path"] === "string" && images.has(f["abs_path"]) ? f["abs_path"] : f["filename"]) as string | undefined;
      const id = file ? images.get(file) : undefined;
      if (id) ids.add(id);
    }
  }
  return [...ids];
}
