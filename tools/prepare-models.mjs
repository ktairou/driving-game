// Turns the models downloaded from Sketchfab (tools/.cache/sketchfab, all
// Creative Commons Attribution) into game-ready files:
//   - the two vehicle packs become one small GLB per vehicle, in metres, with
//     the origin on the ground under the middle of the car;
//   - each landmark is simplified for the iPad and stood on the origin.
// Textures become WebP. A manifest with sizes goes next to each set.
//   node tools/prepare-models.mjs
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NodeIO, Node, getBounds } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, prune, weld, simplify, flatten, join, textureCompress, metalRough, center, transformMesh, quantize } from "@gltf-transform/functions";
import { MeshoptSimplifier } from "meshoptimizer";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "tools", ".cache", "sketchfab");
const outVehicles = path.join(root, "public", "assets", "vehicles");
const outLandmarks = path.join(root, "public", "assets", "landmarks");
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

// --- tiny column-major 4x4 helpers ------------------------------------------------
const mul = (a, b) => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
const translation = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const rotationY = (t) => [Math.cos(t), 0, -Math.sin(t), 0, 0, 1, 0, 0, Math.sin(t), 0, Math.cos(t), 0, 0, 0, 0, 1];

// Bakes every mesh under `nodes` into world space (metres, Y up) and gathers
// them under one new node, so the vehicle can be moved as a whole.
function bakeToWorld(doc, nodes) {
  const scene = doc.getRoot().listScenes()[0];
  const out = [];
  const visit = (n) => {
    if (n.getMesh()) out.push({ node: n, world: n.getWorldMatrix() });
    n.listChildren().forEach(visit);
  };
  nodes.forEach(visit);
  for (const { node, world } of out) {
    let mesh = node.getMesh();
    // A mesh shared with another node (e.g. four identical wheels) gets its own copy.
    if (mesh.listParents().filter((p) => p instanceof Node).length > 1) {
      mesh = mesh.clone();
      node.setMesh(mesh);
    }
    transformMesh(mesh, world);
    node.getParentNode()?.removeChild(node);
    for (const child of node.listChildren()) node.removeChild(child);
    node.setMatrix(translation(0, 0, 0));
    scene.addChild(node);
  }
  return out.map((o) => o.node);
}

function boundsOf(nodes) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const n of nodes) {
    const b = getBounds(n);
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], b.min[i]);
      max[i] = Math.max(max[i], b.max[i]);
    }
  }
  return { min, max, centre: min.map((v, i) => (v + max[i]) / 2) };
}

// Main horizontal direction of a set of points (the length of a vehicle).
function lengthAxis(points) {
  const cx = points.reduce((s, p) => s + p[0], 0) / points.length;
  const cz = points.reduce((s, p) => s + p[2], 0) / points.length;
  let xx = 0;
  let xz = 0;
  let zz = 0;
  for (const p of points) {
    const dx = p[0] - cx;
    const dz = p[2] - cz;
    xx += dx * dx;
    xz += dx * dz;
    zz += dz * dz;
  }
  const angle = 0.5 * Math.atan2(2 * xz, xx - zz); // angle of the major axis from +X
  return [Math.cos(angle), Math.sin(angle)];
}

function vertexPoints(nodes) {
  const pts = [];
  for (const n of nodes) {
    for (const prim of n.getMesh().listPrimitives()) {
      const pos = prim.getAttribute("POSITION");
      for (let i = 0; i < pos.getCount(); i += 3) pts.push(pos.getElement(i, []));
    }
  }
  return pts;
}

// Moves the vehicle so it stands on the origin, pointing along +Z (or -Z when
// `flip`; the right way round was checked by eye in the game).
function placeVehicle(nodes, axis, groundY, centre, flip) {
  const theta = Math.atan2(axis[0], axis[1]) + (flip ? Math.PI : 0);
  const m = mul(rotationY(-theta), translation(-centre[0], -groundY, -centre[2]));
  for (const n of nodes) transformMesh(n.getMesh(), m);
}

async function finish(doc, keep, file, maxTexture) {
  const scene = doc.getRoot().listScenes()[0];
  for (const n of scene.listChildren()) if (!keep.includes(n)) scene.removeChild(n);
  await doc.transform(prune(), dedup(), weld(), textureCompress({ encoder: sharp, targetFormat: "webp", resize: [maxTexture, maxTexture] }), prune());
  // Only the main body picture stays full size; lights, glass, stickers and
  // wheels are fine at half, which saves a lot of the iPad's graphics memory
  // with many vehicles on the road.
  const use = new Map();
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const p of mesh.listPrimitives()) {
      const t = p.getMaterial()?.getBaseColorTexture();
      if (t) use.set(t, (use.get(t) ?? 0) + (p.getIndices()?.getCount() ?? 0));
    }
  }
  const main = [...use].sort((a, b) => b[1] - a[1])[0]?.[0];
  for (const t of doc.getRoot().listTextures()) {
    if (t === main || Math.max(...(t.getSize() ?? [0])) <= 512) continue;
    t.setImage(await sharp(Buffer.from(t.getImage())).resize(512, 512, { fit: "inside" }).webp({ quality: 88 }).toBuffer()).setMimeType("image/webp");
  }
  await io.write(file, doc);
  return boundsOf(keep);
}

const tris = (doc) => {
  let t = 0;
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) t += (p.getIndices()?.getCount() ?? p.getAttribute("POSITION").getCount()) / 3;
  return Math.round(t);
};

// --- Vehicles ----------------------------------------------------------------------
// The service vehicles' wheels are part of the body mesh, but each wheel is a
// separate piece of it. Find the pieces that are round, upright, narrow and
// on the ground, and cut them out as wheel_N nodes (like the everyday cars'
// wheels), so the game can spin and steer them. Returns the new nodes.
function splitWheels(doc, node) {
  const scene = doc.getRoot().listScenes()[0];
  const prim = node.getMesh().listPrimitives()[0];
  const pos = prim.getAttribute("POSITION");
  const idx = prim.getIndices();
  const nV = pos.getCount();
  const parent = new Int32Array(nV).map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const union = (a, b) => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[a] = b;
  };
  const v = [];
  const at = new Map();
  for (let i = 0; i < nV; i++) {
    const k = pos.getElement(i, v).map((x) => Math.round(x * 2000)).join(",");
    if (at.has(k)) union(i, at.get(k));
    else at.set(k, i);
  }
  for (let t = 0; t < idx.getCount(); t += 3) {
    union(idx.getScalar(t), idx.getScalar(t + 1));
    union(idx.getScalar(t + 1), idx.getScalar(t + 2));
  }
  const pieces = new Map();
  for (let i = 0; i < nV; i++) {
    const r = find(i);
    pos.getElement(i, v);
    let c = pieces.get(r);
    if (!c) pieces.set(r, (c = { min: [...v], max: [...v] }));
    for (let k = 0; k < 3; k++) {
      c.min[k] = Math.min(c.min[k], v[k]);
      c.max[k] = Math.max(c.max[k], v[k]);
    }
  }
  const wheels = [];
  for (const [r, c] of pieces) {
    const s = c.max.map((x, k) => x - c.min[k]);
    if (c.min[1] < 0.15 && s[1] > 0.35 && s[1] < 1.6 && Math.abs(s[1] - s[2]) < 0.2 * s[1] && s[0] < 0.8 * s[1]) wheels.push({ roots: new Set([r]), ...c });
  }
  if (wheels.length < 4) return [];
  // Small pieces inside a wheel (hub caps, nuts) go with it.
  for (const [r, c] of pieces) {
    const w = wheels.find((w) => !w.roots.has(r) && [0, 1, 2].every((k) => c.min[k] > w.min[k] - 0.02 && c.max[k] < w.max[k] + 0.02));
    if (w) w.roots.add(r);
  }
  const body = [];
  const parts = wheels.map(() => []);
  for (let t = 0; t < idx.getCount(); t += 3) {
    const tri = [idx.getScalar(t), idx.getScalar(t + 1), idx.getScalar(t + 2)];
    const r = find(tri[0]);
    const w = wheels.findIndex((w) => w.roots.has(r));
    (w < 0 ? body : parts[w]).push(...tri);
  }
  const indices = (list) => doc.createAccessor().setType("SCALAR").setArray(new Uint32Array(list)).setBuffer(idx.getBuffer());
  prim.setIndices(indices(body));
  return parts.map((list, i) => {
    const p = prim.clone().setIndices(indices(list));
    const n = doc.createNode(`wheel_${i}`).setMesh(doc.createMesh(`wheel_${i}`).addPrimitive(p));
    scene.addChild(n);
    return n;
  });
}

// [id, name, flip] — flip turns it round when the model's nose points the other way.
const PASSENGER = {
  "Compact Body": ["compact", "Compact", false],
  "Coupe Body": ["coupe", "Coupe", false],
  "Hatchback Body": ["hatchback", "Hatchback", false],
  "minivan body": ["minivan", "People carrier", false],
  "Offroad Body": ["offroad", "Off-roader", true],
  "Pickup Body": ["pickup", "Pickup", false],
  "Sedan Body": ["sedan", "Saloon", false],
  "Sport Body": ["sport", "Sports car", true],
  "SUV Body": ["suv", "SUV", true],
  "Wagon Body": ["wagon", "Estate", true],
};
const SERVICE = {
  ambulance: ["ambulance", "Ambulance", false],
  citybus: ["citybus", "City bus", true],
  fire_truck: ["firetruck", "Fire engine", true],
  garbage_truck: ["bintruck", "Bin lorry", false],
  police_sedan: ["police", "Police car", false],
  rdservtruck: ["worktruck", "Work truck", true],
  school_bus: ["schoolbus", "School bus", true],
  taxi: ["taxi", "Taxi", false],
  towtruck: ["towtruck", "Tow truck", true],
  postvan: ["postvan", "Post van", false],
};

async function vehicles() {
  await mkdir(outVehicles, { recursive: true });
  const manifest = [];
  // Everyday cars: a body plus four separate wheels each.
  const pFile = path.join(src, "generic_passenger_car_pack.glb");
  const probe = await io.read(pFile);
  const bodyNames = probe.getRoot().listNodes().map((n) => n.getName()).filter((n) => /body/i.test(n) && !/_/.test(n));
  for (const bodyName of bodyNames) {
    const key = Object.keys(PASSENGER).find((k) => k.toLowerCase() === bodyName.trim().toLowerCase());
    const info = PASSENGER[key] ?? [bodyName.toLowerCase().replace(/\W+/g, ""), bodyName, false];
    const doc = await io.read(pFile);
    await doc.transform(metalRough());
    const all = doc.getRoot().listNodes();
    const body = all.find((n) => n.getName() === bodyName);
    const wheelsAll = all.filter((n) => /^Wheel_/.test(n.getName()) && n.listChildren().length);
    // The four wheels nearest this body (by where they really are in the scene).
    const bw = body.getWorldTranslation();
    const dist = (n) => {
      const w = n.getWorldTranslation();
      return Math.hypot(w[0] - bw[0], w[2] - bw[2]);
    };
    const wheels = wheelsAll.sort((a, b) => dist(a) - dist(b)).slice(0, 4);
    const bodyParts = bakeToWorld(doc, [body]);
    const wheelParts = bakeToWorld(doc, wheels);
    wheelParts.forEach((n, i) => n.setName(`wheel_${i}`));
    bodyParts.forEach((n) => n.setName(`body_${n.getName().replace(/.*_(Body|Glass|Optics)_0$/i, "$1").toLowerCase()}`));
    const wb = wheelParts.map((n) => boundsOf([n]));
    const centres = wb.map((b) => b.centre);
    const axis = lengthAxis(centres);
    const groundY = Math.min(...wb.map((b) => b.min[1]));
    const mid = [0, 1, 2].map((i) => centres.reduce((s, c) => s + c[i], 0) / centres.length);
    placeVehicle([...bodyParts, ...wheelParts], axis, groundY, mid, info[2]);
    const file = path.join(outVehicles, `${info[0]}.glb`);
    const b = await finish(doc, [...bodyParts, ...wheelParts], file, 1024);
    manifest.push({ id: info[0], name: info[1], pack: "passenger", wheels: 4, size: b.max.map((v, i) => +(v - b.min[i]).toFixed(2)), min: b.min.map((v) => +v.toFixed(2)), max: b.max.map((v) => +v.toFixed(2)), tris: tris(doc) });
    console.log("vehicle", info[0], manifest.at(-1).size.join(" x "));
  }
  // Service vehicles: wheels are part of the body (cut out by splitWheels).
  const sFile = path.join(src, "generic_civil_service_vehicles_pack.glb");
  for (const [nodeName, info] of Object.entries(SERVICE)) {
    const doc = await io.read(sFile);
    await doc.transform(metalRough());
    const top = doc.getRoot().listNodes().find((n) => n.getName() === nodeName);
    if (!top) {
      console.warn("missing", nodeName);
      continue;
    }
    const parts = bakeToWorld(doc, [top]);
    parts.forEach((n, i) => n.setName(`body_${i}`));
    const b0 = boundsOf(parts);
    const axis = lengthAxis(vertexPoints(parts));
    placeVehicle(parts, axis, b0.min[1], b0.centre, info[2]);
    const wheels = splitWheels(doc, parts[0]);
    const file = path.join(outVehicles, `${info[0]}.glb`);
    const b = await finish(doc, [...parts, ...wheels], file, 1024);
    manifest.push({ id: info[0], name: info[1], pack: "service", wheels: wheels.length, size: b.max.map((v, i) => +(v - b.min[i]).toFixed(2)), min: b.min.map((v) => +v.toFixed(2)), max: b.max.map((v) => +v.toFixed(2)), tris: tris(doc) });
    console.log("vehicle", info[0], manifest.at(-1).size.join(" x "));
  }
  await writeFile(path.join(outVehicles, "vehicles.json"), JSON.stringify(manifest, null, 1));
}

// --- Landmarks -----------------------------------------------------------------------
// Photo scans come with rubbish around the edges: big flat triangles where the
// camera saw nothing, and bits of sky. Drops triangles bigger than maxArea
// (square metres, in the model's own units) and ones whose picture is sky blue.
async function cleanScan(doc, { maxArea = Infinity, sky = false }) {
  const pics = new Map();
  const picOf = async (tex) => {
    if (!pics.has(tex)) pics.set(tex, await sharp(Buffer.from(tex.getImage())).resize(1024, 1024).removeAlpha().raw().toBuffer());
    return pics.get(tex);
  };
  let dropped = 0;
  for (const mesh of doc.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) {
    const pos = p.getAttribute("POSITION");
    const uv = p.getAttribute("TEXCOORD_0");
    const idx = p.getIndices();
    const tex = p.getMaterial()?.getBaseColorTexture();
    const pic = sky && uv && tex ? await picOf(tex) : null;
    const colour = (u, v) => {
      const x = Math.min(1023, Math.max(0, Math.floor((u - Math.floor(u)) * 1024)));
      const y = Math.min(1023, Math.max(0, Math.floor((v - Math.floor(v)) * 1024)));
      const i = (y * 1024 + x) * 3;
      return [pic[i], pic[i + 1], pic[i + 2]];
    };
    const keep = [];
    const a = [], b = [], c = [], ua = [], ub = [], uc = [];
    for (let t = 0; t < idx.getCount(); t += 3) {
      const i0 = idx.getScalar(t), i1 = idx.getScalar(t + 1), i2 = idx.getScalar(t + 2);
      pos.getElement(i0, a); pos.getElement(i1, b); pos.getElement(i2, c);
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const area = Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]) / 2;
      let bad = area > maxArea;
      if (!bad && pic) {
        uv.getElement(i0, ua); uv.getElement(i1, ub); uv.getElement(i2, uc);
        const m = colour((ua[0] + ub[0] + uc[0]) / 3, (ua[1] + ub[1] + uc[1]) / 3);
        bad = m[2] > m[0] + 25 && m[2] > m[1];
      }
      if (bad) dropped++;
      else keep.push(i0, i1, i2);
    }
    const out = doc.createAccessor().setType("SCALAR").setArray(new Uint32Array(keep)).setBuffer(idx.getBuffer());
    p.setIndices(out);
  }
  return dropped;
}

// [id, file, parts to leave out (by node name or material name)]. Some models
// come with a ground sheet, or the same building twice.
const LANDMARKS = [
  ["bigben", "clock_tower_big_ben.glb"],
  ["towerbridge", "tower_bridge.glb"],
  ["stonehenge", "stonehenge.glb", { drop: ["Object_2"] }],
  ["eiffel", "free__la_tour_eiffel.glb"],
  ["arc", "arc_de_triumphe_paris.glb", { maxError: 0.01 }],
  ["notredame", "notre_dame_de_paris.glb", { drop: ["material_68", "edge_color000255"], doubleSided: true }],
  ["montstmichel", "mont_st_michel_france_saint_michaels_mount.glb"],
  ["abusimbel", "abu_simbel.glb"],
  ["liberty", "statue_of_liberty.glb"],
  ["empirestate", "empire_state_building.glb"],
  ["rushmore", "mt_rushmore.glb", { clean: { maxArea: 0.5, sky: true } }],
];
const MAX_TRIS = 70000;

async function landmarks() {
  await mkdir(outLandmarks, { recursive: true });
  await MeshoptSimplifier.ready;
  const manifest = {};
  for (const [id, file, opts = {}] of LANDMARKS.filter(([id]) => !process.argv[3] || process.argv[3].split(",").includes(id))) {
    const doc = await io.read(path.join(src, file));
    for (const n of doc.getRoot().listNodes()) {
      const mat = n.getMesh()?.listPrimitives()[0]?.getMaterial()?.getName();
      if (opts.drop?.some((d) => d === n.getName() || d === mat)) n.setMesh(null);
    }
    // (Some models only have walls facing one way, so they vanish from the other side.)
    if (opts.doubleSided) for (const mat of doc.getRoot().listMaterials()) mat.setDoubleSided(true);
    // Photo scans are often marked "ignore the lights", which would make them
    // glow at night. Light them like everything else.
    for (const mat of doc.getRoot().listMaterials()) {
      if (!mat.getExtension("KHR_materials_unlit")) continue;
      mat.setExtension("KHR_materials_unlit", null);
      mat.setMetallicFactor(0).setRoughnessFactor(0.95);
    }
    if (opts.clean) console.log("  cleaned", id, await cleanScan(doc, opts.clean), "triangles");
    const before = tris(doc);
    await doc.transform(metalRough(), flatten(), join(), weld());
    const ratio = Math.min(1, MAX_TRIS / tris(doc));
    // Allow a little more change in shape if needed to get under the limit.
    for (const error of [0.01, 0.03, 0.08].filter((e) => e <= (opts.maxError ?? 1))) {
      if (tris(doc) <= MAX_TRIS * 1.1) break;
      await doc.transform(simplify({ simplifier: MeshoptSimplifier, ratio: Math.min(1, MAX_TRIS / tris(doc)), error }));
    }
    await doc.transform(dedup(), prune(), center({ pivot: "below" }), textureCompress({ encoder: sharp, targetFormat: "webp", resize: [2048, 2048] }), prune());
    const b = getBounds(doc.getRoot().listScenes()[0]);
    // Smaller numbers for positions and normals (read directly by the game engine).
    await doc.transform(quantize());
    await io.write(path.join(outLandmarks, `${id}.glb`), doc);
    manifest[id] = { size: b.max.map((v, i) => +(v - b.min[i]).toFixed(2)), tris: tris(doc), before };
    console.log("landmark", id, `${before} -> ${manifest[id].tris} tris`, manifest[id].size.join(" x "));
  }
  const old = JSON.parse(await readFile(path.join(outLandmarks, "landmarks.json"), "utf8").catch(() => "{}"));
  await writeFile(path.join(outLandmarks, "landmarks.json"), JSON.stringify({ ...old, ...manifest }, null, 1));
}

const which = process.argv[2];
if (!which || which === "vehicles") await vehicles();
if (!which || which === "landmarks") await landmarks();
