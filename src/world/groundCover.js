import { RawTexture, Texture, PBRMaterial, MaterialPluginBase, Matrix, Quaternion, Vector3 } from "@babylonjs/core";
import { GeometryBuilder } from "../geom.js";
import { mulberry32, smoothstep, lerp } from "../noise.js";
import { inTown } from "./road.js";
import { ISLANDS, ROAD_HALF_WIDTH } from "./layout.js";
import { WindSway } from "./wind.js";

// Ground cover: clumps of grass, wild flowers and bushes beside the country
// roads (dry shrubs in the desert), plus a few groups of palms by the desert
// towns. All of it is thin instances of a handful of small card meshes, drawn
// from one 512 px picture painted here in code.

// Few, large groups: each mesh costs a little every frame even when it isn't drawn.
const SECTOR = 600; // clumps are grouped in 600 m squares...
const SHOW_WITHIN = 560; // ...each drawn only while the camera is within this of its middle
const REACH = 60; // how far from the road edge clumps go (most stay much closer)
const ATLAS = 512;

// Where each picture is in the atlas: [x0, y0, x1, y1] in pixels, y down.
const CELLS = {
  grass: [0, 0, 256, 192],
  flowers: [256, 0, 512, 192],
  bush: [0, 192, 256, 384],
  shrub: [256, 192, 512, 384],
  frond: [0, 384, 512, 512],
};

// --- The picture ---------------------------------------------------------------

function blades(c, rand, [x0, y0, x1, y1], count, colour) {
  const w = x1 - x0;
  const h = y1 - y0;
  for (let i = 0; i < count; i++) {
    const bx = x0 + w / 2 + (rand() - 0.5) * w * 0.72;
    const by = y1 - 1;
    const len = h * (0.35 + rand() * 0.6);
    const lean = (rand() - 0.5) * w * 0.4;
    const half = 2.6 + rand() * 3;
    c.fillStyle = colour(rand);
    c.beginPath();
    c.moveTo(bx - half, by);
    c.quadraticCurveTo(bx - half * 0.3 + lean * 0.35, by - len * 0.55, bx + lean, by - len);
    c.quadraticCurveTo(bx + half * 0.3 + lean * 0.35, by - len * 0.55, bx + half, by);
    c.closePath();
    c.fill();
  }
}

// Olive greens, like the grass texture on the ground.
const grassColour = (rand) => `hsl(${54 + rand() * 22}, ${24 + rand() * 18}%, ${13 + rand() * 16}%)`;

function flowers(c, rand, [x0, y0, x1, y1]) {
  blades(c, rand, [x0, y0, x1, y1], 60, grassColour);
  const colours = ["#f3f1e6", "#f1cd3c", "#a47ad0", "#d8452f", "#f3f1e6"];
  for (let i = 0; i < 24; i++) {
    const x = x0 + 26 + rand() * (x1 - x0 - 52);
    const y = y0 + 22 + rand() * (y1 - y0) * 0.55;
    c.strokeStyle = "#4d6a2a";
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x + (rand() - 0.5) * 8, y1 - 2);
    c.stroke();
    c.fillStyle = colours[Math.floor(rand() * colours.length)];
    const r = 3 + rand() * 2.5;
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2 + rand();
      c.beginPath();
      c.arc(x + Math.cos(a) * r, y + Math.sin(a) * r, r * 0.75, 0, Math.PI * 2);
      c.fill();
    }
    c.fillStyle = "#e0b322";
    c.beginPath();
    c.arc(x, y, r * 0.55, 0, Math.PI * 2);
    c.fill();
  }
}

// A bush of a few overlapping lumps of leaves, so its outline isn't a ball.
function bush(c, rand, [x0, y0, x1, y1]) {
  const w = x1 - x0;
  const h = y1 - y0;
  const lumps = [];
  for (let k = 0; k < 6; k++) {
    const r = h * (0.18 + rand() * 0.14);
    lumps.push([x0 + w * (0.22 + rand() * 0.56), y1 - r - rand() * h * 0.45, r * (1.1 + rand() * 0.3), r]);
  }
  for (let i = 0; i < 1100; i++) {
    const [lx, ly, rx, ry] = lumps[Math.floor(rand() * lumps.length)];
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand());
    const x = lx + Math.cos(a) * r * rx;
    const y = Math.min(ly + Math.sin(a) * r * ry, y1 - 4);
    // Lighter on top, where the sun gets in.
    const light = 1 - (y - y0) / h;
    c.fillStyle = `hsl(${62 + rand() * 26}, ${24 + rand() * 18}%, ${10 + light * 13 + rand() * 7}%)`;
    c.beginPath();
    c.ellipse(x, y, 5 + rand() * 5, 3 + rand() * 2.5, rand() * Math.PI, 0, Math.PI * 2);
    c.fill();
  }
}

function shrub(c, rand, [x0, y0, x1, y1]) {
  const tips = [];
  const branch = (x, y, a, len, width, depth) => {
    const ex = x + Math.cos(a) * len;
    const ey = y - Math.sin(a) * len;
    c.strokeStyle = depth ? "#8a7a5e" : "#6f5f47";
    c.lineWidth = width;
    c.lineCap = "round";
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(ex, ey);
    c.stroke();
    if (depth < 2) for (let k = 0; k < 3; k++) branch(ex, ey, a + (rand() - 0.5) * 1.1, len * (0.55 + rand() * 0.2), width * 0.6, depth + 1);
    else tips.push([ex, ey]);
  };
  const bx = (x0 + x1) / 2;
  for (let i = 0; i < 7; i++) branch(bx + (rand() - 0.5) * 20, y1 - 2, Math.PI / 2 + (rand() - 0.5) * 1.9, 45 + rand() * 30, 4, 0);
  for (const [x, y] of tips) {
    for (let k = 0; k < 4; k++) {
      c.fillStyle = `hsl(${50 + rand() * 18}, ${18 + rand() * 16}%, ${34 + rand() * 14}%)`;
      c.beginPath();
      c.ellipse(x + (rand() - 0.5) * 12, y + (rand() - 0.5) * 10, 3 + rand() * 2.5, 2 + rand() * 1.5, rand() * Math.PI, 0, Math.PI * 2);
      c.fill();
    }
  }
}

// A palm frond lying along the strip: stem from left to right, leaflets
// sweeping towards the tip, shorter as they go.
function frond(c, rand, [x0, y0, x1, y1]) {
  const cy = (y0 + y1) / 2;
  const len = x1 - x0 - 12;
  c.lineCap = "round";
  for (let s = 10; s < len; s += 6) {
    const t = s / len;
    const leaf = 8 + 52 * (1 - Math.pow(t, 1.4)) * Math.min(1, t * 6);
    const x = x0 + 6 + s;
    const y = cy - 3 * t;
    for (const side of [-1, 1]) {
      const a = 0.75 + rand() * 0.3;
      c.strokeStyle = `hsl(${84 + rand() * 18}, ${38 + rand() * 18}%, ${20 + rand() * 14}%)`;
      c.lineWidth = 3 + rand() * 1.5;
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x + Math.cos(a) * leaf, y + side * Math.sin(a) * leaf);
      c.stroke();
    }
  }
  c.strokeStyle = "#6b6a3a";
  c.lineWidth = 4;
  c.beginPath();
  c.moveTo(x0 + 2, cy);
  c.lineTo(x1 - 6, cy - 3);
  c.stroke();
}

function coverAtlas(scene, rand) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = ATLAS;
  const c = canvas.getContext("2d");
  blades(c, rand, CELLS.grass, 110, grassColour);
  flowers(c, rand, CELLS.flowers);
  bush(c, rand, CELLS.bush);
  shrub(c, rand, CELLS.shrub);
  frond(c, rand, CELLS.frond);
  const img = c.getImageData(0, 0, ATLAS, ATLAS);
  const px = img.data;
  // See-through pixels take their picture's average colour, so the smaller
  // copies the GPU makes for distance don't grow dark edges.
  for (const [x0, y0, x1, y1] of Object.values(CELLS)) {
    const sum = [0, 0, 0, 0];
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const k = (y * ATLAS + x) * 4;
        if (px[k + 3] < 128) continue;
        for (let i = 0; i < 3; i++) sum[i] += px[k + i];
        sum[3]++;
      }
    }
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const k = (y * ATLAS + x) * 4;
        if (px[k + 3] > 8) continue;
        for (let i = 0; i < 3; i++) px[k + i] = sum[i] / Math.max(1, sum[3]);
      }
    }
  }
  // (Not flipped: the canvas's top row is v = 0, which the uvs below expect.)
  const t = RawTexture.CreateRGBATexture(new Uint8Array(px.buffer), ATLAS, ATLAS, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
  t.name = "groundCover";
  t.hasAlpha = true;
  t.wrapU = t.wrapV = Texture.CLAMP_ADDRESSMODE;
  t.anisotropicFilteringLevel = 4;
  return t;
}

// Keeps thin blades from fading away with distance: the GPU's smaller copies
// of the picture blur the gaps into the blades, so alpha is scaled back up by
// how much smaller than full size the picture is being drawn.
class KeepCoverage extends MaterialPluginBase {
  constructor(material) {
    super(material, "KeepCoverage", 220, { KEEPCOVERAGE: false });
    this._enable(true);
  }

  getClassName() {
    return "KeepCoverage";
  }

  prepareDefines(defines) {
    defines.KEEPCOVERAGE = true;
  }

  getCustomCode(shaderType) {
    if (shaderType !== "fragment") return null;
    return {
      CUSTOM_FRAGMENT_UPDATE_ALBEDO: `
        #ifdef KEEPCOVERAGE
          vec2 coverTexels = fwidth(vAlbedoUV) * ${ATLAS}.0;
          alpha = min(1.0, alpha * (1.0 + max(0.0, log2(max(coverTexels.x, coverTexels.y))) * 0.35));
        #endif
      `,
    };
  }
}

function coverMaterial(scene, name, atlas, sway) {
  const m = new PBRMaterial(name, scene);
  m.albedoTexture = atlas;
  m.useAlphaFromAlbedoTexture = true;
  m.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST;
  m.alphaCutOff = 0.35;
  m.backFaceCulling = false;
  m.metallic = 0;
  m.roughness = 0.9;
  new WindSway(m, sway);
  new KeepCoverage(m);
  return m;
}

// --- The shapes ----------------------------------------------------------------

const uvOf = (cell, u, v) => [(cell[0] + (cell[2] - cell[0]) * u) / ATLAS, (cell[1] + (cell[3] - cell[1]) * v) / ATLAS];

// An upright card standing on the ground at (x, z), turned by `yaw`, with its
// top leaning `lean` metres sideways. Normals point mostly up, so clumps are
// lit like the ground they stand on whichever way they face.
function card(g, cell, x, z, yaw, w, h, lean = 0) {
  const dx = (Math.cos(yaw) * w) / 2;
  const dz = (Math.sin(yaw) * w) / 2;
  const fx = -Math.sin(yaw);
  const fz = Math.cos(yaw);
  const n = [fx * 0.3, 1, fz * 0.3];
  const l = Math.hypot(n[0], n[1], n[2]);
  const up = [n[0] / l, n[1] / l, n[2] / l];
  g.addQuad(
    [x - dx, 0, z - dz],
    [x + dx, 0, z + dz],
    [x + dx + fx * lean, h, z + dz + fz * lean],
    [x - dx + fx * lean, h, z - dz + fz * lean],
    [fx, 0, fz],
    uvOf(cell, 0, 1),
    uvOf(cell, 1, 1),
    uvOf(cell, 1, 0),
    uvOf(cell, 0, 0),
    [up, up, up, up],
  );
}

// Two crossed cards.
function tuft(g, cell, rand, x, z, w, h) {
  const a = rand() * Math.PI;
  card(g, cell, x, z, a, w, h, (rand() - 0.5) * 0.2);
  card(g, cell, x, z, a + Math.PI / 2, w, h, (rand() - 0.5) * 0.2);
}

// Tufts of grass with a few wild flowers among them, on one side (so turning
// each copy differently moves the flowers about).
function grassPatch(rand) {
  const g = new GeometryBuilder();
  for (let i = 0; i < 6; i++) {
    const a = rand() * Math.PI * 2;
    const r = rand() * 1.7;
    tuft(g, CELLS.grass, rand, Math.cos(a) * r, Math.sin(a) * r, 0.8 + rand() * 0.35, 0.42 + rand() * 0.3);
  }
  for (let i = 0; i < 2; i++) {
    const a = rand() * Math.PI;
    const r = 0.5 + rand() * 0.9;
    tuft(g, CELLS.flowers, rand, Math.cos(a) * r, Math.sin(a) * r, 0.75, 0.45 + rand() * 0.15);
  }
  return g;
}

function bushShape(rand) {
  const g = new GeometryBuilder();
  for (let k = 0; k < 3; k++) card(g, CELLS.bush, 0, 0, (k * Math.PI) / 3 + rand() * 0.3, 1.7, 1.25, (rand() - 0.5) * 0.15);
  for (let k = 0; k < 2; k++) {
    const a = rand() * Math.PI * 2;
    card(g, CELLS.bush, Math.cos(a) * 0.6, Math.sin(a) * 0.6, a, 1.15, 0.85);
  }
  for (let k = 0; k < 4; k++) {
    const a = rand() * Math.PI * 2;
    tuft(g, CELLS.grass, rand, Math.cos(a) * (0.9 + rand() * 0.6), Math.sin(a) * (0.9 + rand() * 0.6), 0.8, 0.45);
  }
  return g;
}

function shrubPatch(rand) {
  const g = new GeometryBuilder();
  for (let i = 0; i < 2; i++) {
    const x = i * 1.6 - 0.8 + (rand() - 0.5) * 0.4;
    const z = (rand() - 0.5) * 1.2;
    const s = 0.8 + rand() * 0.4;
    for (let k = 0; k < 3; k++) card(g, CELLS.shrub, x, z, (k * Math.PI) / 3 + rand() * 0.4, 1.25 * s, 0.9 * s);
  }
  return g;
}

// A palm crown: fronds arching out and drooping from the top of the trunk
// (the origin), each a strip of four pieces.
function palmCrown(rand) {
  const g = new GeometryBuilder();
  const fronds = 11;
  for (let k = 0; k < fronds; k++) {
    const yaw = (k / fronds) * Math.PI * 2 + rand() * 0.35;
    const len = 3.2 + rand() * 1.1;
    const lift = 0.7 - rand() * 0.35; // how steeply it starts upwards
    const dir = [Math.cos(yaw), Math.sin(yaw)];
    const side = [-dir[1], dir[0]];
    let p = [0, 0, 0];
    const steps = 4;
    for (let s = 0; s < steps; s++) {
      const t0 = s / steps;
      const t1 = (s + 1) / steps;
      const a = lift - 1.9 * t1;
      const step = len / steps;
      const q = [p[0] + dir[0] * Math.cos(a) * step, p[1] + Math.sin(a) * step, p[2] + dir[1] * Math.cos(a) * step];
      // A slight V across the frond, as real ones fold along the stem.
      const w0 = 0.5 * (1 - t0 * 0.5);
      const w1 = 0.5 * (1 - t1 * 0.5);
      const corner = (c, w, sgn) => [c[0] + side[0] * w * sgn, c[1] - w * 0.25, c[2] + side[1] * w * sgn];
      const up = [0, 1, 0];
      g.addQuad(corner(p, w0, -1), corner(q, w1, -1), corner(q, w1, 1), corner(p, w0, 1), up, uvOf(CELLS.frond, t0, 0.02), uvOf(CELLS.frond, t1, 0.02), uvOf(CELLS.frond, t1, 0.98), uvOf(CELLS.frond, t0, 0.98), [up, up, up, up]);
      p = q;
    }
  }
  return g;
}

// --- Placing them --------------------------------------------------------------

const sectorKey = (x, z) => `${Math.floor(x / SECTOR)}_${Math.floor(z / SECTOR)}`;

// One thin-instanced copy of `template` per sector, hidden beyond SHOW_WITHIN.
function instanceSectors(template, items, meshes) {
  const groups = new Map();
  for (const it of items) {
    const k = sectorKey(it.x, it.z);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  for (const [k, list] of groups) {
    const mesh = template.clone(`${template.name}_${k}`);
    mesh.makeGeometryUnique();
    const mats = new Float32Array(list.length * 16);
    const cols = new Float32Array(list.length * 4);
    list.forEach((it, i) => {
      Matrix.Compose(new Vector3(it.s, it.s, it.s), Quaternion.RotationYawPitchRoll(it.yaw, 0, 0), new Vector3(it.x, it.y - 0.04, it.z)).copyToArray(mats, i * 16);
      cols.set(it.color, i * 4);
    });
    mesh.thinInstanceSetBuffer("matrix", mats, 16, true);
    mesh.thinInstanceSetBuffer("color", cols, 4, true);
    mesh.thinInstanceRefreshBoundingInfo(true);
    mesh.isPickable = false;
    // (Shadows on them cost more than they show: they are small and mostly in the open.)
    mesh.receiveShadows = false;
    mesh.freezeWorldMatrix();
    mesh.addLODLevel(SHOW_WITHIN, null);
    meshes.push(mesh);
  }
  template.setEnabled(false);
}

const awayFromLandmarks = (x, z, gap) => ISLANDS.every((isl) => isl.landmarks.every((lm) => Math.hypot(x - lm.x, z - lm.z) > (lm.base ?? 30) / 2 + gap));

// Where the palms go: three groups of four to seven just outside each desert
// town, on flat open ground clear of the roads. (Its own random numbers, so
// the palms stay put whatever else changes.)
export function planPalms(world) {
  const rand = mulberry32(6161);
  const palms = [];
  const palmSpot = (x, z, roadGap) =>
    world.getRoadDistance(x, z) > ROAD_HALF_WIDTH + roadGap &&
    world.deckHeight(x, z) === null &&
    !inTown(x, z, 4) &&
    world.isClear(x, z) &&
    awayFromLandmarks(x, z, 20) &&
    world.getHeight(x, z) > 3.5 &&
    world.getNormal(x, z, 2)[1] > 0.9;
  for (const def of ISLANDS.filter((d) => d.climate === "desert")) {
    for (const t of def.towns) {
      let groups = 0;
      for (let tries = 0; tries < 120 && groups < 3; tries++) {
        // Somewhere just outside the town's edge, clear of the other groups.
        const a = rand() * Math.PI * 2;
        const out = 25 + rand() * 80;
        const gx = t.cx + Math.cos(a) * (t.hx + out);
        const gz = t.cz + Math.sin(a) * (t.hz + out);
        if (!palmSpot(gx, gz, 12) || palms.some((p) => Math.hypot(p.x - gx, p.z - gz) < 70)) continue;
        const want = 4 + Math.floor(rand() * 4);
        let made = 0;
        for (let k = 0; k < want * 5 && made < want; k++) {
          const x = gx + (rand() - 0.5) * 24;
          const z = gz + (rand() - 0.5) * 24;
          if (!palmSpot(x, z, 4) || palms.some((p) => Math.hypot(p.x - x, p.z - z) < 3.5)) continue;
          palms.push({ x, z, y: world.getHeight(x, z) });
          made++;
        }
        if (made) groups++;
      }
    }
  }
  return palms;
}

// trunk: the broadleaf trunk from nature.js, reused for the palms.
export function buildGroundCover(scene, world, colliders, quality, trunk) {
  const rand = mulberry32(5150); // its own, so the trees don't move
  const atlas = coverAtlas(scene, rand);
  const plantMat = coverMaterial(scene, "groundCover", atlas, { reach: 0.6, bend: 0.22 });
  const frondMat = coverMaterial(scene, "palmFronds", atlas, { reach: 4, bend: 0.3, radial: true });
  const meshes = [];
  const casters = [];

  // --- Clumps beside the country roads (none on Low) ---
  const kinds = { grass: [], bush: [], shrub: [] };
  if (quality.cover > 0) {
    // Every road sample out in the country, per island.
    const perIsland = new Map();
    for (const road of world.network.roads) {
      if (road.style || !road.island) continue;
      const list = perIsland.get(road.island) ?? [];
      for (let i = 0; i < road.count; i++) {
        const [x, z] = road.points[i];
        if (!road.bridge[i] && !inTown(x, z, 20)) list.push([road, i]);
      }
      perIsland.set(road.island, list);
    }
    // Shared out by road length; the desert's shrubs are sparser.
    const weight = (id) => (perIsland.get(id)?.length ?? 0) * (world.islandById(id).def.climate === "desert" ? 0.6 : 1);
    const total = ISLANDS.reduce((s, d) => s + weight(d.id), 0);
    for (const def of ISLANDS) {
      const list = perIsland.get(def.id);
      if (!list?.length) continue;
      const desert = def.climate === "desert";
      const want = Math.round((quality.cover * weight(def.id)) / total);
      let made = 0;
      for (let tries = 0; tries < want * 8 && made < want; tries++) {
        const [road, i] = list[Math.floor(rand() * list.length)];
        const [px, pz] = road.points[i];
        const [tx, tz] = road.tangents[i];
        const side = rand() < 0.5 ? -1 : 1;
        // Most close to the road, where they're seen; a few further out.
        const w = ROAD_HALF_WIDTH + 2.2 + Math.pow(rand(), 2.8) * (REACH - 2.2);
        const u = (rand() - 0.5) * 2;
        const x = px + tz * side * w + tx * u;
        const z = pz - tx * side * w + tz * u;
        if (world.getRoadDistance(x, z) < ROAD_HALF_WIDTH + 2 || world.deckHeight(x, z) !== null) continue;
        if (inTown(x, z, 6) || !world.isClear(x, z) || !awayFromLandmarks(x, z, 12)) continue;
        const y = world.getHeight(x, z);
        if (y < 3.6) continue; // beach or water
        if (world.getNormal(x, z, 1.5)[1] < 0.82) continue; // bare rock
        const shade = 0.85 + rand() * 0.3;
        let kind;
        let color;
        if (desert) {
          kind = "shrub";
          color = [shade, shade * (0.95 + rand() * 0.08), shade * (0.9 + rand() * 0.1), 1];
        } else {
          const r = rand();
          const near = w < ROAD_HALF_WIDTH + 14;
          kind = r < (near ? 0.72 : 0.55) ? "grass" : "bush";
          // Drier and yellower higher up, like the ground.
          const dry = smoothstep(16, 36, y);
          color = [shade * lerp(0.95, 1.18, dry), shade * lerp(1.04, 1.02, dry), shade * lerp(0.85, 0.66, dry), 1];
        }
        kinds[kind].push({ x, y, z, s: 0.8 + rand() * 0.5, yaw: rand() * Math.PI * 2, color });
        made++;
      }
    }
    const shapes = { grass: grassPatch(rand), bush: bushShape(rand), shrub: shrubPatch(rand) };
    for (const [kind, items] of Object.entries(kinds)) {
      if (!items.length) continue;
      const template = shapes[kind].toMesh(`cover_${kind}`, scene);
      template.material = plantMat;
      instanceSectors(template, items, meshes);
    }
  }
  const cover = [...meshes];

  // --- Palm groups just outside the desert towns (every level) ---
  const palms = planPalms(world);
  if (palms.length && trunk) {
    const trunks = trunk.clone("palmTrunks");
    trunks.setEnabled(true);
    trunks.makeGeometryUnique();
    const prand = mulberry32(6262);
    const crown = palmCrown(prand).toMesh("palmCrowns", scene);
    crown.material = frondMat;
    const trunkMats = new Float32Array(palms.length * 16);
    const trunkCols = new Float32Array(palms.length * 4);
    const crownMats = new Float32Array(palms.length * 16);
    const crownCols = new Float32Array(palms.length * 4);
    palms.forEach((p, i) => {
      // Tall, thin and leaning a little: the broadleaf trunk stretched.
      const yaw = prand() * Math.PI * 2;
      const lean = 0.04 + prand() * 0.16;
      const m = Matrix.Compose(new Vector3(0.68, 1.35 + prand() * 0.4, 0.68), Quaternion.RotationYawPitchRoll(yaw, lean, 0), new Vector3(p.x, p.y - 0.1, p.z));
      m.copyToArray(trunkMats, i * 16);
      trunkCols.set([0.98, 0.92, 0.8, 1], i * 4);
      const top = Vector3.TransformCoordinates(new Vector3(0, 4.85, 0), m);
      const s = 0.85 + prand() * 0.3;
      Matrix.Compose(new Vector3(s, s, s), Quaternion.RotationYawPitchRoll(prand() * Math.PI * 2, lean * 0.4, 0), top).copyToArray(crownMats, i * 16);
      const g = 0.85 + prand() * 0.25;
      crownCols.set([g, g, g * 0.9, 1], i * 4);
      colliders.addCircle(p.x, p.z, 0.3);
    });
    for (const [mesh, mats, cols] of [[trunks, trunkMats, trunkCols], [crown, crownMats, crownCols]]) {
      mesh.thinInstanceSetBuffer("matrix", mats, 16, true);
      mesh.thinInstanceSetBuffer("color", cols, 4, true);
      mesh.thinInstanceRefreshBoundingInfo(true);
      mesh.isPickable = false;
      mesh.receiveShadows = true;
      mesh.freezeWorldMatrix();
      meshes.push(mesh);
      casters.push(mesh);
    }
  }

  return {
    meshes,
    casters,
    counts: { clumps: cover.reduce((n, m) => n + m.thinInstanceCount, 0), sectors: cover.length, palms: palms.length },
    // Off when the game drops to the Low setting while running.
    setEnabled(on) {
      for (const m of cover) m.setEnabled(on);
    },
  };
}
