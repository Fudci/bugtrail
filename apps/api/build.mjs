// Bundle API + skrip admin jadi file JS tunggal. Hanya better-sqlite3 (modul native) yang tetap eksternal,
// jadi image produksi cukup install satu paket itu.
import { build } from "esbuild";

await build({
  entryPoints: { server: "src/index.ts", "create-admin": "src/scripts/create-admin.ts" },
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["better-sqlite3"],
  minify: true,
  sourcemap: false,
  legalComments: "none",
  // Beberapa dependensi CJS memakai require(); sediakan di bundle ESM.
  banner: { js: "import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);" },
  logLevel: "info",
});
