// Draws the home-screen icon (a road running into the hills at sunset).
//   node tools/make-icons.mjs
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "public", "icons");

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2b5f9e"/>
      <stop offset="0.62" stop-color="#f2a65a"/>
      <stop offset="1" stop-color="#ffd58a"/>
    </linearGradient>
    <linearGradient id="road" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#4a4f57"/>
      <stop offset="1" stop-color="#22262c"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="url(#sky)"/>
  <circle cx="352" cy="262" r="46" fill="#fff4d6"/>
  <path d="M0 300 C 90 250 170 268 256 288 C 340 306 420 262 512 280 L512 512 L0 512 Z" fill="#2f5d3a"/>
  <path d="M0 340 C 120 310 200 330 300 352 C 390 372 450 350 512 360 L512 512 L0 512 Z" fill="#3f7a46"/>
  <path d="M236 300 L276 300 L420 512 L92 512 Z" fill="url(#road)"/>
  <path d="M253 312 L259 312 L262 340 L250 340 Z M246 368 L266 368 L271 410 L241 410 Z M234 446 L278 446 L286 512 L226 512 Z" fill="#f4f1e6"/>
</svg>`;

await mkdir(out, { recursive: true });
for (const size of [180, 192, 512]) {
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(path.join(out, `icon-${size}.png`));
}
console.log("icons written to", out);
