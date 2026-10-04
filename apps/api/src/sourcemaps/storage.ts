import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SHA1_RE = /^[0-9a-f]{40}$/;
export const sha1 = (buf: Uint8Array) => createHash("sha1").update(buf).digest("hex");
export const isSha1 = (s: string) => SHA1_RE.test(s);

/**
 * Penyimpanan file di disk, di samping file database:
 *   <dataDir>/chunks/<sha1>  potongan unggahan sentry-cli (sementara)
 *   <dataDir>/files/<sha1>   isi artifact (source map / bundle), dedup berdasarkan isi
 * Nama file selalu sha1 yang sudah divalidasi, jadi tidak ada path traversal.
 */
export class FileStore {
  readonly chunksDir: string;
  readonly filesDir: string;

  constructor(dataDir: string) {
    this.chunksDir = join(dataDir, "chunks");
    this.filesDir = join(dataDir, "files");
    mkdirSync(this.chunksDir, { recursive: true });
    mkdirSync(this.filesDir, { recursive: true });
  }

  static forDb(dbPath: string) {
    return new FileStore(join(dirname(dbPath), "blobs"));
  }

  // Tulis ke file sementara lalu rename: file tidak pernah terlihat setengah jadi.
  private atomicWrite(path: string, buf: Uint8Array) {
    const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    writeFileSync(tmp, buf);
    renameSync(tmp, path);
  }

  hasChunk(id: string) {
    return isSha1(id) && existsSync(join(this.chunksDir, id));
  }

  /** Simpan chunk; id harus sha1 dari isinya. */
  putChunk(id: string, buf: Uint8Array) {
    if (!isSha1(id)) throw new Error("invalid chunk id");
    if (sha1(buf) !== id) throw new Error(`chunk checksum mismatch for ${id}`);
    const path = join(this.chunksDir, id);
    if (!existsSync(path)) this.atomicWrite(path, buf);
  }

  readChunks(ids: string[]): Buffer {
    return Buffer.concat(ids.map((id) => readFileSync(join(this.chunksDir, id))));
  }

  deleteChunks(ids: string[]) {
    for (const id of ids) if (isSha1(id)) rmSync(join(this.chunksDir, id), { force: true });
  }

  /** Simpan isi file, return sha1 (dedup: isi sama = file sama). */
  putFile(buf: Uint8Array): string {
    const id = sha1(buf);
    const path = join(this.filesDir, id);
    if (!existsSync(path)) this.atomicWrite(path, buf);
    return id;
  }

  readFile(id: string): Buffer | null {
    if (!isSha1(id)) return null;
    try {
      return readFileSync(join(this.filesDir, id));
    } catch {
      return null;
    }
  }

  /** Hapus chunk yang terbengkalai dan file yang tidak dirujuk lagi. Return jumlah yang dihapus. */
  gc(referenced: Set<string>, chunkMaxAgeMs: number, now = Date.now()) {
    let removed = 0;
    for (const name of readdirSync(this.chunksDir)) {
      const p = join(this.chunksDir, name);
      try {
        if (now - statSync(p).mtimeMs > chunkMaxAgeMs) {
          rmSync(p, { force: true });
          removed++;
        }
      } catch {}
    }
    for (const name of readdirSync(this.filesDir)) {
      // .tmp sisa crash di tengah tulis juga dibersihkan.
      if (referenced.has(name)) continue;
      const p = join(this.filesDir, name);
      try {
        // Beri jeda 1 jam: file baru ditulis sebelum baris artifact-nya di-commit.
        if (now - statSync(p).mtimeMs > 60 * 60_000) {
          rmSync(p, { force: true });
          removed++;
        }
      } catch {}
    }
    return removed;
  }
}
