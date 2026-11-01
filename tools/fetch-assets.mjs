// Downloads the free (CC0 / CC-BY) source art and converts it into the
// web-ready files the game loads from public/assets.
//
//   npm run assets
//
// Raw downloads are cached in tools/.cache so re-runs are quick.
import { mkdir, writeFile, readFile, access, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = path.join(root, "tools", ".cache");
const outDir = path.join(root, "public", "assets");
const UA = { "User-Agent": "driving-game-asset-fetch/0.1 (personal hobby project)" };

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function download(url, name) {
  const dest = path.join(cacheDir, name);
  if (await exists(dest)) return dest;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  console.log("downloaded", name);
  return dest;
}

async function phFiles(id) {
  const res = await fetch(`https://api.polyhaven.com/files/${id}`, { headers: UA });
  if (!res.ok) throw new Error(`Poly Haven files lookup failed for ${id}`);
  return res.json();
}

// Poly Haven texture set -> color / normal / arm (ao, roughness, metal) webp files.
async function phTexture(id, res, outName) {
  const files = await phFiles(id);
  const maps = { Diffuse: "color", nor_gl: "normal", arm: "arm" };
  for (const [key, suffix] of Object.entries(maps)) {
    const entry = files[key]?.[res]?.jpg;
    if (!entry) throw new Error(`${id} has no ${key} ${res}`);
    const src = await download(entry.url, path.basename(entry.url));
    const quality = suffix === "normal" ? 92 : 85;
    await sharp(src).webp({ quality }).toFile(path.join(outDir, "textures", `${outName}_${suffix}.webp`));
  }
}

// Poly Haven model leaf/twig atlas: merge the colour map with its separate alpha map.
async function phLeafAtlas(id, colorKey, alphaKey, outName) {
  const files = await phFiles(id);
  const color = await download(files[colorKey]["1k"].jpg.url, `${id}_${colorKey}_1k.jpg`);
  const alpha = await download(files[alphaKey]["1k"].jpg.url, `${id}_${alphaKey}_1k.jpg`);
  const alphaRaw = await sharp(alpha).extractChannel(0).raw().toBuffer();
  // (No removeAlpha() here: sharp would apply it after the join and drop the alpha.)
  await sharp(color)
    .joinChannel(alphaRaw, { raw: { width: 1024, height: 1024, channels: 1 } })
    .webp({ quality: 90, alphaQuality: 100 })
    .toFile(path.join(outDir, "textures", `${outName}.webp`));
}

// --- Radiance .hdr helpers -------------------------------------------------
// The sky photo contains the real sun, which is thousands of times brighter
// than the sky. Left in, it lights the world a second time on top of the sun
// light that casts shadows. We clamp it out, and record where it was so the
// game can point its sun light the same way.
function readHdr(buf) {
  let p = 0;
  const line = () => {
    let s = "";
    while (buf[p] !== 10) s += String.fromCharCode(buf[p++]);
    p++;
    return s;
  };
  const header = [];
  for (let l = line(); l !== ""; l = line()) header.push(l);
  const res = line();
  const m = res.match(/-Y (\d+) \+X (\d+)/);
  if (!m) throw new Error("unsupported hdr orientation " + res);
  const height = +m[1];
  const width = +m[2];
  const rgbe = new Uint8Array(width * height * 4);
  const scan = new Uint8Array(width * 4);
  for (let y = 0; y < height; y++) {
    if (buf[p] !== 2 || buf[p + 1] !== 2) throw new Error("expected RLE scanlines");
    p += 4;
    for (let c = 0; c < 4; c++) {
      let x = 0;
      while (x < width) {
        let n = buf[p++];
        if (n > 128) {
          n -= 128;
          const v = buf[p++];
          for (let i = 0; i < n; i++) scan[(x++) * 4 + c] = v;
        } else {
          for (let i = 0; i < n; i++) scan[(x++) * 4 + c] = buf[p++];
        }
      }
    }
    rgbe.set(scan, y * width * 4);
  }
  return { width, height, rgbe };
}

function writeHdr({ width, height, rgbe }) {
  const parts = [Buffer.from(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`, "ascii")];
  for (let y = 0; y < height; y++) {
    const out = [2, 2, (width >> 8) & 0xff, width & 0xff];
    for (let c = 0; c < 4; c++) {
      const at = (x) => rgbe[(y * width + x) * 4 + c];
      let x = 0;
      while (x < width) {
        // A run of 4+ equal bytes is stored as (128 + count, value).
        let run = 1;
        while (x + run < width && run < 127 && at(x + run) === at(x)) run++;
        if (run >= 4) {
          out.push(128 + run, at(x));
          x += run;
          continue;
        }
        // Otherwise copy literals up to the next run.
        const start = x;
        while (x < width && x - start < 128) {
          let ahead = 1;
          while (x + ahead < width && ahead < 4 && at(x + ahead) === at(x)) ahead++;
          if (ahead >= 4) break;
          x++;
        }
        out.push(x - start);
        for (let i = start; i < x; i++) out.push(at(i));
      }
    }
    parts.push(Buffer.from(out));
  }
  return Buffer.concat(parts);
}

function clampSun(img, maxLum) {
  const { width, height, rgbe } = img;
  let sx = 0, sy = 0, sw = 0, peak = 0;
  const lum = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const e = rgbe[i * 4 + 3];
    if (!e) continue;
    const f = Math.pow(2, e - 136);
    lum[i] = (0.2126 * rgbe[i * 4] + 0.7152 * rgbe[i * 4 + 1] + 0.0722 * rgbe[i * 4 + 2]) * f;
    peak = Math.max(peak, lum[i]);
  }
  for (let i = 0; i < width * height; i++) {
    const l = lum[i];
    if (l > peak * 0.5) {
      sx += (i % width) * l;
      sy += Math.floor(i / width) * l;
      sw += l;
    }
    if (l > maxLum) {
      // Scale the pixel down but keep its colour.
      const e = rgbe[i * 4 + 3];
      const f = Math.pow(2, e - 136) * (maxLum / l);
      const r = rgbe[i * 4] * f, g = rgbe[i * 4 + 1] * f, b = rgbe[i * 4 + 2] * f;
      const v = Math.max(r, g, b);
      const exp = Math.ceil(Math.log2(v / 255.99));
      const s = Math.pow(2, -exp);
      rgbe[i * 4] = Math.floor(r * s);
      rgbe[i * 4 + 1] = Math.floor(g * s);
      rgbe[i * 4 + 2] = Math.floor(b * s);
      rgbe[i * 4 + 3] = exp + 136;
    }
  }
  // Same equirectangular convention Babylon uses when it builds the cube map.
  const phi = ((sy / sw + 0.5) / height) * Math.PI;
  const theta = (((sx / sw + 0.5) / width) * 2 - 1) * Math.PI;
  return [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
}

async function main() {
  await mkdir(cacheDir, { recursive: true });
  await mkdir(path.join(outDir, "textures"), { recursive: true });
  await mkdir(path.join(outDir, "sky"), { recursive: true });
  await mkdir(path.join(outDir, "car"), { recursive: true });

  // Sky + image based lighting (CC0, Poly Haven, Greg Zaal / Jarod Guest)
  const sky = await phFiles("kloofendal_38d_partly_cloudy_puresky");
  const hdr = await download(sky.hdri["2k"].hdr.url, "sky_2k.hdr");
  const skyImg = readHdr(await readFile(hdr));
  const sunDir = clampSun(skyImg, 40);
  await writeFile(path.join(outDir, "sky", "sky_2k.hdr"), writeHdr(skyImg));
  await writeFile(path.join(outDir, "sky", "sun.json"), JSON.stringify({ direction: sunDir }, null, 2));

  // Ground, road and building surfaces (CC0, Poly Haven)
  await phTexture("rocky_terrain_02", "2k", "grass");
  await phTexture("aerial_rocks_02", "1k", "rock");
  await phTexture("asphalt_02", "2k", "asphalt");
  await phTexture("square_concrete_pavers", "1k", "pavers");
  await phTexture("white_plaster_02", "1k", "plaster");
  await phTexture("red_brick_03", "1k", "brick");
  await phTexture("bark_brown_02", "1k", "bark");

  // Foliage atlases for card trees (CC0, Poly Haven)
  await phLeafAtlas("jacaranda_tree", "leaves_diff", "leaves_alpha", "leaves_broad");
  await phLeafAtlas("fir_tree_01", "twig_diff", "twig_alpha", "leaves_fir");

  // Car (CC-BY 4.0, Darmstadt Graphics Group / Eric Chadwick, via Khronos glTF Sample Assets)
  const car = await download(
    "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/CarConcept/glTF-Binary/CarConcept.glb",
    "CarConcept.glb",
  );
  await copyFile(car, path.join(outDir, "car", "concept_car.glb"));

  console.log("assets ready in", outDir);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
