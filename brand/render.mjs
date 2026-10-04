import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
// Butuh playwright-core: npm i -D playwright-core (memakai Chrome yang terpasang).
import { chromium } from "playwright-core";
const dir = dirname(fileURLToPath(import.meta.url));
const b = await chromium.launch({ channel: "chrome", headless: true });
// Ikon PNG dari SVG di berbagai ukuran (latar transparan di luar sudut membulat).
for (const [name, size, file] of [["app-icon-1024", 1024, "mark.svg"], ["icon-512", 512, "mark.svg"], ["icon-192", 192, "mark.svg"], ["favicon-32", 32, "favicon.svg"], ["favicon-180", 180, "favicon.svg"], ["mark-light-512", 512, "mark-light.svg"]]) {
  const p = await b.newPage({ viewport: { width: size, height: size } });
  // SVG ditempel langsung: halaman about:blank tidak boleh memuat file:// lewat <img>.
  const svg = readFileSync(`${dir}/${file}`, "utf8").replace("<svg ", `<svg width="${size}" height="${size}" `);
  await p.setContent(`<style>*{margin:0}body{background:transparent}svg{display:block}</style>${svg}`);
  await p.waitForTimeout(150);
  await p.screenshot({ path: `${dir}/${name}.png`, omitBackground: true });
  await p.close();
}
const p = await b.newPage({ viewport: { width: 1400, height: 1400 }, deviceScaleFactor: 2 });
await p.goto(`file://${dir}/render.html`);
await p.waitForLoadState("networkidle"); await p.waitForTimeout(500);
await p.locator("#wm").screenshot({ path: `${dir}/wordmark.png`, omitBackground: true });
await p.locator("#wmdark").screenshot({ path: `${dir}/wordmark-dark.png`, omitBackground: true });
const og = await b.newPage({ viewport: { width: 1200, height: 630 } });
await og.goto(`file://${dir}/render.html`); await og.waitForLoadState("networkidle"); await og.waitForTimeout(500);
await og.locator("#og").screenshot({ path: `${dir}/og-image.png` });
await b.close();
console.log("rendered");
