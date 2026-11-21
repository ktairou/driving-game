// After `node tools/check.mjs --script tools/check-cars.js`: turns the pictures
// in its report into the garage thumbnails (public/assets/vehicles/thumbs/<id>.webp,
// 400 x 225, the middle of the frame) and keeps the night and driver's-seat
// pictures in tools/.cache/cars/check/ for a look. Prints what was measured.
//   node tools/car-thumbs.mjs [report folder, default tools/.cache/check] [--no-thumbs]
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const from = path.resolve(args.find((a) => !a.startsWith("--")) ?? path.join(root, "tools", ".cache", "check"));
const thumbs = path.join(root, "public", "assets", "vehicles", "thumbs");
const keep = path.join(root, "tools", ".cache", "cars", "check");
await mkdir(keep, { recursive: true });
const report = JSON.parse(await readFile(path.join(from, "report.json"), "utf8"));
const result = report.script;
if (!result?.cars) throw new Error(`no car check in ${from}/report.json: ${String(result).slice(0, 200)}`);
const picture = (url) => Buffer.from(url.split(",")[1], "base64");
for (const c of result.cars) {
  // (The generic sedan is there to compare against; its thumbnail stays as it was.)
  if (c.shot && !args.includes("--no-thumbs") && c.id !== "sedan") {
    const img = sharp(picture(c.shot));
    const { width, height } = await img.metadata();
    const h = Math.round((width * 9) / 16);
    // A 16:9 band a little below the middle, where the car is.
    const top = Math.min(height - h, Math.round((height - h) * 0.62));
    await img.extract({ left: 0, top, width, height: h }).resize(400, 225).webp({ quality: 82 }).toFile(path.join(thumbs, `${c.id}.webp`));
  }
  for (const k of ["shot", "night", "front", "driver"]) {
    if (c[k]) await writeFile(path.join(keep, `${c.id}.${k}.jpg`), picture(c[k]));
    delete c[k];
  }
}
console.log(JSON.stringify({ level: report.level, loaded: report.loaded, errors: report.errors, textureMB: report.textureMB, msRender: report.msRender, start: result.start, end: result.end }));
console.log("id                          tris  meshes  own MB  total MB  ms/frame  wheels  lamps  cockpit  drove(m)");
for (const c of result.cars) {
  if (c.error) {
    console.log(`${c.id.padEnd(26)} ERROR ${c.error}`);
    continue;
  }
  console.log(`${c.id.padEnd(26)} ${String(c.tris).padStart(6)}  ${String(c.meshes).padStart(6)}  ${String(c.mem.own).padStart(6)}  ${String(c.mem.total).padStart(8)}  ${String(c.msRender).padStart(8)}  ${String(c.wheels).padStart(6)}  ${String(c.lamps).padStart(5)}  ${String(c.cockpit).padStart(7)}  ${String(c.droveForward).padStart(8)}`);
}
console.log(`pictures in ${keep}`);
