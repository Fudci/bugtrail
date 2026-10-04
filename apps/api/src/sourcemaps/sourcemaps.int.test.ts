import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { strToU8, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrisma, openRaw, sqlitePath, tunePrisma } from "@bugtool/db";
import { buildApp } from "../app.js";
import { hashToken } from "../auth/tokens.js";
import { IngestStore } from "../process/store.js";
import { sha1, FileStore } from "./storage.js";
import { Symbolicator } from "./symbolicate.js";

const url = process.env["TEST_DATABASE_URL"];
if (!url) throw new Error("TEST_DATABASE_URL not set (jalankan lewat `pnpm test:int`)");

const prisma = createPrisma(url);
const raw = openRaw(sqlitePath(url));
const dir = mkdtempSync(join(tmpdir(), "bugtool-sm-"));
const files = new FileStore(dir);
const symbolicator = new Symbolicator(raw, files);
const store = new IngestStore(raw, { maxBacklog: 100, batchSize: 10, symbolicator });
let app: Awaited<ReturnType<typeof buildApp>>;
let projectId: string;
const TOKEN = "a".repeat(64);
const DEBUG_ID = "ca97d85e-3298-54df-a86c-abf05ee74743";
let minified = "";
let map = "";

// Kode asli dengan struktur panggilan yang diketahui: main -> submitOrder -> computeTotal (error).
const SOURCE = `export function computeTotal(items, user) {
  const subtotal = items.reduce((a, b) => a + b, 0);
  const key = user.profile.id.toUpperCase();
  return subtotal - key.length;
}
export function submitOrder() {
  return computeTotal([1, 2], {});
}
submitOrder();
`;

function zipBundle(manifestFiles: Record<string, object>, contents: Record<string, string>) {
  return zipSync({
    "manifest.json": strToU8(JSON.stringify({ files: manifestFiles })),
    ...Object.fromEntries(Object.entries(contents).map(([k, v]) => [k, strToU8(v)])),
  });
}

function multipart(chunks: { id: string; data: Uint8Array }[]) {
  const boundary = "----bugtooltest";
  const parts = chunks.map((c) => Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${c.id}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    Buffer.from(c.data),
    Buffer.from("\r\n"),
  ]));
  return { body: Buffer.concat([...parts, Buffer.from(`--${boundary}--\r\n`)]), type: `multipart/form-data; boundary=${boundary}` };
}

// Posisi (1-based) potongan teks di kode minify — dipakai untuk membuat frame seperti dari SDK.
function posOf(code: string, needle: string) {
  const idx = code.indexOf(needle);
  if (idx < 0) throw new Error(`needle not found: ${needle}`);
  const before = code.slice(0, idx).split("\n");
  return { lineno: before.length, colno: before.at(-1)!.length + 1 };
}

beforeAll(async () => {
  await tunePrisma(prisma);
  const out = await build({
    stdin: { contents: SOURCE, sourcefile: "src/checkout.js", loader: "js" },
    bundle: true, minify: true, format: "esm", sourcemap: "external", write: false, outfile: "main.js",
  });
  minified = out.outputFiles.find((f) => f.path.endsWith(".js"))!.text;
  map = out.outputFiles.find((f) => f.path.endsWith(".map"))!.text;

  await prisma.organization.deleteMany();
  const org = await prisma.organization.create({ data: { name: "S", slug: "s" } });
  const p = await prisma.project.create({ data: { organizationId: org.id, name: "Shop", slug: "shop", publicId: 77 } });
  const other = await prisma.project.create({ data: { organizationId: org.id, name: "Other", slug: "other", publicId: 78 } });
  await prisma.dsnKey.create({ data: { projectId: p.id, publicKey: "b".repeat(32) } });
  await prisma.uploadToken.create({ data: { projectId: p.id, name: "CI", tokenHash: hashToken(TOKEN) } });
  await prisma.uploadToken.create({ data: { projectId: other.id, name: "CI", tokenHash: hashToken("c".repeat(64)) } });
  projectId = p.id;
  store.start();
  app = await buildApp({ prisma, store, files, symbolicator });
});

afterAll(async () => {
  await app?.close();
  await store.stop();
  raw.close();
  await prisma.$disconnect();
  rmSync(dir, { recursive: true, force: true });
});

async function upload(zip: Uint8Array, token = TOKEN, projects = ["shop"]) {
  const id = sha1(zip);
  const headers = { authorization: `Bearer ${token}` };
  const pre = await app.inject({ method: "POST", url: "/api/0/organizations/x/artifactbundle/assemble/", headers, payload: { checksum: id, chunks: [id], projects } });
  if (pre.statusCode !== 200) return pre;
  expect(pre.json()).toEqual({ state: "not_found", missingChunks: [id] });
  const mp = multipart([{ id, data: zip }]);
  const up = await app.inject({ method: "POST", url: "/api/0/organizations/x/chunk-upload/", headers: { ...headers, "content-type": mp.type }, payload: mp.body });
  expect(up.statusCode).toBe(200);
  return app.inject({ method: "POST", url: "/api/0/organizations/x/artifactbundle/assemble/", headers, payload: { checksum: id, chunks: [id], projects } });
}

describe("protokol sentry-cli", () => {
  it("auth: token wajib & valid", async () => {
    expect((await app.inject({ method: "GET", url: "/api/0/" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/0/", headers: { authorization: "Bearer nope" } })).statusCode).toBe(401);
    const opts = await app.inject({ method: "GET", url: "/api/0/organizations/x/chunk-upload/", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(opts.json()).toMatchObject({ hashAlgorithm: "sha1", chunkSize: 8388608, accept: expect.arrayContaining(["artifact_bundles"]) });
  });

  it("chunk dengan checksum salah ditolak", async () => {
    const mp = multipart([{ id: "0".repeat(40), data: strToU8("hello") }]);
    const r = await app.inject({ method: "POST", url: "/api/0/organizations/x/chunk-upload/", headers: { authorization: `Bearer ${TOKEN}`, "content-type": mp.type }, payload: mp.body });
    expect(r.statusCode).toBe(400);
  });

  it("token project lain / --project salah / zip rusak ditolak", async () => {
    const zip = zipBundle({ "m.js.map": { type: "source_map", url: "~/m.js.map", headers: { "debug-id": DEBUG_ID } } }, { "m.js.map": map });
    expect((await upload(zip, TOKEN, ["other"])).statusCode).toBe(400);
    expect((await upload(zip, "c".repeat(64), ["other"])).statusCode).toBe(200);
    expect(await prisma.artifact.count({ where: { projectId } })).toBe(0); // masuk ke project "other", bukan "shop"
    expect((await upload(strToU8("bukan zip"))).json()).toMatchObject({ state: "error" });
  });

  it("unggah bundle -> artifact tersimpan per debug ID", async () => {
    const zip = zipBundle(
      {
        "files/_/_/main.js": { type: "minified_source", url: "~/main.js", headers: { "debug-id": DEBUG_ID, sourcemap: "main.js.map" } },
        "files/_/_/main.js.map": { type: "source_map", url: "~/main.js.map", headers: { "debug-id": DEBUG_ID.toUpperCase() } },
      },
      { "files/_/_/main.js": minified, "files/_/_/main.js.map": map },
    );
    const r = await upload(zip);
    expect(r.json()).toEqual({ state: "ok", missingChunks: [] });
    const arts = await prisma.artifact.findMany({ where: { projectId }, orderBy: { fileType: "asc" } });
    expect(arts.map((a) => [a.fileType, a.debugId])).toEqual([["minified_source", DEBUG_ID], ["source_map", DEBUG_ID]]);
  });
});

describe("penerjemahan stacktrace", () => {
  it("frame minify -> file, baris, kolom, nama fungsi & konteks asli; dipakai untuk grouping", async () => {
    // Bangun frame seperti yang dikirim SDK (urutan: terluar -> terdalam).
    // Hasil minify esbuild: function c(t,e){...e.profile.id...}function p(){return c([1,2],{})}p();
    const callee = /function \w\(\)\{return (\w)\(/.exec(minified)!;
    const entry = /\}(\w)\(\);export/.exec(minified)!;
    const at = (index: number) => ({ lineno: 1, colno: index + 1 });
    const frames = [
      { filename: "app:///main.js", abs_path: "app:///main.js", ...at(entry.index + 1), function: "?" },
      { filename: "app:///main.js", abs_path: "app:///main.js", ...at(callee.index + callee[0].length - 2), function: "p" },
      { filename: "app:///main.js", abs_path: "app:///main.js", ...posOf(minified, ".profile.id"), function: "c" },
    ];
    const payload = {
      event_id: "d".repeat(32),
      exception: { values: [{ type: "TypeError", value: "Cannot read properties of undefined (reading 'id')", stacktrace: { frames } }] },
      debug_meta: { images: [{ type: "sourcemap", code_file: "app:///main.js", debug_id: DEBUG_ID }] },
    };

    const r = symbolicator.symbolicate(projectId, payload);
    expect(r.missing).toEqual([]);
    const out = (r.payload as { exception: { values: { stacktrace: { frames: Record<string, unknown>[] }; raw_stacktrace: unknown }[] } }).exception.values[0]!;
    const [outer, mid, inner] = out.stacktrace.frames;
    expect(inner).toMatchObject({ filename: "src/checkout.js", lineno: 3, function: "computeTotal", in_app: true });
    expect(String(inner!["context_line"])).toContain("user.profile.id");
    expect(mid).toMatchObject({ filename: "src/checkout.js", lineno: 7, function: "submitOrder" });
    expect(outer).toMatchObject({ filename: "src/checkout.js", lineno: 9 });
    expect(out.raw_stacktrace).toEqual({ frames });
    expect(payload.exception.values[0]!.stacktrace.frames[2]!.function).toBe("c"); // input tidak dimutasi

    // Lewat jalur ingest: judul/culprit memakai nama asli.
    await store.enqueue([{ projectId, receivedAt: new Date().toISOString(), payload }]);
    await store.drain();
    const issue = await prisma.issue.findFirstOrThrow({ where: { projectId } });
    expect(issue.culprit).toBe("src/checkout.js in computeTotal");
  });

  it("debug ID tanpa source map dilaporkan sebagai missing", () => {
    const payload = {
      exception: { values: [{ stacktrace: { frames: [{ filename: "app:///x.js", lineno: 1, colno: 5 }] } }] },
      debug_meta: { images: [{ type: "sourcemap", code_file: "app:///x.js", debug_id: "11111111-2222-3333-4444-555555555555" }] },
    };
    const r = symbolicator.symbolicate(projectId, payload);
    expect(r.symbolicated).toBe(0);
    expect(r.missing).toEqual(["11111111-2222-3333-4444-555555555555"]);
  });
});
