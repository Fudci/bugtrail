// Cache validasi DSN key -> project, dipakai route ingest supaya tiap event tidak query DB.
// Dikosongkan saat project dihapus supaya DSN-nya langsung ditolak (bukan menunggu TTL).
export const KEY_CACHE_TTL_MS = 30_000;
// value: UUID project kalau key sah, null kalau tidak.
const cache = new Map<string, { projectId: string | null; until: number }>();

export const keyCache = {
  get(k: string) {
    const hit = cache.get(k);
    return hit && hit.until > Date.now() ? hit.projectId : undefined;
  },
  set(k: string, projectId: string | null) {
    if (cache.size > 10_000) cache.clear();
    cache.set(k, { projectId, until: Date.now() + KEY_CACHE_TTL_MS });
  },
  clear() {
    cache.clear();
  },
};
