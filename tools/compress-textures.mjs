// Turns the game's pictures into KTX2 files (Basis Universal). A KTX2 picture
// stays compressed in graphics memory: a quarter of the size of a plain one, or
// less (the iPad unpacks it to ASTC or ETC2, desktops to BC7). Normal maps and
// the road use UASTC (closer to the original, bigger files); the rest ETC1S.
//
//   node tools/compress-textures.mjs [all|decoder|textures|people|vehicles|landmarks|car] [--force]
//
// - public/assets/textures/*.webp and public/assets/people/*.webp get a .ktx2
//   copy next to them. The .webp files stay: they are the source, and the town
//   paints its walls from two of them.
// - The GLBs in public/assets/{vehicles,landmarks,car} have their pictures
//   swapped for KTX2 in place (KHR_texture_basisu). The untouched originals are
//   kept in tools/.cache/ktx2-src/ and used again by --force, so the settings
//   can be changed. Run this after prepare-models.mjs: a GLB that still has
//   plain pictures is taken as the new original.
// - Babylon's KTX2 reader (from npm, the same version as the engine) is copied
//   to public/assets/ktx2/, so the game never fetches it from the internet.
//
// Without --force, files that are already done are skipped.
import path from "node:path";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, KHRTextureBasisu } from "@gltf-transform/extensions";
import { NodeBasisEncoder } from "ktx2-encoder";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const assets = path.join(root, "public", "assets");
const kept = path.join(root, "tools", ".cache", "ktx2-src");
const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const what = args.find((a) => !a.startsWith("--")) ?? "all";
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

// --- Encoding -------------------------------------------------------------------------
// kind: "color" (sRGB), "data" (linear: ARM, metal/rough, occlusion...) or "normal".
// flipY: the game loads it with invertY (a plain Texture); KTX2 can't be flipped
// on upload, so it is stored upside down instead. glTF pictures never are.
const basis = await new NodeBasisEncoder().init();

// UASTC (with Zstandard on top) for normal maps: ETC1S blurs their fine bumps
// into blocks. Also for the road's colour, which is right under the camera all
// the time: in ETC1S its cracks and grit came out a little flatter. Everything
// else is ETC1S, which side by side with the originals looked the same (colour,
// see-through leaves and people, mask maps) and makes files several times
// smaller. Both take one byte a pixel on the GPU; on the iPad, opaque ETC1S
// takes half that.
const SHARP = new Set(["asphalt_color"]);
const formatOf = (kind, name) => (kind === "normal" || SHARP.has(name) ? "UASTC" : "ETC1S");

async function encode(pixels, width, height, { kind, name, flipY }) {
  const e = new basis.BasisEncoder();
  try {
    e.setStatusOutput(false);
    e.setDebug(false);
    e.setCreateKTX2File(true);
    e.setTexType(0); // 2D
    e.setMipGen(true); // compressed pictures can't have mipmaps made on the GPU
    e.setYFlip(!!flipY);
    const uastc = formatOf(kind, name) === "UASTC";
    e.setUASTC(uastc);
    if (uastc) {
      e.setPackUASTCFlags(2); // effort 0-4: 2 is the usual balance
      e.setKTX2UASTCSupercompression(true);
    } else {
      e.setQualityLevel(255);
      e.setETC1SCompressionLevel(2);
    }
    if (kind === "normal") {
      e.setNormalMapPreset();
      e.setMipRenormalize(true);
    }
    const srgb = kind === "color";
    e.setPerceptual(srgb);
    e.setMipSRGB(srgb);
    e.setKTX2AndBasisSRGBTransferFunc(srgb);
    if (!e.setSliceSourceImage(0, pixels, width, height, 0)) throw new Error("source picture rejected");
    let out = new Uint8Array(Math.ceil(width * height * 4 * 1.34) + 65536);
    let n = e.encode(out);
    if (!n) {
      out = new Uint8Array(out.length * 2);
      n = e.encode(out);
    }
    if (!n) throw new Error("encode failed");
    return out.slice(0, n);
  } finally {
    e.delete();
  }
}

async function rgba(image) {
  const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let alpha = false;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) {
    alpha = true;
    break;
  }
  return { pixels: new Uint8Array(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height, alpha };
}

const kb = (n) => `${Math.round(n / 1024)} KB`;
const newer = async (a, b) => existsSync(a) && existsSync(b) && (await stat(a)).mtimeMs >= (await stat(b)).mtimeMs;

// --- Loose pictures: a .ktx2 next to each .webp ----------------------------------------
const kindOf = (name) => (/_normal$/.test(name) ? "normal" : /_arm$/.test(name) ? "data" : "color");

async function folder(dir) {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".webp"));
  for (const f of files) {
    const src = path.join(dir, f);
    const dst = src.replace(/\.webp$/, ".ktx2");
    if (!FORCE && (await newer(dst, src))) continue;
    const name = f.replace(/\.webp$/, "");
    const img = await rgba(await readFile(src));
    const opts = { kind: kindOf(name), name, flipY: true };
    const t = Date.now();
    const out = await encode(img.pixels, img.width, img.height, opts);
    await writeFile(dst, out);
    console.log(`${path.relative(root, dst)}  ${img.width}x${img.height} ${opts.kind}${img.alpha ? "+alpha" : ""} ${formatOf(opts.kind, name)}  ${kb((await stat(src)).size)} -> ${kb(out.length)}  ${((Date.now() - t) / 1000).toFixed(1)} s`);
  }
}

// --- GLBs: swap every picture for KTX2 in place -----------------------------------------
const SRGB_SLOTS = new Set(["baseColorTexture", "emissiveTexture", "diffuseTexture", "specularGlossinessTexture", "sheenColorTexture", "specularColorTexture"]);
// Tiny pictures cost next to nothing and block compression would only blur them.
const MIN_PIXELS = 256 * 256;

async function glb(file, group) {
  const backup = path.join(kept, group, path.basename(file));
  let doc = await io.read(file);
  const isKtx = (d) => d.getRoot().listTextures().some((t) => t.getMimeType() === "image/ktx2");
  if (isKtx(doc)) {
    if (!FORCE) return;
    if (!existsSync(backup)) {
      console.log(`${path.relative(root, file)}: already compressed and no original kept, skipped`);
      return;
    }
    doc = await io.read(backup);
  } else {
    if (!doc.getRoot().listTextures().length) return; // nothing to do (no pictures)
    await mkdir(path.dirname(backup), { recursive: true });
    await copyFile(file, backup);
  }
  const root_ = doc.getRoot();
  const before = (await stat(backup)).size;
  let done = 0;
  let skipped = 0;
  for (const tex of root_.listTextures()) {
    const slots = new Set(doc.getGraph().listParentEdges(tex).filter((e) => e.getParent() !== root_).map((e) => e.getName()));
    const img = await rgba(tex.getImage());
    if (img.width * img.height < MIN_PIXELS || img.width % 4 || img.height % 4) {
      skipped++;
      continue;
    }
    const kind = [...slots].some((s) => SRGB_SLOTS.has(s)) ? "color" : slots.has("normalTexture") ? "normal" : "data";
    const out = await encode(img.pixels, img.width, img.height, { kind, flipY: false });
    tex.setImage(out).setMimeType("image/ktx2");
    if (tex.getURI()) tex.setURI(tex.getURI().replace(/\.\w+$/, ".ktx2"));
    done++;
  }
  // Fail loudly rather than ship a half-done model.
  const left = root_.listTextures().filter((t) => t.getMimeType() !== "image/ktx2");
  if (left.length !== skipped) throw new Error(`${file}: ${left.length - skipped} pictures were not converted`);
  if (done) doc.createExtension(KHRTextureBasisu).setRequired(true);
  // WebP is no longer needed if every picture is now KTX2.
  if (!left.some((t) => t.getMimeType() === "image/webp")) root_.listExtensionsUsed().find((e) => e.extensionName === "EXT_texture_webp")?.dispose();
  await io.write(file, doc);
  console.log(`${path.relative(root, file)}  ${done} pictures to KTX2${skipped ? `, ${skipped} tiny ones left` : ""}  ${kb(before)} -> ${kb((await stat(file)).size)}`);
}

async function glbFolder(group) {
  const dir = path.join(assets, group);
  for (const f of (await readdir(dir)).filter((f) => f.endsWith(".glb"))) await glb(path.join(dir, f), group);
}

// --- The KTX2 reader the game uses -----------------------------------------------------
async function decoder() {
  const out = path.join(assets, "ktx2");
  await mkdir(out, { recursive: true });
  const wasm = path.join(root, "node_modules", "@babylonjs", "ktx2decoder", "wasm");
  for (const f of await readdir(wasm)) await copyFile(path.join(wasm, f), path.join(out, f));
  await copyFile(path.join(root, "node_modules", "babylonjs-ktx2decoder", "babylon.ktx2Decoder.js"), path.join(out, "babylon.ktx2Decoder.js"));
  // (license.md, from the wasm folder, covers the transcoders; this one the reader itself.)
  await copyFile(path.join(root, "node_modules", "babylonjs-ktx2decoder", "license.md"), path.join(out, "babylon-license.md"));
  const core = JSON.parse(await readFile(path.join(root, "node_modules", "@babylonjs", "core", "package.json"), "utf8")).version;
  const dec = JSON.parse(await readFile(path.join(root, "node_modules", "babylonjs-ktx2decoder", "package.json"), "utf8")).version;
  if (core !== dec) console.warn(`warning: Babylon ${core} but KTX2 reader ${dec}: install the matching babylonjs-ktx2decoder and @babylonjs/ktx2decoder`);
  console.log(`${path.relative(root, out)}: KTX2 reader ${dec}`);
}

const steps = {
  decoder,
  textures: () => folder(path.join(assets, "textures")),
  people: () => folder(path.join(assets, "people")),
  vehicles: () => glbFolder("vehicles"),
  landmarks: () => glbFolder("landmarks"),
  car: () => glbFolder("car"),
};
if (what !== "all" && !steps[what]) throw new Error(`unknown step "${what}"`);
for (const [name, run] of Object.entries(steps)) if (what === "all" || what === name) await run();
