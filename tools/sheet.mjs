// Puts PNGs side by side in one JPEG, two per row, for a quick look.
//   node tools/sheet.mjs out.jpg a.png b.png ...
import sharp from "sharp";
const [out, ...files] = process.argv.slice(2);
const tiles = await Promise.all(files.map((f) => sharp(f).resize(512, 384).toBuffer()));
await sharp({ create: { width: files.length > 1 ? 1024 : 512, height: 384 * Math.ceil(files.length / 2), channels: 3, background: "#000" } })
  .composite(tiles.map((t, i) => ({ input: t, left: (i % 2) * 512, top: Math.floor(i / 2) * 384 })))
  .jpeg({ quality: 82 })
  .toFile(out);
console.log(out);
