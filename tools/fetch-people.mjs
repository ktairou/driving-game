// Downloads realistic people from Microsoft's Rocketbox avatar library (MIT
// licence) plus walking, running and standing animations, and shrinks their
// textures for the iPad.
//   node tools/fetch-people.mjs
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = path.join(root, "tools", ".cache", "rocketbox");
const outDir = path.join(root, "public", "assets", "people");
const RAW = "https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/master/Assets";

// [folder, texture prefix]
export const AVATARS = [
  ["Adults/Male_Adult_01", "m002"],
  ["Adults/Male_Adult_04", "m006"],
  ["Adults/Male_Adult_08", "m014"],
  ["Professions/Business_Male_02", "m008"],
  ["Adults/Female_Adult_01", "f001"],
  ["Adults/Female_Adult_04", "f004"],
  ["Adults/Female_Adult_08", "f008"],
  ["Professions/Business_Female_01", "f014"],
];

const ANIMATIONS = {
  walk_m: "all_animations_max_motextr_xy/m_walk_neutral_01.max.fbx",
  walk_f: "all_animations_max_motextr_xy/f_walk_neutral_01.max.fbx",
  run_m: "all_animations_max_motextr_xy/m_run_neutral_01.max.fbx",
  run_f: "all_animations_max_motextr_xy/f_run_neutral_01.max.fbx",
  idle_m: "all_animations_max_motextr_static/m_idle_neutral_01.max.fbx",
  idle_f: "all_animations_max_motextr_static/f_idle_neutral_01.max.fbx",
};

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function download(url, file) {
  const dest = path.join(cacheDir, file);
  if (await exists(dest)) return dest;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  console.log("downloaded", file);
  return dest;
}

// Minimal .tga reader (true-colour, plain or run-length packed) -> RGBA pixels.
function readTga(buf) {
  const idLen = buf[0];
  const type = buf[2];
  const w = buf.readUInt16LE(12);
  const h = buf.readUInt16LE(14);
  const bpp = buf[16] / 8;
  const topDown = (buf[17] & 0x20) !== 0;
  if (type !== 2 && type !== 10) throw new Error(`unsupported tga type ${type}`);
  const out = Buffer.alloc(w * h * 4);
  let p = 18 + idLen;
  let i = 0;
  const put = (o) => {
    out[i * 4] = buf[o + 2];
    out[i * 4 + 1] = buf[o + 1];
    out[i * 4 + 2] = buf[o];
    out[i * 4 + 3] = bpp === 4 ? buf[o + 3] : 255;
    i++;
  };
  while (i < w * h) {
    if (type === 2) {
      put(p);
      p += bpp;
    } else {
      const head = buf[p++];
      const n = (head & 0x7f) + 1;
      if (head & 0x80) {
        for (let k = 0; k < n; k++) put(p);
        p += bpp;
      } else {
        for (let k = 0; k < n; k++) {
          put(p);
          p += bpp;
        }
      }
    }
  }
  if (!topDown) {
    // Flip rows so the image is the right way up.
    const row = w * 4;
    const tmp = Buffer.alloc(row);
    for (let y = 0; y < h / 2; y++) {
      const a = y * row;
      const b = (h - 1 - y) * row;
      out.copy(tmp, 0, a, a + row);
      out.copy(out, a, b, b + row);
      tmp.copy(out, b);
    }
  }
  return { data: out, width: w, height: h };
}

// One texture per person: body on top, head and hair cards side by side
// underneath, so each person is drawn in a single pass. The game moves each
// part's texture coordinates to match (see ATLAS in src/people.js).
async function makeAtlas(files, dest) {
  const part = async (file, size) => {
    const img = readTga(await readFile(file));
    return sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } }).resize(size, size).png().toBuffer();
  };
  const [body, head, hair] = await Promise.all([part(files.body, 1024), part(files.head, 512), part(files.opacity, 512)]);
  await sharp({ create: { width: 1024, height: 1536, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([
      { input: body, left: 0, top: 0 },
      { input: head, left: 0, top: 1024 },
      { input: hair, left: 512, top: 1024 },
    ])
    .webp({ quality: 86, alphaQuality: 90 })
    .toFile(dest);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  for (const [folder, prefix] of AVATARS) {
    const name = folder.split("/")[1];
    const base = `${RAW}/Avatars/${folder}`;
    const fbx = await download(`${base}/Export/${name}.fbx`, `${name}/${name}.fbx`);
    await writeFile(path.join(outDir, `${name}.fbx`), await readFile(fbx));
    const files = {};
    for (const label of ["body", "head", "opacity"]) {
      files[label] = await download(`${base}/Textures/${prefix}_${label}_color.tga`, `${name}/${prefix}_${label}_color.tga`);
    }
    await makeAtlas(files, path.join(outDir, `${name}.webp`));
  }
  for (const [label, file] of Object.entries(ANIMATIONS)) {
    const src = await download(`${RAW}/Animations/${file}`, `anim/${label}.fbx`);
    await writeFile(path.join(outDir, `${label}.fbx`), await readFile(src));
  }
  // The MIT licence asks for its notice to travel with the files.
  const licence = await download(`${RAW.slice(0, -"/Assets".length)}/LICENSE.md`, "LICENSE.md");
  await writeFile(path.join(outDir, "LICENSE.md"), await readFile(licence));
  console.log("people ready in", outDir);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
