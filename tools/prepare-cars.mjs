// Turns the real cars downloaded from Sketchfab (tools/.cache/sketchfab/cars,
// Creative Commons; each one's credit is in tools/cars.json) into game files:
//   public/assets/vehicles/<id>.glb      the one you drive: body, glass, lamps,
//                                        interior and four separate wheels
//   public/assets/vehicles/<id>_lod.glb  a light copy for traffic and race rivals
//   public/assets/vehicles/vehicles.json sizes (merged with the other vehicles)
//   src/realCars.json                    what the game needs to know about each
//   CREDITS.md                           the real cars' credits (between markers)
// Each car is turned nose to +Z, scaled to its real length and stood on the
// origin (on the ground, midway between its wheels), like the other vehicles.
// Afterwards run `node tools/compress-textures.mjs vehicles` (KTX2 pictures).
//
//   node tools/prepare-cars.mjs [id,id,...] [--preview] [--parts]
//   node tools/prepare-cars.mjs --hold                  (see "Held cars" below)
//   node tools/prepare-cars.mjs --unhold id,id|all
//
// --preview also draws each car from the side, top, front and back into
// tools/.cache/cars/<id>.png, coloured by what each part was taken to be
// (wheels, glass, lamps, interior), to check a new car before loading the game.
// --parts lists every part with what it was taken to be, where it is (metres,
// nose to +Z, +X to the car's left) and its colour, for writing `parts` fixes.
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { metalRough } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptSimplifier } from "meshoptimizer";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "tools", ".cache", "sketchfab", "cars");
const outDir = path.join(root, "public", "assets", "vehicles");
const previewDir = path.join(root, "tools", ".cache", "cars");
const args = process.argv.slice(2);
const PREVIEW = args.includes("--preview");
const PARTS = args.includes("--parts");
const only = args.find((a) => !a.startsWith("--"))?.split(",");

await MeshoptDecoder.ready;
await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder });

// How much each car may cost the iPad. FULL is the one you drive (about 40,000
// triangles in all), LOD the copy drawn many times in traffic. Triangles per
// part; pictures: the main one up to maxTexture, the rest up to minorTexture,
// and all of them together (as compressed in graphics memory) up to textureMB.
// A picture is kept if it covers keepArea square metres (at most keepTextures
// of them, and wheelTextures on the wheels); the rest become plain colours.
const FULL = { body: 29000, wheel: 1800, caliper: 120, interior: 3000, maxTexture: 1024, minorTexture: 512, textureMB: 8, keepArea: 0.15, keepTextures: 6, wheelTextures: 1 };
const LOD = { body: 6000, wheel: 280, caliper: 30, interior: 400, maxTexture: 512, minorTexture: 256, textureMB: 1.2, keepArea: 0.6, keepTextures: 3, wheelTextures: 0 };

// What a part is, from its node, mesh and material names (overridden per car in cars.json).
const ROLE = {
  lamp: /light|lamp|optic|\bled|_led|led_|luces|signal|indicator|blinker|reflector|chmsl|\bdrl|_drl|faro|fanale|gabarite|emission|\bemit/i,
  notLamp: /plastic|housing|defrost|lightweight|highlight|disc|disk|rotor|brake_?pad|calip/i,
  tail: /tail|brake|stop|rear|red|rojo|rosso|rouge|bremse/i,
  glass: /glass|window|windshield|windscreen|glace|vidrio|lunas|cristal|vetro|scheibe|translucent/i,
  notGlass: /surr|frame|seal|rubber|frit|trim/i,
  interior: /interior|inside|seat|dash|steer|carpet|floor_?mat|floormat|leather|stitch|gauge|dial|needle|pedal|belt|cockpit|cabin|console|screen|display|speaker|shifter|knob|\bmats?\b|cloth|door_?card|\bint\d|\bint_|_int\b|lining|headliner|airbag|cuero/i,
  caliper: /calip|callip|brake_?pad|bremssattel|pinza|plaquette/i,
};

// ---------- Small maths ----------------------------------------------------------------
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const floorPow2 = (n) => 2 ** Math.floor(Math.log2(Math.max(1, n)));

// Points and directions through a column-major 4x4 matrix.
const applyPoint = (m, a, i) => {
  const x = a[i], y = a[i + 1], z = a[i + 2];
  a[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
  a[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  a[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
};
const applyDir = (m, a, i) => {
  const x = a[i], y = a[i + 1], z = a[i + 2];
  const nx = m[0] * x + m[4] * y + m[8] * z;
  const ny = m[1] * x + m[5] * y + m[9] * z;
  const nz = m[2] * x + m[6] * y + m[10] * z;
  const l = Math.hypot(nx, ny, nz) || 1;
  a[i] = nx / l;
  a[i + 1] = ny / l;
  a[i + 2] = nz / l;
};
const det3 = (m) => m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
// Normals go through the inverse transpose (models are often scaled unevenly).
function normalMatrix(m) {
  const [a, b, c, d, e, f, g, h, i] = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const D = -(b * i - c * h), E = a * i - c * g, F = -(a * h - b * g);
  const G = b * f - c * e, H = -(a * f - c * d), I = a * e - b * d;
  return [A, B, C, 0, D, E, F, 0, G, H, I, 0, 0, 0, 0, 1];
}
const rotY = (t) => [Math.cos(t), 0, -Math.sin(t), 0, 0, 1, 0, 0, Math.sin(t), 0, Math.cos(t), 0, 0, 0, 0, 1];
const mul = (a, b) => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
const translate = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const scaling = (s) => [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1];
// Rotation taking unit vector a onto unit vector b (Rodrigues).
function rotationBetween(a, b) {
  const v = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const k = 1 / (1 + c);
  return [
    v[0] * v[0] * k + c, v[1] * v[0] * k + v[2], v[2] * v[0] * k - v[1], 0,
    v[0] * v[1] * k - v[2], v[1] * v[1] * k + c, v[2] * v[1] * k + v[0], 0,
    v[0] * v[2] * k + v[1], v[1] * v[2] * k - v[0], v[2] * v[2] * k + c, 0,
    0, 0, 0, 1,
  ];
}
// The axis a set of points spreads along least (a tyre's axle).
function thinnestAxis(pos, list) {
  let n = 0;
  const m = [0, 0, 0];
  for (const i of list) {
    m[0] += pos[i * 3];
    m[1] += pos[i * 3 + 1];
    m[2] += pos[i * 3 + 2];
    n++;
  }
  m.forEach((v, k) => (m[k] = v / n));
  const C = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const i of list) {
    const d = [pos[i * 3] - m[0], pos[i * 3 + 1] - m[1], pos[i * 3 + 2] - m[2]];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r * 3 + c] += d[r] * d[c];
  }
  // Power iteration on (trace * I - C) finds the smallest axis of C.
  const tr = C[0] + C[4] + C[8];
  let v = [1, 0, 0];
  for (let it = 0; it < 60; it++) {
    const w = [0, 1, 2].map((r) => tr * v[r] - (C[r * 3] * v[0] + C[r * 3 + 1] * v[1] + C[r * 3 + 2] * v[2]));
    const l = Math.hypot(...w) || 1;
    v = w.map((x) => x / l);
  }
  return v[0] < 0 ? v.map((x) => -x) : v;
}

// ---------- Reading a model ----------------------------------------------------------
// Every triangle list in the model, baked into one space (Y up), with what is
// needed later: positions, normals, uvs, its material and the names around it.
function readParts(doc) {
  const r = doc.getRoot();
  const mats = r.listMaterials();
  const parts = [];
  for (const scene of r.listScenes()) {
    scene.traverse((node) => {
      const mesh = node.getMesh();
      if (!mesh) return;
      const m = node.getWorldMatrix();
      const nm = normalMatrix(m);
      const mirrored = det3(m) < 0;
      for (const prim of mesh.listPrimitives()) {
        if (prim.getMode() !== 4) continue;
        const mat = prim.getMaterial();
        const pa = prim.getAttribute("POSITION");
        const count = pa.getCount();
        const pos = new Float32Array(count * 3);
        const el = [0, 0, 0];
        const e2 = [0, 0];
        for (let i = 0; i < count; i++) pos.set(pa.getElement(i, el), i * 3);
        for (let i = 0; i < count; i++) applyPoint(m, pos, i * 3);
        const na = prim.getAttribute("NORMAL");
        let nor = null;
        if (na) {
          nor = new Float32Array(count * 3);
          for (let i = 0; i < count; i++) nor.set(na.getElement(i, el), i * 3);
          for (let i = 0; i < count; i++) applyDir(nm, nor, i * 3);
        }
        const tc = mat?.getBaseColorTextureInfo()?.getTexCoord() ?? 0;
        const ua = prim.getAttribute(`TEXCOORD_${tc}`) ?? prim.getAttribute("TEXCOORD_0");
        let uv = null;
        if (ua) {
          uv = new Float32Array(count * 2);
          for (let i = 0; i < count; i++) uv.set(ua.getElement(i, e2), i * 2);
        }
        const ia = prim.getIndices();
        const idx = ia ? Uint32Array.from(ia.getArray()) : Uint32Array.from({ length: count }, (_, i) => i);
        if (mirrored) for (let t = 0; t < idx.length; t += 3) [idx[t + 1], idx[t + 2]] = [idx[t + 2], idx[t + 1]];
        const name = `${node.getName()}|${mesh.getName()}|${mat?.getName() ?? ""}|#${mats.indexOf(mat)}`;
        parts.push({ name, mat, pos, nor, uv, idx });
      }
    });
  }
  return parts;
}

// A material's look, simplified to what the game keeps: a colour, a picture,
// how shiny, and whether it is see-through.
const looks = new Map();
function lookOf(mat) {
  if (looks.has(mat)) return looks.get(mat);
  const l = {
    name: mat?.getName() ?? "",
    color: mat ? [...mat.getBaseColorFactor()] : [0.8, 0.8, 0.8, 1],
    metallic: mat?.getMetallicFactor() ?? 0,
    roughness: mat?.getRoughnessFactor() ?? 0.6,
    tex: mat?.getBaseColorTexture() ?? null,
    mr: mat?.getMetallicRoughnessTexture() ?? null,
    alphaMode: mat?.getAlphaMode() ?? "OPAQUE",
    cutoff: mat?.getAlphaCutoff() ?? 0.5,
    doubleSided: mat?.getDoubleSided() ?? false,
    transmission: mat?.getExtension("KHR_materials_transmission")?.getTransmissionFactor() ?? 0,
    // (A glow picture with a zero glow colour doesn't glow.)
    emissive: !!mat && Math.max(...mat.getEmissiveFactor()) > 0.05,
    glow: mat ? [...mat.getEmissiveFactor()] : [0, 0, 0],
    glowTex: mat?.getEmissiveTexture() ?? null,
  };
  if (l.glowTex && !/png|jpe?g|webp/.test(l.glowTex.getMimeType())) l.glowTex = null;
  // (A picture the encoder can't read, such as one already in KTX2, is left out.)
  if (l.tex && !/png|jpe?g|webp/.test(l.tex.getMimeType())) l.tex = null;
  if (l.mr && !/png|jpe?g|webp/.test(l.mr.getMimeType())) l.mr = null;
  looks.set(mat, l);
  return l;
}

// Small copies of pictures, for reading average colours.
const pixelCache = new Map();
async function pixels(tex) {
  if (!pixelCache.has(tex)) {
    const { data, info } = await sharp(Buffer.from(tex.getImage())).resize(256, 256, { fit: "fill" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    pixelCache.set(tex, { data, w: info.width, h: info.height });
  }
  return pixelCache.get(tex);
}
const texel = (p, u, v) => {
  const x = Math.min(p.w - 1, Math.floor((u - Math.floor(u)) * p.w));
  const y = Math.min(p.h - 1, Math.floor((v - Math.floor(v)) * p.h));
  const i = (y * p.w + x) * 4;
  return [p.data[i] / 255, p.data[i + 1] / 255, p.data[i + 2] / 255, p.data[i + 3] / 255];
};

// ---------- Geometry helpers ----------------------------------------------------------
function triArea(pos, a, b, c) {
  const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
  const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
}
function boundsOf(pos, idx) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const i of idx) for (let k = 0; k < 3; k++) {
    const v = pos[i * 3 + k];
    if (v < min[k]) min[k] = v;
    if (v > max[k]) max[k] = v;
  }
  return { min, max };
}
const partBounds = (parts) => {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    const b = boundsOf(p.pos, p.idx);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], b.min[k]);
      max[k] = Math.max(max[k], b.max[k]);
    }
  }
  return { min, max, size: max.map((v, k) => v - min[k]) };
};
function transformParts(parts, m) {
  const nm = normalMatrix(m);
  for (const p of parts) {
    for (let i = 0; i < p.pos.length; i += 3) applyPoint(m, p.pos, i);
    if (p.nor) for (let i = 0; i < p.nor.length; i += 3) applyDir(nm, p.nor, i);
  }
}

// Pieces of a part that hang together (share corners), as lists of triangles.
// Corners closer than half a millimetre count as the same.
function components(part, q = 2000) {
  const n = part.pos.length / 3;
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const join = (a, b) => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[a] = b;
  };
  const at = new Map();
  for (let i = 0; i < n; i++) {
    const k = `${Math.round(part.pos[i * 3] * q)},${Math.round(part.pos[i * 3 + 1] * q)},${Math.round(part.pos[i * 3 + 2] * q)}`;
    const j = at.get(k);
    if (j === undefined) at.set(k, i);
    else join(i, j);
  }
  for (let t = 0; t < part.idx.length; t += 3) {
    join(part.idx[t], part.idx[t + 1]);
    join(part.idx[t + 1], part.idx[t + 2]);
  }
  const groups = new Map();
  for (let t = 0; t < part.idx.length; t += 3) {
    const r = find(part.idx[t]);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(t / 3);
  }
  return [...groups.values()].map((tris) => {
    const verts = new Set();
    for (const t of tris) for (let k = 0; k < 3; k++) verts.add(part.idx[t * 3 + k]);
    const b = boundsOf(part.pos, verts);
    return { part, tris, verts: [...verts], min: b.min, max: b.max, size: b.max.map((v, k) => v - b.min[k]), centre: b.max.map((v, k) => (v + b.min[k]) / 2) };
  });
}

// Normals for models that come without: smooth across gentle bends, sharp at
// creases (more than about 45 degrees), so panels keep their edges.
function creaseNormals(part) {
  const { pos, idx } = part;
  const nt = idx.length / 3;
  const fn = new Float32Array(nt * 3);
  for (let t = 0; t < nt; t++) {
    const [a, b, c] = [idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]];
    const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
    fn[t * 3] = uy * vz - uz * vy;
    fn[t * 3 + 1] = uz * vx - ux * vz;
    fn[t * 3 + 2] = ux * vy - uy * vx;
  }
  const unit = (t) => {
    const l = Math.hypot(fn[t * 3], fn[t * 3 + 1], fn[t * 3 + 2]) || 1;
    return [fn[t * 3] / l, fn[t * 3 + 1] / l, fn[t * 3 + 2] / l];
  };
  const byPoint = new Map();
  for (let c = 0; c < idx.length; c++) {
    const i = idx[c];
    const k = `${Math.round(pos[i * 3] * 1e4)},${Math.round(pos[i * 3 + 1] * 1e4)},${Math.round(pos[i * 3 + 2] * 1e4)}`;
    if (!byPoint.has(k)) byPoint.set(k, []);
    byPoint.get(k).push(c);
  }
  // Every corner gets its own vertex (joined up again by weld()).
  const P = new Float32Array(idx.length * 3);
  const N = new Float32Array(idx.length * 3);
  const U = part.uv ? new Float32Array(idx.length * 2) : null;
  for (const corners of byPoint.values()) {
    for (const c of corners) {
      const t = Math.floor(c / 3);
      const own = unit(t);
      let nx = 0, ny = 0, nz = 0;
      for (const d of corners) {
        const s = Math.floor(d / 3);
        const o = unit(s);
        if (own[0] * o[0] + own[1] * o[1] + own[2] * o[2] < 0.7) continue;
        nx += fn[s * 3];
        ny += fn[s * 3 + 1];
        nz += fn[s * 3 + 2];
      }
      const l = Math.hypot(nx, ny, nz) || 1;
      const i = idx[c];
      P.set(pos.subarray(i * 3, i * 3 + 3), c * 3);
      N.set([nx / l, ny / l, nz / l], c * 3);
      if (U) U.set(part.uv.subarray(i * 2, i * 2 + 2), c * 2);
    }
  }
  part.pos = P;
  part.nor = N;
  part.uv = U;
  part.idx = Uint32Array.from({ length: idx.length }, (_, i) => i);
}

// ---------- Finding the wheels -----------------------------------------------------------
// Each tyre is the biggest round, upright, narrow piece on the ground at its
// corner. Everything that fits inside a tyre (rim, brake disc, nuts, badge)
// goes with it; brake calipers too, but they steer without spinning.
// The axle is squared up to the car (models are saved with the front wheels
// steered, or leaning in), so the wheel spins true.
function findWheels(allComps, size) {
  const round = allComps.filter((c) => {
    const h = c.size[1];
    if (h < 0.38 || h > 1.4 || Math.abs(c.size[2] - h) > 0.14 * h || c.size[0] > 0.85 * h) return false;
    if (c.min[1] > 0.25 || Math.abs(c.centre[0]) < 0.2 * size[0] || Math.abs(c.centre[2]) < 0.15 * size[2]) return false;
    // Round, not boxy: no corner sticks out past the circle.
    const r = h / 2;
    let far = 0;
    for (const i of c.verts) far = Math.max(far, Math.hypot(c.part.pos[i * 3 + 1] - c.centre[1], c.part.pos[i * 3 + 2] - c.centre[2]));
    return far < r * 1.15;
  });
  const corners = new Map();
  for (const c of round) {
    const k = `${Math.sign(c.centre[0])}${Math.sign(c.centre[2])}`;
    if (!corners.has(k) || c.size[1] > corners.get(k).size[1]) corners.set(k, c);
  }
  if (corners.size < 4) return null;
  return [...corners.values()];
}

function gatherWheel(tyre, comps, taken) {
  const P = tyre.part.pos;
  const centre = tyre.centre.slice();
  const axle = thinnestAxis(P, tyre.verts);
  const square = Math.abs(axle[0]) > 0.9999 ? null : mul(translate(...centre), mul(rotationBetween(axle, [1, 0, 0]), translate(-centre[0], -centre[1], -centre[2])));
  const turned = (c, i) => {
    const p = [c.part.pos[i * 3], c.part.pos[i * 3 + 1], c.part.pos[i * 3 + 2]];
    if (square) applyPoint(square, p, 0);
    return p;
  };
  // The tyre's own size once squared up.
  let x0 = Infinity, x1 = -Infinity, r = 0;
  for (const i of tyre.verts) {
    const p = turned(tyre, i);
    x0 = Math.min(x0, p[0]);
    x1 = Math.max(x1, p[0]);
    r = Math.max(r, Math.hypot(p[1] - centre[1], p[2] - centre[2]));
  }
  // (Brake parts may sit a little further in than the tyre, and the round piece
  // found may be just a rim face, with the tread around it in many pieces: the
  // tyre itself reaches down to the ground, the lowest thing under the wheel.)
  const inward = [x0 - 0.42, x1 + 0.42];
  let ground = Infinity;
  for (const c of comps) if (Math.abs(c.centre[2] - centre[2]) < r * 1.2 && Math.abs(c.centre[0] - centre[0]) < 0.4) ground = Math.min(ground, c.min[1]);
  const reach = Math.max(r * 1.12 + 0.01, Math.min((centre[1] - ground) * 1.1 + 0.01, r * 1.6));
  const members = [];
  for (const c of comps) {
    if (taken.has(c)) continue;
    if (Math.hypot(c.centre[0] - centre[0], c.centre[1] - centre[1], c.centre[2] - centre[2]) > reach * 1.2) continue;
    let inside = true;
    for (const i of c.verts) {
      const p = turned(c, i);
      if (p[0] < inward[0] || p[0] > inward[1] || Math.hypot(p[1] - centre[1], p[2] - centre[2]) > reach) {
        inside = false;
        break;
      }
    }
    if (inside) members.push(c);
  }
  return { tyre, centre, radius: r, square, members, axleTilt: Math.acos(Math.min(1, Math.abs(axle[0]))) * (180 / Math.PI) };
}

// ---------- Roles ------------------------------------------------------------------------
function roleOf(p, fix) {
  const look = lookOf(p.mat);
  const [node, mesh, matName] = p.name.split("|");
  const has = (key) => fix[key] && new RegExp(fix[key], "i").test(p.name);
  if (has("drop")) return "drop";
  for (const key of ["body", "lamp", "glass", "interior", "caliper"]) if (has(key)) return key;
  // Lamps are small: a node called "front bumper with fog lights" is mostly bumper.
  const small = (p.area ?? 0) < 0.5;
  const by = (text, lampOk) => {
    if (ROLE.lamp.test(text) && !ROLE.notLamp.test(text) && lampOk) return "lamp";
    if (ROLE.glass.test(text) && !ROLE.notGlass.test(text)) return "glass";
    if (ROLE.interior.test(text)) return "interior";
    if (ROLE.caliper.test(text)) return "caliper";
    return null;
  };
  // The material's own name first, then the names of the node and mesh.
  const role = by(matName, true) ?? by(`${node}|${mesh}`, small);
  if (role) return role;
  // Anything else clearly see-through is a window; a small glowing part is a lamp.
  if (look.transmission > 0.3 || (look.alphaMode === "BLEND" && look.color[3] < 0.6 && !look.tex)) return "glass";
  if (look.emissive && small && glowIsRare) return "lamp";
  return "body";
}
// (Some models mark most materials as glowing; then it says nothing about lamps.)
let glowIsRare = true;
const isLens = (look, name) => look.transmission > 0.2 || (look.alphaMode === "BLEND" && look.color[3] < 0.95) || /glass|lens|clear/i.test(name);

// ---------- The palette: plain colours as one small picture -----------------------------
// Parts without a picture of their own (and small pictured ones) all share one
// material per kind, coloured from a tiny picture with a square per colour. That
// keeps a car to a handful of draws however many materials the model had.
class Palette {
  constructor() {
    this.cells = new Map();
  }
  // Linear colour + alpha, metallic, roughness -> cell number.
  add(c, metallic, roughness) {
    const s = [linearToSrgb(clamp01(c[0])), linearToSrgb(clamp01(c[1])), linearToSrgb(clamp01(c[2])), clamp01(c[3])].map((v) => Math.round(v * 255));
    const key = [...s, Math.round(clamp01(metallic) * 255), Math.round(clamp01(roughness) * 255)].join(",");
    if (!this.cells.has(key)) this.cells.set(key, this.cells.size);
    return this.cells.get(key);
  }
  get side() {
    const n = Math.ceil(Math.sqrt(Math.max(1, this.cells.size)));
    return Math.max(16, 2 ** Math.ceil(Math.log2(n * 4)));
  }
  uv(cell) {
    const per = this.side / 4;
    return [((cell % per) * 4 + 2) / this.side, (Math.floor(cell / per) * 4 + 2) / this.side];
  }
  async images() {
    const s = this.side;
    const col = Buffer.alloc(s * s * 4);
    const mr = Buffer.alloc(s * s * 4);
    const per = s / 4;
    for (const [key, cell] of this.cells) {
      const [r, g, b, a, m, ro] = key.split(",").map(Number);
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
        const i = (((Math.floor(cell / per) * 4 + y) * s) + (cell % per) * 4 + x) * 4;
        col.set([r, g, b, a], i);
        mr.set([0, ro, m, 255], i);
      }
    }
    const png = (buf) => sharp(buf, { raw: { width: s, height: s, channels: 4 } }).png().toBuffer();
    return { color: await png(col), mr: await png(mr) };
  }
  colourOf(cell) {
    for (const [key, c] of this.cells) if (c === cell) return key.split(",").map(Number);
    return [128, 128, 128, 255];
  }
}

// ---------- Welding and simplifying ---------------------------------------------------------
// Joins corners that are the same in every way, so the simplifier sees one surface.
function weld(prim) {
  const { pos, nor, uv, idx } = prim;
  const map = new Map();
  const remap = new Uint32Array(pos.length / 3);
  const P = [], N = [], U = [];
  for (let i = 0; i < pos.length / 3; i++) {
    const k = `${Math.round(pos[i * 3] * 1e4)},${Math.round(pos[i * 3 + 1] * 1e4)},${Math.round(pos[i * 3 + 2] * 1e4)},${Math.round(nor[i * 3] * 500)},${Math.round(nor[i * 3 + 1] * 500)},${Math.round(nor[i * 3 + 2] * 500)},${uv ? `${Math.round(uv[i * 2] * 1e4)},${Math.round(uv[i * 2 + 1] * 1e4)}` : ""}`;
    let j = map.get(k);
    if (j === undefined) {
      j = map.size;
      map.set(k, j);
      P.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      N.push(nor[i * 3], nor[i * 3 + 1], nor[i * 3 + 2]);
      if (uv) U.push(uv[i * 2], uv[i * 2 + 1]);
    }
    remap[i] = j;
  }
  const I = [];
  for (let t = 0; t < idx.length; t += 3) {
    const a = remap[idx[t]], b = remap[idx[t + 1]], c = remap[idx[t + 2]];
    if (a !== b && b !== c && a !== c) I.push(a, b, c);
  }
  return { ...prim, pos: new Float32Array(P), nor: new Float32Array(N), uv: uv ? new Float32Array(U) : null, idx: new Uint32Array(I) };
}

// Keeps only the corners still used.
function compact(prim, idx) {
  const remap = new Map();
  const I = new Uint32Array(idx.length);
  for (let t = 0; t < idx.length; t++) {
    let j = remap.get(idx[t]);
    if (j === undefined) remap.set(idx[t], (j = remap.size));
    I[t] = j;
  }
  const n = remap.size;
  const P = new Float32Array(n * 3), N = new Float32Array(n * 3), U = prim.uv ? new Float32Array(n * 2) : null;
  for (const [o, j] of remap) {
    P.set(prim.pos.subarray(o * 3, o * 3 + 3), j * 3);
    N.set(prim.nor.subarray(o * 3, o * 3 + 3), j * 3);
    if (U) U.set(prim.uv.subarray(o * 2, o * 2 + 2), j * 2);
  }
  return { ...prim, pos: P, nor: N, uv: U, idx: I };
}

// Simplifies a group of primitives together: the same allowed change in shape
// (in metres) for all, raised step by step until the group fits its budget.
// (Corners are joined whatever their normals first, or a model with hard edges
// everywhere couldn't be simplified at all; normals are worked out afresh after.)
function simplifyGroup(welded, budget) {
  const count = (list) => list.reduce((s, p) => s + p.idx.length / 3, 0);
  if (count(welded) <= budget) return welded;
  const prims = welded.map((p) => weld({ ...p, nor: new Float32Array(p.pos.length) }));
  const done = (list) =>
    list.map((p) => {
      const part = { ...p };
      creaseNormals(part);
      return weld(part);
    });
  let best = prims;
  for (const error of [0.0005, 0.001, 0.002, 0.004, 0.007, 0.012, 0.02, 0.035, 0.06]) {
    best = prims.map((p) => {
      const [idx] = MeshoptSimplifier.simplify(p.idx, p.pos, 3, 0, error, ["ErrorAbsolute", "Prune"]);
      return compact(p, idx);
    });
    if (count(best) <= budget) return done(best);
  }
  // Still too many: cut each to its share, whatever the change in shape.
  const ratio = budget / count(best);
  return done(
    best.map((p) => {
      const target = Math.min(p.idx.length, Math.max(3, Math.floor((p.idx.length * ratio) / 3) * 3));
      const [idx] = MeshoptSimplifier.simplify(p.idx, p.pos, 3, target, 1, ["ErrorAbsolute", "Prune"]);
      return compact(p, idx);
    }),
  );
}

// ---------- Tail lamps ---------------------------------------------------------------------
// The brake lights glow over the red, rear-facing lamp triangles at the back
// (same shape of answer as findTailLamps in src/car/carFx.js, worked out here
// once so the game doesn't have to).
function tailLamps(tris) {
  if (!tris.length) return [];
  const cell = 0.12;
  const key = (t) => t.c.map((v) => Math.floor(v / cell)).join(",");
  const cells = new Map();
  for (const t of tris) {
    const k = key(t);
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(t);
  }
  // Neighbouring cells with lamp in them are one lamp.
  const parent = new Map([...cells.keys()].map((k) => [k, k]));
  const find = (k) => (parent.get(k) === k ? k : (parent.set(k, find(parent.get(k))), parent.get(k)));
  for (const k of cells.keys()) {
    const [x, y, z] = k.split(",").map(Number);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const n = `${x + dx},${y + dy},${z + dz}`;
      if (cells.has(n)) parent.set(find(k), find(n));
    }
  }
  const groups = new Map();
  const box = () => ({ x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, z0: Infinity });
  const wide = new Map();
  for (const [k, list] of cells) {
    const g = find(k);
    const w = wide.get(g) ?? [Infinity, -Infinity];
    for (const t of list) for (const v of t.v) {
      w[0] = Math.min(w[0], v[0]);
      w[1] = Math.max(w[1], v[0]);
    }
    wide.set(g, w);
  }
  for (const [k, list] of cells) {
    // A light bar right across the back glows as a lamp each side.
    const g0 = find(k);
    const [wa, wb] = wide.get(g0);
    for (const t of list) {
      const g = wb - wa > 1.0 ? `${g0}${t.c[0] < 0 ? "-" : "+"}` : g0;
      if (!groups.has(g)) groups.set(g, box());
      const b = groups.get(g);
      for (const v of t.v) {
        b.x0 = Math.min(b.x0, v[0]);
        b.x1 = Math.max(b.x1, v[0]);
        b.y0 = Math.min(b.y0, v[1]);
        b.y1 = Math.max(b.y1, v[1]);
        b.z0 = Math.min(b.z0, v[2]);
      }
    }
  }
  return [...groups.values()]
    .map((g) => ({ x: (g.x0 + g.x1) / 2, y: (g.y0 + g.y1) / 2, z: g.z0 - 0.015, w: Math.max(0.08, g.x1 - g.x0) * 1.25 + 0.1, h: Math.max(0.06, g.y1 - g.y0) * 1.25 + 0.1, area: (g.x1 - g.x0) * (g.y1 - g.y0) }))
    .filter((l) => l.w < 1.4 && l.h < 1.0 && l.area > 0.0004)
    .sort((a, b) => b.area - a.area)
    .slice(0, 4)
    .map(({ x, y, z, w, h }) => ({ x: +x.toFixed(3), y: +y.toFixed(3), z: +z.toFixed(3), w: +w.toFixed(3), h: +h.toFixed(3) }));
}

// ---------- One car ----------------------------------------------------------------------------
async function prepare(car) {
  const notes = [];
  const file = path.join(srcDir, car.file);
  const doc = await io.read(file);
  const used = doc.getRoot().listExtensionsUsed().map((e) => e.extensionName);
  if (used.includes("KHR_draco_mesh_compression")) throw new Error(`${car.id}: the model is Draco-compressed, which this script can't read. Download the plain glTF version instead.`);
  if (used.includes("KHR_materials_pbrSpecularGlossiness")) await doc.transform(metalRough());
  looks.clear();
  let parts = readParts(doc);
  const mats = doc.getRoot().listMaterials();
  glowIsRare = mats.filter((m) => lookOf(m).emissive).length <= 0.25 * mats.length;
  const trisBefore = parts.reduce((s, p) => s + p.idx.length / 3, 0);
  const fix = car.parts ?? {};

  // 1. Leave out what isn't the car: named drops, things outside `keep`, and
  // ground or shadow sheets (flat, few triangles, at the very bottom).
  parts = parts.filter((p) => !(fix.drop && new RegExp(fix.drop, "i").test(p.name)));
  if (car.keep) {
    parts = parts.filter((p) => {
      const b = boundsOf(p.pos, p.idx);
      return ["x", "y", "z"].every((a, k) => !car.keep[a] || ((b.min[k] + b.max[k]) / 2 >= car.keep[a][0] && (b.min[k] + b.max[k]) / 2 <= car.keep[a][1]));
    });
  }
  const all = partBounds(parts);
  const flat = (p) => {
    const b = boundsOf(p.pos, p.idx);
    const s = b.max.map((v, k) => v - b.min[k]);
    return p.idx.length / 3 <= 200 && s[1] < 0.004 * Math.max(all.size[0], all.size[2]) && b.min[1] < all.min[1] + 0.03 * all.size[1] && Math.max(s[0], s[2]) > 0.3 * Math.max(all.size[0], all.size[2]);
  };
  const sheets = parts.filter(flat);
  if (sheets.length) notes.push(`dropped ${sheets.length} ground sheet(s): ${sheets.map((p) => p.name.split("|").filter(Boolean)[0]).join(", ")}`);
  parts = parts.filter((p) => !flat(p));
  // (A model saved as one mesh can have its ground sheet inside it: the same
  // test on each separate piece of a part.)
  {
    const span = Math.max(all.size[0], all.size[2]);
    let n = 0;
    for (const p of parts) {
      const comps = components(p, 1e5 / span);
      const keep = comps.filter((c) => !(c.tris.length <= 200 && c.size[1] < 0.004 * span && c.min[1] < all.min[1] + 0.03 * all.size[1] && Math.max(c.size[0], c.size[2]) > 0.3 * span));
      if (keep.length === comps.length) continue;
      n += comps.length - keep.length;
      p.idx = Uint32Array.from(keep.flatMap((c) => c.tris.flatMap((t) => [p.idx[t * 3], p.idx[t * 3 + 1], p.idx[t * 3 + 2]])));
    }
    if (n) notes.push(`dropped ${n} ground sheet piece(s)`);
  }
  for (const p of parts) if (!p.nor) creaseNormals(p);

  // 2. Turn the length along Z (the way the points spread most), nose to +Z,
  // in metres, standing on y = 0.
  {
    let xx = 0, xz = 0, zz = 0, n = 0, cx = 0, cz = 0;
    for (const p of parts) for (let i = 0; i < p.pos.length; i += 9) {
      cx += p.pos[i];
      cz += p.pos[i + 2];
      n++;
    }
    cx /= n;
    cz /= n;
    for (const p of parts) for (let i = 0; i < p.pos.length; i += 9) {
      const dx = p.pos[i] - cx, dz = p.pos[i + 2] - cz;
      xx += dx * dx;
      xz += dx * dz;
      zz += dz * dz;
    }
    const along = 0.5 * Math.atan2(2 * xz, xx - zz); // the length's angle from +X
    // Of the two ways to line the length up with Z, the smaller turn (so
    // `flip` means the same thing however the points happen to spread).
    let turn = along - Math.PI / 2;
    if (turn < -Math.PI / 2) turn += Math.PI;
    // Snap to a quarter turn when nearly square: most models are.
    const q = Math.round(turn / (Math.PI / 2)) * (Math.PI / 2);
    if (Math.abs(turn - q) < 0.035) turn = q;
    transformParts(parts, rotY(turn + ((car.yaw ?? 0) * Math.PI) / 180));
    const b = partBounds(parts);
    const s = car.length / b.size[2];
    transformParts(parts, mul(scaling(s), translate(-(b.min[0] + b.max[0]) / 2, -b.min[1], -(b.min[2] + b.max[2]) / 2)));
  }

  // A tall aerial joined to the roof (so not dropped as a piece of its own)
  // would make the car count as taller: `maxHeight` in cars.json cuts away
  // every triangle reaching above that many metres.
  if (car.maxHeight) {
    let n = 0;
    for (const p of parts) {
      const keep = [];
      for (let t = 0; t < p.idx.length; t += 3) {
        if ([0, 1, 2].some((k) => p.pos[p.idx[t + k] * 3 + 1] > car.maxHeight)) n++;
        else keep.push(p.idx[t], p.idx[t + 1], p.idx[t + 2]);
      }
      p.idx = Uint32Array.from(keep);
    }
    parts = parts.filter((p) => p.idx.length);
    notes.push(`cut ${n} triangles above ${car.maxHeight} m`);
  }

  // 3. The wheels.
  const compsByPart = new Map(parts.map((p) => [p, components(p)]));
  // (A thin aerial on the roof would make the car count as much taller than it is.)
  {
    const h = partBounds(parts).size[1];
    let n = 0;
    for (const [p, comps] of compsByPart) {
      const keep = comps.filter((c) => !(c.size[0] < 0.05 && c.size[2] < 0.08 && c.size[1] > 0.12 && c.min[1] > 0.6 * h));
      if (keep.length === comps.length) continue;
      n += comps.length - keep.length;
      compsByPart.set(p, keep);
      const tris = keep.flatMap((c) => c.tris);
      p.idx = Uint32Array.from(tris.flatMap((t) => [p.idx[t * 3], p.idx[t * 3 + 1], p.idx[t * 3 + 2]]));
      compsByPart.set(p, components(p));
    }
    if (n) notes.push(`dropped ${n} aerial(s)`);
  }
  const allComps = [...compsByPart.values()].flat();
  const size = partBounds(parts).size;
  const tyres = findWheels(allComps, size);
  const taken = new Set();
  let wheels = [];
  if (tyres) {
    for (const t of tyres) {
      const w = gatherWheel(t, allComps, taken);
      for (const c of w.members) taken.add(c);
      wheels.push(w);
    }
    // Straighten each wheel (only its own corners: a corner is in one piece).
    for (const w of wheels) {
      if (!w.square) continue;
      const nmx = normalMatrix(w.square);
      for (const c of w.members) for (const i of c.verts) {
        applyPoint(w.square, c.part.pos, i * 3);
        applyDir(nmx, c.part.nor, i * 3);
      }
    }
  } else notes.push("WHEELS NOT FOUND: they stay part of the body (they won't turn)");

  // 4. Level it from the wheel centres, stand it on the tyres, and centre it
  // between the wheels. Then decide which end is the front.
  if (wheels.length) {
    const centreOf = (w) => {
      const b = boundsOf(w.tyre.part.pos, w.tyre.verts);
      return b.max.map((v, k) => (v + b.min[k]) / 2);
    };
    const front = wheels.filter((w) => centreOf(w)[2] > 0);
    const rear = wheels.filter((w) => centreOf(w)[2] <= 0);
    const mid = (list) => [0, 1, 2].map((k) => list.reduce((s, w) => s + centreOf(w)[k], 0) / list.length);
    const f = mid(front), r = mid(rear);
    const yaw = Math.atan2(f[0] - r[0], f[2] - r[2]);
    if (Math.abs(yaw) > 0.002) transformParts(parts, rotY(-yaw));
    const ground = Math.min(...wheels.flatMap((w) => w.members.map((c) => boundsOf(c.part.pos, c.verts).min[1])));
    const c = mid(wheels);
    transformParts(parts, translate(-c[0], -ground, -c[2]));
  }

  // Roles, and where the red lamps are (for the front/back guess). Red or
  // orange "glass" is a lamp's lens.
  for (const p of parts) {
    p.area = 0;
    for (let t = 0; t < p.idx.length; t += 3) p.area += triArea(p.pos, p.idx[t], p.idx[t + 1], p.idx[t + 2]);
  }
  // (Per material: a lamp material's parts are small all together.)
  const matArea = new Map();
  for (const p of parts) matArea.set(p.mat, (matArea.get(p.mat) ?? 0) + p.area);
  for (const p of parts) {
    p.role = roleOf({ ...p, area: Math.max(p.area, matArea.get(p.mat) * (lookOf(p.mat).emissive ? 1 : 0)) }, fix);
    const c = lookOf(p.mat).color.slice(0, 3).map(linearToSrgb);
    if (p.role === "glass" && !(fix.glass && new RegExp(fix.glass, "i").test(p.name)) && c[0] > 0.25 && c[0] > c[2] * 2 && c[0] > c[1] * 1.3) p.role = "lamp";
  }
  const wheelOf = new Map();
  wheels.forEach((w, i) => w.members.forEach((c) => wheelOf.set(c, i)));
  const redLamp = async (p, look, t) => {
    let c = look.color;
    if (look.tex && p.uv) {
      const px = await pixels(look.tex);
      const [a, b, d] = [p.idx[t * 3], p.idx[t * 3 + 1], p.idx[t * 3 + 2]];
      const s = texel(px, (p.uv[a * 2] + p.uv[b * 2] + p.uv[d * 2]) / 3, (p.uv[a * 2 + 1] + p.uv[b * 2 + 1] + p.uv[d * 2 + 1]) / 3);
      c = [c[0] * srgbToLinear(s[0]), c[1] * srgbToLinear(s[1]), c[2] * srgbToLinear(s[2])];
    }
    const [r, g, b] = c.slice(0, 3).map(linearToSrgb);
    return (r > 0.2 && r > g * 1.7 && r > b * 1.7) || (fix.tail ? new RegExp(fix.tail, "i").test(p.name) : false);
  };
  let flip = car.flip;
  {
    let ahead = 0, behind = 0;
    for (const p of parts) {
      if (p.role !== "lamp") continue;
      const look = lookOf(p.mat);
      for (let t = 0; t < p.idx.length / 3; t += 2) {
        if (!(await redLamp(p, look, t))) continue;
        const z = p.pos[p.idx[t * 3] * 3 + 2];
        if (z > 0) ahead++;
        else behind++;
      }
    }
    const guess = ahead > behind * 2 ? true : behind > ahead * 2 ? false : null;
    if (flip === undefined) {
      flip = guess ?? false;
      notes.push(`flip guessed from the red lamps: ${flip}${guess === null ? " (unsure: check it)" : ""}`);
    } else if (guess !== null && guess !== flip) notes.push(`CHECK FLIP: set to ${flip}, but the red lamps say ${guess}`);
  }
  if (flip) transformParts(parts, rotY(Math.PI));
  // Colours set in cars.json (a model saved with a placeholder paint, say).
  for (const [re, hex] of Object.entries(car.colours ?? {})) {
    const rgb = [1, 3, 5].map((i) => srgbToLinear(parseInt(hex.slice(i, i + 2), 16) / 255));
    for (const p of parts) if (new RegExp(re, "i").test(p.name)) p.colour = [...rgb, 1];
  }
  if (PARTS) {
    console.log(`  ${car.id} parts (role, triangles, centre, size, colour, picture, name):`);
    for (const p of parts) {
      const b = boundsOf(p.pos, p.idx);
      const look = lookOf(p.mat);
      const f = (v) => v.map((x) => x.toFixed(2)).join(",");
      console.log(`  ${p.role.padEnd(8)} ${String(p.idx.length / 3).padStart(6)}  c=${f(b.min.map((v, k) => (v + b.max[k]) / 2))}  s=${f(b.max.map((v, k) => v - b.min[k]))}  rgb=${look.color.slice(0, 3).map((v) => Math.round(linearToSrgb(v) * 255)).join(",")}${look.emissive ? " glow" : ""}  ${look.tex ? (look.tex.getSize() ?? []).join("x") : "-"}  ${p.name}`);
    }
  }

  // 5. Pieces, each with its group (body, interior, wheel_N, caliper_N) and role.
  const pieces = [];
  for (const [p, comps] of compsByPart) {
    const rest = [];
    for (const c of comps) {
      const w = wheelOf.get(c);
      if (w === undefined) rest.push(...c.tris);
      else pieces.push({ part: p, tris: c.tris, role: p.role === "caliper" ? "caliper" : "wheel", wheel: w });
    }
    if (rest.length) pieces.push({ part: p, tris: rest, role: p.role === "caliper" ? "body" : p.role });
  }
  // Wheel numbers in a fixed order: front left, front right, rear left, rear right.
  if (wheels.length) {
    const cz = wheels.map((w, i) => ({ i, c: boundsOf(w.tyre.part.pos, w.tyre.verts) }));
    // (In the file +X is the car's left: the game mirrors X when it loads a glTF.)
    const order = cz.map((o) => ({ i: o.i, z: (o.c.min[2] + o.c.max[2]) / 2, x: (o.c.min[0] + o.c.max[0]) / 2 })).sort((a, b) => (b.z > 0 === a.z > 0 ? b.x - a.x : b.z - a.z));
    const renumber = new Map(order.map((o, k) => [o.i, k]));
    for (const pc of pieces) if (pc.wheel !== undefined) pc.wheel = renumber.get(pc.wheel);
  }

  // 6. Measure against the real car.
  const finalBounds = partBounds(parts);
  const sizeM = finalBounds.size.map((v) => +v.toFixed(2));
  const wheelInfo = wheels.map((w) => boundsOf(w.tyre.part.pos, w.tyre.verts)).map((b) => ({ z: (b.min[2] + b.max[2]) / 2, x: (b.min[0] + b.max[0]) / 2, r: (b.max[1] - b.min[1]) / 2 }));
  const wheelbase = wheelInfo.length ? Math.max(...wheelInfo.map((w) => w.z)) - Math.min(...wheelInfo.map((w) => w.z)) : null;
  if (car.wheelbase && wheelbase && Math.abs(wheelbase / car.wheelbase - 1) > 0.05) notes.push(`CHECK SIZE: wheelbase ${wheelbase.toFixed(2)} m, real ${car.wheelbase} m`);
  if (car.width && Math.abs(sizeM[0] / car.width - 1) > 0.15) notes.push(`CHECK SIZE: width ${sizeM[0]} m with mirrors, real ${car.width} m without`);
  if (sizeM[1] > 2.4) notes.push(`CHECK SIZE: ${sizeM[1]} m tall`);
  if (wheels.some((w) => w.axleTilt > 1)) {
    const at = (w) => {
      const b = boundsOf(w.tyre.part.pos, w.tyre.verts);
      return `${b.max[2] > 0 ? "front" : "rear"} ${b.max[0] > 0 ? "left" : "right"} ${w.axleTilt.toFixed(1)}`;
    };
    notes.push(`wheels squared up (degrees): ${wheels.map(at).join(", ")}`);
  }

  const full = await build(car, pieces, FULL, notes, "full", finalBounds.min[2]);
  const lod = await build(car, pieces, LOD, notes, "lod", finalBounds.min[2]);
  await io.write(path.join(outDir, `${car.id}.glb`), full.doc);
  await io.write(path.join(outDir, `${car.id}_lod.glb`), lod.doc);
  if (PREVIEW) await preview(car, full, sizeM, notes);
  return {
    manifest: {
      id: car.id,
      name: `${car.brand} ${car.model}`,
      pack: "cars",
      wheels: wheels.length,
      size: sizeM,
      min: finalBounds.min.map((v) => +v.toFixed(2)),
      max: finalBounds.max.map((v) => +v.toFixed(2)),
      tris: full.tris,
      lodTris: lod.tris,
      trisBefore,
      textureMB: +full.textureMB.toFixed(1),
      lodTextureMB: +lod.textureMB.toFixed(1),
      tailLamps: full.lamps.length,
      flip,
      wheelbase: wheelbase && +wheelbase.toFixed(2),
      wheelRadius: wheelInfo.length ? +(wheelInfo.reduce((s, w) => s + w.r, 0) / wheelInfo.length).toFixed(3) : null,
    },
    notes,
  };
}

// Builds one game file from the pieces, within a budget (FULL or LOD).
async function build(car, pieces, B, notes, which, rearZ) {
  // Which pictures are worth keeping: big enough on the car, and not nearly
  // one colour. The rest become palette colours. The wheels keep just their
  // main picture (and cut-out spokes), so each wheel is two or three draws;
  // brake calipers are plain colours.
  const onWheel = (pc) => pc.role === "wheel" || pc.role === "caliper";
  // How much of the body (or of the wheels) each picture covers: square metres and triangles.
  const coverOf = (wheel) => {
    const cover = new Map();
    for (const pc of pieces) {
      const look = lookOf(pc.part.mat);
      if (!look.tex || !pc.part.uv || pc.role === "interior" || pc.role === "glass" || pc.role === "caliper" || onWheel(pc) !== wheel) continue;
      const c = cover.get(look.tex) ?? { area: 0, tris: 0 };
      for (const t of pc.tris) c.area += triArea(pc.part.pos, pc.part.idx[t * 3], pc.part.idx[t * 3 + 1], pc.part.idx[t * 3 + 2]);
      c.tris += pc.tris.length;
      cover.set(look.tex, c);
    }
    return cover;
  };
  const bodyCover = coverOf(false);
  const wheelCover = coverOf(true);
  const varied = new Map();
  for (const tex of new Set([...bodyCover.keys(), ...wheelCover.keys()])) {
    const px = await pixels(tex);
    let s = 0, s2 = 0;
    for (let i = 0; i < px.data.length; i += 16) {
      const v = (px.data[i] + px.data[i + 1] + px.data[i + 2]) / 765;
      s += v;
      s2 += v * v;
    }
    const n = px.data.length / 16;
    varied.set(tex, Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)) > 0.03);
  }
  const cutOut = (tex) => [...looks.values()].some((l) => l.tex === tex && l.alphaMode === "MASK");
  // (A picture on a few small triangles, a badge say, isn't worth a draw of its own.)
  const pick = (cover, minArea, most) => {
    const list = [...cover].filter(([tex, c]) => varied.get(tex) && c.area >= minArea && c.tris >= 40 && !cutOut(tex)).sort((a, b) => b[1].area - a[1].area).slice(0, most).map(([tex]) => tex);
    // Cut-out pictures (grilles, spokes) would turn solid as a plain colour.
    for (const [tex, c] of cover) if (cutOut(tex) && c.area >= 0.04 && c.tris >= 8 && most > 0) list.push(tex);
    return list;
  };
  const keptBody = pick(bodyCover, B.keepArea, B.keepTextures);
  const keptWheel = pick(wheelCover, 0.02, B.wheelTextures);
  const kept = [...new Set([...keptBody, ...keptWheel])];
  const area = new Map(kept.map((t) => [t, (bodyCover.get(t)?.area ?? 0) + (wheelCover.get(t)?.area ?? 0)]));

  // Each piece's material in the game file.
  const palette = new Palette();
  const prims = new Map(); // `${group}|${material}` -> list of piece copies
  const lampTris = [];
  for (const pc of pieces) {
    const { part } = pc;
    const look = lookOf(part.mat);
    const group = pc.role === "interior" ? "interior" : pc.role === "wheel" ? `wheel_${pc.wheel}` : pc.role === "caliper" && pc.wheel !== undefined ? (which === "lod" ? `wheel_${pc.wheel}` : `caliper_${pc.wheel}`) : "body";
    let material;
    let cellOf = null;
    const textured = look.tex && part.uv && (pc.role === "wheel" ? keptWheel : keptBody).includes(look.tex) && pc.role !== "interior" && pc.role !== "glass" && pc.role !== "caliper" && !part.colour;
    if (pc.role === "glass") material = "glass";
    else if (textured) material = `${pc.role === "lamp" ? "optic_" : ""}tex${kept.indexOf(look.tex)}_${look.alphaMode}_${look.doubleSided ? 2 : 1}`;
    else {
      // A see-through layer over the body (dirt, a sticker sheet) can't become
      // a plain colour: it would cover the paint. It is left out.
      if (look.alphaMode === "BLEND" && pc.role !== "lamp" && pc.role !== "interior" && look.color[3] < 0.5) continue;
      material = pc.role === "interior" ? "interior" : pc.role === "lamp" ? (isLens(look, part.name) ? "optic_glass" : "optic") : "paint";
      // The piece's colour: its own, times its picture's average where it is used.
      let col = (part.colour ?? look.color).slice();
      let metallic = look.metallic;
      let roughness = look.roughness;
      if (look.tex && part.uv && !part.colour) {
        const px = await pixels(look.tex);
        const acc = [0, 0, 0, 0];
        let w = 0;
        for (const t of pc.tris) {
          const [a, b, c] = [part.idx[t * 3], part.idx[t * 3 + 1], part.idx[t * 3 + 2]];
          const s = texel(px, (part.uv[a * 2] + part.uv[b * 2] + part.uv[c * 2]) / 3, (part.uv[a * 2 + 1] + part.uv[b * 2 + 1] + part.uv[c * 2 + 1]) / 3);
          const ar = triArea(part.pos, a, b, c) + 1e-9;
          acc[0] += srgbToLinear(s[0]) * ar;
          acc[1] += srgbToLinear(s[1]) * ar;
          acc[2] += srgbToLinear(s[2]) * ar;
          acc[3] += s[3] * ar;
          w += ar;
        }
        col = [col[0] * acc[0] / w, col[1] * acc[1] / w, col[2] * acc[2] / w, col[3] * acc[3] / w];
      }
      if (look.mr && part.uv) {
        const px = await pixels(look.mr);
        let m = 0, r = 0, n = 0;
        for (const t of pc.tris.slice(0, 2000)) {
          const a = part.idx[t * 3];
          const s = texel(px, part.uv[a * 2], part.uv[a * 2 + 1]);
          m += s[2];
          r += s[1];
          n++;
        }
        metallic *= m / n;
        roughness *= r / n;
      }
      if (material === "optic_glass") col[3] = Math.min(0.75, Math.max(0.35, col[3]));
      else col[3] = 1;
      cellOf = palette.add(col, metallic, roughness);
      pc.colour = col;
    }
    pc.material = material;
    const key = `${group}|${material}`;
    if (!prims.has(key)) prims.set(key, []);
    prims.get(key).push({ pc, cellOf, look });
    // Lamp triangles for the brake lights (`tail` in cars.json adds parts that
    // aren't lamps, such as a body picture with the lamps painted on; `brake`
    // names parts that are brake lamps whatever their colour).
    const named = (key) => car.parts?.[key] && new RegExp(car.parts[key], "i").test(part.name) && pc.role !== "wheel" && pc.role !== "glass";
    if (pc.role === "lamp" || named("tail") || named("brake")) {
      for (const t of pc.tris) {
        const [a, b, c] = [part.idx[t * 3], part.idx[t * 3 + 1], part.idx[t * 3 + 2]];
        const v = [a, b, c].map((i) => [part.pos[i * 3], part.pos[i * 3 + 1], part.pos[i * 3 + 2]]);
        const nz = (part.nor[a * 3 + 2] + part.nor[b * 3 + 2] + part.nor[c * 3 + 2]) / 3;
        const cz = (v[0][2] + v[1][2] + v[2][2]) / 3;
        // (Either way round: lamp lenses are often modelled facing inwards. Thin
        // lamp strips right at the back count whichever way they face.)
        if ((Math.abs(nz) < 0.5 && cz > rearZ + 0.35) || cz > 0) continue;
        const isRed = (c) => c[0] > 0.2 && c[0] > c[1] * 1.7 && c[0] > c[2] * 1.7;
        const centre = part.uv ? [(part.uv[a * 2] + part.uv[b * 2] + part.uv[c * 2]) / 3, (part.uv[a * 2 + 1] + part.uv[b * 2 + 1] + part.uv[c * 2 + 1]) / 3] : null;
        // (A lamp that glows red, whatever colour it is by day; with a glow
        // picture, only where that picture is red.)
        let red = isRed(look.glow) && !look.glowTex;
        if (look.emissive && look.glowTex && centre) red = isRed(texel(await pixels(look.glowTex), ...centre).map((v, k) => v * (look.glow[k] ?? 1)));
        else if (red) {
          // found
        } else if (cellOf !== null) {
          const [r, g, bl] = palette.colourOf(cellOf);
          red = r > 50 && r > g * 1.7 && r > bl * 1.7;
        } else if (look.tex && part.uv) {
          const px = await pixels(look.tex);
          const s = texel(px, (part.uv[a * 2] + part.uv[b * 2] + part.uv[c * 2]) / 3, (part.uv[a * 2 + 1] + part.uv[b * 2 + 1] + part.uv[c * 2 + 1]) / 3);
          red = s[0] > 0.2 && s[0] > s[1] * 1.7 && s[0] > s[2] * 1.7;
        }
        if (red || named("brake")) lampTris.push({ v, c: [(v[0][0] + v[1][0] + v[2][0]) / 3, (v[0][1] + v[1][1] + v[2][1]) / 3, cz] });
      }
    }
  }
  const lamps = tailLamps(lampTris);
  if (which === "full" && !lamps.length) notes.push("NO TAIL LAMPS FOUND: no brake light glow");

  // Merge each group's pieces per material, weld, and simplify to the budget.
  const groups = new Map();
  for (const [key, list] of prims) {
    const [group, material] = key.split("|");
    let n = 0;
    for (const { pc } of list) n += pc.tris.length * 3;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
    const uv = new Float32Array(n * 2);
    let o = 0;
    for (const { pc, cellOf } of list) {
      const { part } = pc;
      const cuv = cellOf !== null ? palette.uv(cellOf) : null;
      for (const t of pc.tris) for (let k = 0; k < 3; k++) {
        const i = part.idx[t * 3 + k];
        pos.set(part.pos.subarray(i * 3, i * 3 + 3), o * 3);
        nor.set(part.nor.subarray(i * 3, i * 3 + 3), o * 3);
        if (cuv) uv.set(cuv, o * 2);
        else if (part.uv) uv.set(part.uv.subarray(i * 2, i * 2 + 2), o * 2);
        o++;
      }
    }
    const prim = weld({ material, pos, nor, uv: material === "glass" ? null : uv, idx: Uint32Array.from({ length: n }, (_, i) => i), look: list[0].look });
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(prim);
  }
  const budgetOf = (g) => (g === "body" ? B.body : g === "interior" ? B.interior : g.startsWith("wheel") ? B.wheel : B.caliper);
  for (const [g, list] of groups) groups.set(g, simplifyGroup(list, budgetOf(g)).filter((p) => p.idx.length));

  // The file.
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene("car");
  const credit = creditOf(car);
  doc.getRoot().getAsset().extras = { title: credit.title, author: credit.author, license: credit.license, source: credit.url, changes: "Simplified, resized and textures shrunk for the game." };
  // Pictures: the most used one up to maxTexture, the rest up to minorTexture,
  // in sizes the KTX2 step can compress, then smaller until within textureMB.
  const texSize = new Map();
  const order = kept.slice().sort((a, b) => (area.get(b) ?? 0) - (area.get(a) ?? 0));
  for (const [k, tex] of order.entries()) {
    const [w, h] = tex.getSize() ?? [512, 512];
    const cap = k === 0 ? B.maxTexture : B.minorTexture;
    const s = Math.min(1, cap / Math.max(w, h));
    texSize.set(tex, [Math.max(4, floorPow2(w * s)), Math.max(4, floorPow2(h * s))]);
  }
  const mb = () => {
    let total = 0;
    for (const [w, h] of texSize.values()) total += w * h * (w * h >= 65536 && w % 4 === 0 && h % 4 === 0 ? 1 : 4) * 1.33;
    return total / 1e6 + (palette.side ** 2 * 4 * 2) / 1e6;
  };
  while (mb() > B.textureMB) {
    const [tex, [w, h]] = [...texSize].sort((a, b) => b[1][0] * b[1][1] - a[1][0] * a[1][1])[0];
    if (w * h <= 256 * 256) break;
    texSize.set(tex, [Math.max(256, w / 2), Math.max(256, h / 2)]);
  }
  const textures = new Map();
  for (const [tex, [w, h]] of texSize) {
    const img = await sharp(Buffer.from(tex.getImage())).resize(w, h, { fit: "fill" }).webp({ quality: 88, alphaQuality: 90 }).toBuffer();
    textures.set(tex, doc.createTexture(`tex${kept.indexOf(tex)}`).setImage(img).setMimeType("image/webp"));
  }
  let paletteTex = null;
  let paletteMr = null;
  if (palette.cells.size) {
    const imgs = await palette.images();
    paletteTex = doc.createTexture("palette").setImage(imgs.color).setMimeType("image/png");
    paletteMr = doc.createTexture("paletteMR").setImage(imgs.mr).setMimeType("image/png");
  }
  const materials = new Map();
  const materialFor = (prim) => {
    const name = prim.material;
    if (materials.has(name)) return materials.get(name);
    const m = doc.createMaterial(name);
    const nearest = (ti) => ti.setMagFilter(9728).setMinFilter(9728);
    if (name === "glass") {
      m.setBaseColorFactor([0.05, 0.055, 0.06, 0.38]).setAlphaMode("BLEND").setMetallicFactor(0).setRoughnessFactor(0.05).setDoubleSided(true);
    } else if (/^(optic_)?tex/.test(name)) {
      const look = prim.look;
      // A see-through body picture (one with the windows painted in, say: those
      // are glass parts now) becomes a cut-out, so the paint can't show the
      // inside through it, or be drawn in the wrong order.
      const mode = look.alphaMode === "BLEND" && !name.startsWith("optic") ? "MASK" : look.alphaMode;
      m.setBaseColorTexture(textures.get(look.tex)).setBaseColorFactor(look.color).setMetallicFactor(look.metallic).setRoughnessFactor(look.roughness).setDoubleSided(look.doubleSided).setAlphaMode(mode).setAlphaCutoff(look.cutoff);
    } else {
      // Palette materials (paint, interior, optic, optic_glass).
      m.setBaseColorTexture(paletteTex).setMetallicRoughnessTexture(paletteMr).setMetallicFactor(1).setRoughnessFactor(1).setDoubleSided(true);
      nearest(m.getBaseColorTextureInfo());
      nearest(m.getMetallicRoughnessTextureInfo());
      if (name === "optic_glass") m.setAlphaMode("BLEND");
    }
    materials.set(name, m);
    return m;
  };
  let tris = 0;
  // Draw order inside the body: solid first, see-through last.
  const rank = (p) => (p.material === "glass" || p.material === "optic_glass" || /BLEND/.test(p.material) ? 1 : 0);
  for (const [g, list] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    if (!list.length) continue;
    const mesh = doc.createMesh(g);
    for (const p of list.sort((a, b) => rank(a) - rank(b))) {
      const prim = doc.createPrimitive()
        .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(p.pos).setBuffer(buffer))
        .setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setArray(p.nor).setBuffer(buffer))
        .setIndices(doc.createAccessor().setType("SCALAR").setArray(p.pos.length / 3 < 65536 ? Uint16Array.from(p.idx) : p.idx).setBuffer(buffer))
        .setMaterial(materialFor(p));
      if (p.uv) prim.setAttribute("TEXCOORD_0", doc.createAccessor().setType("VEC2").setArray(p.uv).setBuffer(buffer));
      mesh.addPrimitive(prim);
      tris += p.idx.length / 3;
    }
    const node = doc.createNode(g).setMesh(mesh);
    // Brake light spots, with X as the game sees it (mirrored on loading).
    if (g === "body") node.setExtras({ tailLamps: lamps.map((l) => ({ ...l, x: -l.x })) });
    scene.addChild(node);
  }
  return { doc, tris, textureMB: mb(), lamps, groups, palette, materials: materials.size };
}

// ---------- Credits ------------------------------------------------------------------------
function creditOf(car) {
  const c = car.credit;
  const page = (uid) => `https://sketchfab.com/3d-models/${uid}`;
  const profile = (user) => `https://sketchfab.com/${user}`;
  const o = c.original;
  return {
    title: o?.title ?? c.title,
    author: o?.author ?? c.author,
    profile: profile(o?.user ?? c.user),
    url: page(o?.uid ?? c.uid),
    license: o?.license ?? c.license ?? "CC BY 4.0",
    via: o ? { title: c.title, author: c.author, profile: profile(c.user), url: page(c.uid), license: c.license ?? "CC BY 4.0" } : null,
  };
}
const licenceUrl = (l) => `https://creativecommons.org/licenses/${/NC-SA/.test(l) ? "by-nc-sa" : /NC/.test(l) ? "by-nc" : "by"}/4.0/`;

async function writeCredits(cars) {
  const file = path.join(root, "CREDITS.md");
  let text = await readFile(file, "utf8");
  const start = "<!-- real cars: written by tools/prepare-cars.mjs -->";
  const end = "<!-- end of real cars -->";
  const lines = [
    start,
    "## Real cars",
    "",
    "From [Sketchfab](https://sketchfab.com). Changed for the game: simplified, resized,",
    "turned to face forward, wheels split off so they turn, and textures shrunk",
    "(`tools/prepare-cars.mjs`, list in `tools/cars.json`).",
    "",
    ...cars.map((car) => {
      const c = creditOf(car);
      const via = c.via ? ` (copy uploaded as "[${c.via.title}](${c.via.url})" by [${c.via.author}](${c.via.profile}))` : "";
      return `- ${car.brand} ${car.model}: "[${c.title}](${c.url})" by [${c.author}](${c.profile}), [${c.license}](${licenceUrl(c.license)})${via}`;
    }),
    end,
  ].join("\n");
  const re = new RegExp(`${start.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${end}`);
  text = re.test(text) ? text.replace(re, lines) : text.replace("## Sky and surfaces", `${lines}\n\n## Sky and surfaces`);
  await writeFile(file, text);
}

// ---------- Preview pictures ------------------------------------------------------------------
// A tiny software renderer: flat-shaded triangles, coloured by role.
async function preview(car, built, sizeM, notes) {
  await mkdir(previewDir, { recursive: true });
  const PX = 70; // pixels per metre
  const W = Math.ceil(6.4 * PX), H = Math.ceil(2.9 * PX), F = Math.ceil(2.9 * PX);
  const views = [
    { name: "right side", w: W, h: H, map: (p) => [p[2], p[1], p[0]], ox: W / 2, oy: H - 20 },
    { name: "top", w: W, h: F, map: (p) => [p[2], p[0], -p[1]], ox: W / 2, oy: F / 2 },
    { name: "front", w: F, h: H, map: (p) => [p[0], p[1], -p[2]], ox: F / 2, oy: H - 20 },
    { name: "back", w: F, h: H, map: (p) => [-p[0], p[1], p[2]], ox: F / 2, oy: H - 20 },
  ];
  const WHEEL = [[60, 220, 60], [60, 140, 255], [255, 160, 40], [200, 80, 255]];
  const colourOf = (group, material, p, i) => {
    if (group.startsWith("wheel_")) return WHEEL[+group.slice(6)] ?? [255, 255, 255];
    if (group.startsWith("caliper_")) return [255, 0, 255];
    if (group === "interior") return [150, 100, 60];
    if (material === "glass") return [120, 200, 255];
    if (p.uv && (material === "paint" || material.startsWith("optic") || material === "interior")) {
      const s = built.palette.side;
      const per = s / 4;
      const cell = Math.floor(p.uv[i * 2 + 1] * s / 4) * per + Math.floor(p.uv[i * 2] * s / 4);
      const c = built.palette.colourOf(cell);
      if (material.startsWith("optic")) return c[0] > c[1] * 1.7 && c[0] > c[2] * 1.7 ? [255, 30, 30] : [255, 240, 140];
      return c.slice(0, 3);
    }
    if (material.startsWith("optic")) return [255, 200, 120];
    return [170, 170, 175];
  };
  const panes = [];
  for (const v of views) {
    const img = Buffer.alloc(v.w * v.h * 3, 30);
    const depth = new Float32Array(v.w * v.h).fill(Infinity);
    const draw = (p, a, b, c, col, alpha) => {
      const q = [a, b, c].map((i) => {
        const m = v.map([p.pos[i * 3], p.pos[i * 3 + 1], p.pos[i * 3 + 2]]);
        return [v.ox + m[0] * PX, v.oy - m[1] * PX, m[2]];
      });
      const n = v.map([p.nor[a * 3], p.nor[a * 3 + 1], p.nor[a * 3 + 2]]);
      const shade = 0.35 + 0.65 * Math.abs(n[2]);
      const x0 = Math.max(0, Math.floor(Math.min(q[0][0], q[1][0], q[2][0]))), x1 = Math.min(v.w - 1, Math.ceil(Math.max(q[0][0], q[1][0], q[2][0])));
      const y0 = Math.max(0, Math.floor(Math.min(q[0][1], q[1][1], q[2][1]))), y1 = Math.min(v.h - 1, Math.ceil(Math.max(q[0][1], q[1][1], q[2][1])));
      const d = (q[1][1] - q[2][1]) * (q[0][0] - q[2][0]) + (q[2][0] - q[1][0]) * (q[0][1] - q[2][1]);
      if (Math.abs(d) < 1e-9) return;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const l0 = ((q[1][1] - q[2][1]) * (x + 0.5 - q[2][0]) + (q[2][0] - q[1][0]) * (y + 0.5 - q[2][1])) / d;
        const l1 = ((q[2][1] - q[0][1]) * (x + 0.5 - q[2][0]) + (q[0][0] - q[2][0]) * (y + 0.5 - q[2][1])) / d;
        const l2 = 1 - l0 - l1;
        if (l0 < 0 || l1 < 0 || l2 < 0) continue;
        const z = l0 * q[0][2] + l1 * q[1][2] + l2 * q[2][2];
        const k = y * v.w + x;
        if (z >= depth[k]) continue;
        if (alpha === 1) depth[k] = z;
        for (let ch = 0; ch < 3; ch++) img[k * 3 + ch] = Math.round(img[k * 3 + ch] * (1 - alpha) + Math.min(255, col[ch] * shade) * alpha);
      }
    };
    for (const pass of [0, 1]) {
      for (const [group, list] of built.groups) for (const p of list) {
        const see = p.material === "glass" || p.material === "optic_glass";
        if (see !== (pass === 1)) continue;
        for (let t = 0; t < p.idx.length; t += 3) draw(p, p.idx[t], p.idx[t + 1], p.idx[t + 2], colourOf(group, p.material, p, p.idx[t]), see ? 0.45 : 1);
      }
    }
    // Ground line, and the tail lamp glow boxes on the back view.
    if (v.name !== "top") for (let x = 0; x < v.w; x++) img.set([90, 90, 90], ((v.oy + 1) * v.w + x) * 3);
    if (v.name === "back") for (const l of built.lamps) {
      const xa = Math.round(v.ox - (l.x + l.w / 2) * PX), xb = Math.round(v.ox - (l.x - l.w / 2) * PX);
      const ya = Math.round(v.oy - (l.y + l.h / 2) * PX), yb = Math.round(v.oy - (l.y - l.h / 2) * PX);
      for (let x = xa; x <= xb; x++) for (const y of [ya, yb]) if (x >= 0 && x < v.w && y >= 0 && y < v.h) img.set([255, 255, 0], (y * v.w + x) * 3);
      for (let y = ya; y <= yb; y++) for (const x of [xa, xb]) if (x >= 0 && x < v.w && y >= 0 && y < v.h) img.set([255, 255, 0], (y * v.w + x) * 3);
    }
    panes.push({ v, png: await sharp(img, { raw: { width: v.w, height: v.h, channels: 3 } }).png().toBuffer() });
  }
  const total = { w: W + F * 2 + 20, h: H + F + 90 };
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const text = [`${car.id}: ${car.brand} ${car.model} — ${built.tris} triangles, ${built.materials} materials, ~${built.textureMB.toFixed(1)} MB pictures, ${built.lamps.length} tail lamps, size ${sizeM.join(" x ")} m`, ...notes.slice(0, 4)];
  const svg = `<svg width="${total.w}" height="${total.h}" xmlns="http://www.w3.org/2000/svg"><style>text{font:13px sans-serif;fill:#eee}</style>${text.map((t, i) => `<text x="6" y="${H + F + 22 + i * 16}">${esc(t)}</text>`).join("")}<text x="6" y="14">right side (nose right)</text><text x="6" y="${H + 14}">top (nose right, left side up)</text><text x="${W + 16}" y="14">front</text><text x="${W + F + 16}" y="14">back (yellow: brake light glow)</text></svg>`;
  await sharp({ create: { width: total.w, height: total.h, channels: 3, background: "#111" } })
    .composite([
      { input: panes[0].png, left: 0, top: 0 },
      { input: panes[1].png, left: 0, top: H },
      { input: panes[2].png, left: W + 10, top: 0 },
      { input: panes[3].png, left: W + F + 20, top: 0 },
      { input: Buffer.from(svg), left: 0, top: 0 },
    ])
    .png()
    .toFile(path.join(previewDir, `${car.id}.png`));
}

// ---------- All of them -----------------------------------------------------------------------
const listFile = path.join(root, "tools", "cars.json");
const listDoc = JSON.parse(await readFile(listFile, "utf8"));
const list = listDoc.cars;
await mkdir(outDir, { recursive: true });
const manifestFile = path.join(outDir, "vehicles.json");
const manifest = JSON.parse(await readFile(manifestFile, "utf8").catch(() => "[]"));
const runtimeFile = path.join(root, "src", "realCars.json");
const heldDir = path.join(root, "tools", ".cache", "cars", "held");
// A car's built files: the one you drive, its traffic copy and its garage picture.
const filesOf = (id) => [`${id}.glb`, `${id}_lod.glb`, path.join("thumbs", `${id}.webp`)];

// Held cars (`held` in cars.json: kept out of the game for now, say until their
// licence is sorted out) are moved out of public/ with --hold, and brought
// back with --unhold, without building anything again:
//   node tools/prepare-cars.mjs --hold              moves out every car marked held
//   node tools/prepare-cars.mjs --unhold id,id|all  clears the mark and moves them back
const built = [];
if (args.includes("--hold")) {
  await mkdir(path.join(heldDir, "thumbs"), { recursive: true });
  for (const car of list.filter((c) => c.held)) {
    let moved = 0;
    for (const f of filesOf(car.id)) {
      if (!existsSync(path.join(outDir, f))) continue;
      await rename(path.join(outDir, f), path.join(heldDir, f));
      moved++;
    }
    const i = manifest.findIndex((e) => e.id === car.id);
    if (i >= 0) {
      await writeFile(path.join(heldDir, `${car.id}.json`), JSON.stringify(manifest[i], null, 1));
      manifest.splice(i, 1);
    }
    console.log(`${car.id}: held (${car.held}); ${moved} files moved to tools/.cache/cars/held`);
  }
} else if (args.includes("--unhold")) {
  const which = args[args.indexOf("--unhold") + 1]?.split(",") ?? [];
  for (const car of list.filter((c) => c.held && (which.includes("all") || which.includes(c.id)))) {
    let moved = 0;
    for (const f of filesOf(car.id)) {
      if (!existsSync(path.join(heldDir, f))) continue;
      await rename(path.join(heldDir, f), path.join(outDir, f));
      moved++;
    }
    const row = path.join(heldDir, `${car.id}.json`);
    if (existsSync(row)) {
      const m = JSON.parse(await readFile(row, "utf8"));
      const i = manifest.findIndex((e) => e.id === m.id);
      if (i >= 0) manifest[i] = m;
      else manifest.push(m);
      await rm(row);
    }
    delete car.held;
    console.log(`${car.id}: back in the game (${moved} files moved back)${moved < 3 ? "; build it with node tools/prepare-cars.mjs " + car.id : ""}`);
  }
  await writeFile(listFile, JSON.stringify(listDoc, null, 2) + "\n");
} else {
  for (const car of list) {
    if (only && !only.includes(car.id)) continue;
    // (A car that couldn't be made to work says why in cars.json, and is left out.)
    if (car.skip || car.held) {
      console.log(`${car.id}: left out (${car.skip ?? `held: ${car.held}`})`);
      continue;
    }
    if (!existsSync(path.join(srcDir, car.file))) {
      console.log(`${car.id}: not downloaded yet (${car.file}), skipped`);
      continue;
    }
    const t0 = Date.now();
    try {
      const { manifest: m, notes } = await prepare(car);
      const i = manifest.findIndex((e) => e.id === m.id);
      if (i >= 0) manifest[i] = m;
      else manifest.push(m);
      built.push(car.id);
      console.log(`${car.id}: ${m.trisBefore} -> ${m.tris} triangles (traffic copy ${m.lodTris}), ~${m.textureMB} MB pictures (copy ${m.lodTextureMB}), ${m.wheels} wheels, ${m.tailLamps} tail lamps, ${m.size.join(" x ")} m, flip ${m.flip}  ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      for (const n of notes) console.log(`   ${n}`);
    } catch (err) {
      console.error(`${car.id}: FAILED`, err);
    }
  }
}
await writeFile(manifestFile, JSON.stringify(manifest, null, 1));
// What the game reads: every car that is built and neither left out nor held
// (in the order of cars.json).
const out = list
  .filter((car) => !car.skip && !car.held && existsSync(path.join(outDir, `${car.id}.glb`)))
  .map((car) => {
    const c = creditOf(car);
    return {
      id: car.id, brand: car.brand, model: car.model, year: car.year, country: car.country, class: car.class,
      kw: car.kw, kg: car.kg, drive: car.drive, topKmh: car.topKmh, ...(car.zeroTo80 ? { zeroTo80: car.zeroTo80 } : { zeroTo100: car.zeroTo100 }),
      ...(car.grip ? { grip: car.grip } : {}), ...(car.redline ? { redline: car.redline } : {}),
      sound: car.sound, ...(car.electric ? { electric: true } : {}), ...(car.traffic ? { traffic: true } : {}),
      credit: { title: c.title, author: c.author, url: c.url, license: c.license, ...(c.via ? { via: { title: c.via.title, author: c.via.author, url: c.via.url } } : {}) },
    };
  });
await writeFile(runtimeFile, JSON.stringify(out, null, 1));
await writeCredits(list.filter((car) => out.some((o) => o.id === car.id)));
console.log(`${built.length} built; ${out.length} real cars in src/realCars.json.${built.length ? " Next: node tools/compress-textures.mjs vehicles" : ""}`);
