import type { PrismaClient } from "@bugtool/db";

// Cache ambang trace lambat (projects.slow_trace_ms) per project supaya ingest tidak query DB tiap batch.
// Dikosongkan saat setting diubah; selain itu kedaluwarsa setelah TTL.
export const SLOW_CACHE_TTL_MS = 60_000;
const cache = new Map<string, { ms: number | null; until: number }>();

export const slowCache = {
  get(projectId: string) {
    const hit = cache.get(projectId);
    return hit && hit.until > Date.now() ? hit.ms : undefined;
  },
  set(projectId: string, ms: number | null) {
    if (cache.size > 10_000) cache.clear();
    cache.set(projectId, { ms, until: Date.now() + SLOW_CACHE_TTL_MS });
  },
  delete(projectId: string) {
    cache.delete(projectId);
  },
  clear() {
    cache.clear();
  },
};

/** Ambang (ms) atau null kalau mati. Gagal baca DB -> null (ingest tidak boleh gagal karena ini). */
export async function slowTraceMs(prisma: PrismaClient, projectId: string): Promise<number | null> {
  const hit = slowCache.get(projectId);
  if (hit !== undefined) return hit;
  try {
    const p = await prisma.project.findUnique({ where: { id: projectId }, select: { slowTraceMs: true } });
    const ms = p?.slowTraceMs ?? null;
    slowCache.set(projectId, ms);
    return ms;
  } catch {
    return null;
  }
}

/** Aturan "lambat" saat dibaca: durasi >= ambang dan tidak error. */
export const isSlow = (durationUs: number, thresholdMs: number | null, failed: boolean) =>
  thresholdMs != null && !failed && durationUs >= thresholdMs * 1000;
