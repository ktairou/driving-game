import { Mesh, MeshBuilder, Matrix, Quaternion, Vector3, PBRMaterial, VertexBuffer } from "@babylonjs/core";
import { GeometryBuilder, normalize, cross, add, sub, scale } from "../geom.js";
import { mulberry32, createNoise2D, fbm, smoothstep } from "../noise.js";
import { loadTexture, surfaceMaterial, rgb } from "./materials.js";
import { inTown } from "./road.js";
import { ROAD_HALF_WIDTH, ISLANDS } from "./layout.js";

const SECTOR = 900; // trees are grouped in 900 m squares so off-screen groups are skipped

// Image rectangles (pixels, 1024 atlas) of single sprigs in the leaf atlases.
// `stem` says which end of the rectangle the stem is on.
const BROAD_SPRIGS = [
  { x0: 160, y0: 25, x1: 1010, y1: 485, stem: "left" },
  { x0: 0, y0: 330, x1: 445, y1: 715, stem: "left" },
  { x0: 250, y0: 600, x1: 1024, y1: 1015, stem: "right" },
];
const FIR_SPRIGS = [
  { x0: 680, y0: 40, x1: 960, y1: 400, stem: "bottom" },
  { x0: 320, y0: 410, x1: 660, y1: 790, stem: "bottom" },
  { x0: 650, y0: 450, x1: 990, y1: 860, stem: "bottom" },
];

// Corner uvs for a card whose stem end is at the base: [baseL, baseR, tipR, tipL]
function sprigUVs(s) {
  const u0 = s.x0 / 1024;
  const u1 = s.x1 / 1024;
  const vTop = 1 - s.y0 / 1024;
  const vBot = 1 - s.y1 / 1024;
  switch (s.stem) {
    case "left": return [[u0, vBot], [u0, vTop], [u1, vTop], [u1, vBot]];
    case "right": return [[u1, vTop], [u1, vBot], [u0, vBot], [u0, vTop]];
    default: return [[u0, vBot], [u1, vBot], [u1, vTop], [u0, vTop]]; // bottom
  }
}

// A leaf card from `base` pointing along `dir`, normals bent toward `normalFrom`.
function addCard(g, base, dir, side, length, width, uvs, centre, roundness) {
  const tip = add(base, scale(dir, length));
  const hw = scale(side, width / 2);
  const p = [sub(base, hw), add(base, hw), add(tip, hw), sub(tip, hw)];
  const face = normalize(cross(dir, side));
  const ns = p.map((v) => normalize(add(scale(normalize(sub(v, centre)), roundness), scale(face, 1 - roundness))));
  const facing = face[1] < 0 ? scale(face, -1) : face;
  g.addQuad(p[0], p[1], p[2], p[3], facing, uvs[0], uvs[1], uvs[2], uvs[3], ns);
}

function randomUnit(rand) {
  const z = rand() * 2 - 1;
  const a = rand() * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  return [r * Math.cos(a), z, r * Math.sin(a)];
}

function broadleafTemplate(rand) {
  const g = new GeometryBuilder();
  const uvSets = BROAD_SPRIGS.map(sprigUVs);
  // A few overlapping leaf clumps make a fuller, less round crown.
  const clumps = [
    { c: [0, 5.6, 0], r: [3.4, 2.4, 3.4], n: 46 },
    { c: [1.6, 4.4, 0.8], r: [2.2, 1.8, 2.2], n: 18 },
    { c: [-1.4, 4.6, -1.2], r: [2.2, 1.8, 2.2], n: 18 },
    { c: [0.2, 7.2, -0.4], r: [2.2, 1.6, 2.2], n: 16 },
  ];
  const crown = [0, 5.4, 0];
  let k = 0;
  for (const cl of clumps) {
    for (let i = 0; i < cl.n; i++, k++) {
      let d = randomUnit(rand);
      if (d[1] < -0.5) d[1] *= -0.4; // fewer cards hanging straight down
      d = normalize(d);
      const r = 0.15 + rand() * 0.6;
      const base = [cl.c[0] + d[0] * cl.r[0] * r, cl.c[1] + d[1] * cl.r[1] * r, cl.c[2] + d[2] * cl.r[2] * r];
      const dir = normalize(add(d, [rand() * 0.7 - 0.35, rand() * 0.5 - 0.15, rand() * 0.7 - 0.35]));
      const side = normalize(cross(dir, randomUnit(rand)));
      const len = 2.2 + rand() * 1.3;
      addCard(g, base, dir, side, len, len * 0.6, uvSets[k % 3], crown, 0.75);
    }
  }
  return g;
}

function firTemplate(rand) {
  const g = new GeometryBuilder();
  const uvSets = FIR_SPRIGS.map(sprigUVs);
  const top = 11.5;
  for (let y = 1.8, w = 0; y < top - 0.6; y += 0.52, w++) {
    const t = (y - 1.8) / (top - 1.8);
    const len = (1 - t) * 3.3 + 0.5;
    const count = 9;
    const offset = rand() * Math.PI;
    for (let k = 0; k < count; k++) {
      const a = offset + (k / count) * Math.PI * 2 + rand() * 0.3;
      const dir = normalize([Math.cos(a), -0.22 - rand() * 0.12, Math.sin(a)]);
      const side = normalize(cross(dir, [0, 1, 0]));
      const base = [Math.cos(a) * 0.1, y, Math.sin(a) * 0.1];
      addCard(g, base, dir, side, len, Math.max(0.9, len * 0.7), uvSets[(w + k) % 3], [0, y - 1.0, 0], 0.65);
    }
  }
  // Tip
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI;
    const side = [Math.cos(a), 0, Math.sin(a)];
    addCard(g, [0, top - 1.4, 0], [0, 1, 0], side, 2.0, 0.9, uvSets[0], [0, top - 2.5, 0], 0.5);
  }
  return g;
}

function trunkMesh(scene, name, height, r0, r1) {
  const m = MeshBuilder.CreateCylinder(name, { height, diameterBottom: r0 * 2, diameterTop: r1 * 2, tessellation: 8 }, scene);
  m.bakeTransformIntoVertices(Matrix.Translation(0, height / 2 - 0.3, 0));
  return m;
}

function rockTemplate(scene, name, seed) {
  const m = MeshBuilder.CreateIcoSphere(name, { radius: 1, subdivisions: 3, flat: false }, scene);
  const noise = createNoise2D(seed);
  const pos = m.getVerticesData(VertexBuffer.PositionKind);
  for (let i = 0; i < pos.length; i += 3) {
    const [x, y, z] = [pos[i], pos[i + 1], pos[i + 2]];
    const n = 1 + fbm(noise, x * 1.3 + y * 0.7, z * 1.3 - y * 0.5, 3) * 0.35;
    pos[i] = x * n * 1.3;
    pos[i + 1] = y * n * 0.75;
    pos[i + 2] = z * n;
  }
  m.updateVerticesData(VertexBuffer.PositionKind, pos);
  m.createNormals(true);
  return m;
}

function sectorKey(x, z) {
  return `${Math.floor(x / SECTOR)}_${Math.floor(z / SECTOR)}`;
}

// Thin-instance a template once per sector so whole groups get culled.
function instanceBySector(template, items, makeMatrix, withColor) {
  const groups = new Map();
  for (const it of items) {
    const k = sectorKey(it.x, it.z);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  const meshes = [];
  for (const [k, list] of groups) {
    const mesh = template.clone(`${template.name}_${k}`);
    mesh.makeGeometryUnique();
    const mats = new Float32Array(list.length * 16);
    const cols = withColor ? new Float32Array(list.length * 4) : null;
    list.forEach((it, i) => {
      makeMatrix(it).copyToArray(mats, i * 16);
      if (cols) cols.set(it.color, i * 4);
    });
    mesh.thinInstanceSetBuffer("matrix", mats, 16, true);
    if (cols) mesh.thinInstanceSetBuffer("color", cols, 4, true);
    mesh.thinInstanceRefreshBoundingInfo(true);
    mesh.isPickable = false;
    mesh.receiveShadows = true;
    meshes.push(mesh);
  }
  template.setEnabled(false);
  return meshes;
}

export function buildNature(scene, world, colliders, quality) {
  const rand = mulberry32(4242);
  const forest = createNoise2D(77);

  // --- Pick spots, island by island ---------------------------------------------
  const totalShare = ISLANDS.reduce((s, i) => s + i.trees.share, 0);
  const awayFromLandmarks = (x, z) => ISLANDS.every((isl) => isl.landmarks.every((lm) => Math.hypot(x - lm.x, z - lm.z) > (lm.base ?? 30) / 2 + 20));
  const chosen = [];
  for (const island of world.islands) {
    const def = island.def;
    const spots = [];
    const spacing = 11;
    const lim = def.coast - 40;
    for (let z = def.cz - lim; z < def.cz + lim; z += spacing) {
      for (let x = def.cx - lim; x < def.cx + lim; x += spacing) {
        const px = x + (rand() - 0.5) * spacing * 0.9;
        const pz = z + (rand() - 0.5) * spacing * 0.9;
        const density = fbm(forest, px / 260, pz / 260, 3) * 0.5 + 0.5;
        if (rand() > smoothstep(0.42, 0.7, density)) continue;
        // Keep trunks and branches well clear of every road.
        if (world.getRoadDistance(px, pz) < ROAD_HALF_WIDTH + 10) continue;
        if (inTown(px, pz, 12) || !awayFromLandmarks(px, pz) || !world.isClear(px, pz)) continue;
        const y = world.getHeight(px, pz);
        if (y < 4) continue; // beach or water
        const n = world.getNormal(px, pz, 2);
        if (n[1] < 0.84) continue;
        spots.push({ x: px, z: pz, y, r: rand(), firAbove: def.trees.firAbove });
      }
    }
    // Shuffle then keep this island's share of the quality level's tree count.
    for (let i = spots.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [spots[i], spots[j]] = [spots[j], spots[i]];
    }
    chosen.push(...spots.slice(0, Math.round((quality.trees * def.trees.share) / totalShare)));
  }
  const broad = [];
  const firs = [];
  for (const s of chosen) {
    const isFir = s.y > s.firAbove || (s.y > s.firAbove * 0.5 && s.r < 0.45);
    const scl = (isFir ? 0.8 : 0.75) + rand() * 0.55;
    const tint = 0.82 + rand() * 0.3;
    const item = { x: s.x, z: s.z, y: s.y, s: scl, yaw: rand() * Math.PI * 2, color: [tint * (0.92 + rand() * 0.12), tint, tint * (0.85 + rand() * 0.1), 1] };
    (isFir ? firs : broad).push(item);
    colliders.addCircle(s.x, s.z, 0.35 * scl);
  }

  // --- Materials ---------------------------------------------------------------
  const leafMat = (name, file) => {
    const m = new PBRMaterial(name, scene);
    m.albedoTexture = loadTexture(scene, file, { hasAlpha: true });
    m.useAlphaFromAlbedoTexture = true;
    m.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST;
    m.alphaCutOff = 0.45;
    m.backFaceCulling = false;
    m.metallic = 0;
    m.roughness = 0.75;
    m.albedoColor = rgb(1.0, 1.0, 1.0);
    return m;
  };
  const broadLeaves = leafMat("leavesBroad", "leaves_broad");
  const firLeaves = leafMat("leavesFir", "leaves_fir");
  const bark = surfaceMaterial(scene, "bark", "bark", { bump: 0.8 });
  bark.albedoTexture.vScale = 3;
  bark.bumpTexture.vScale = 3;
  bark.metallicTexture.vScale = 3;

  // --- Templates ---------------------------------------------------------------
  const broadCanopy = broadleafTemplate(rand).toMesh("broadCanopy", scene);
  broadCanopy.material = broadLeaves;
  const broadTrunk = trunkMesh(scene, "broadTrunk", 5.2, 0.32, 0.14);
  broadTrunk.material = bark;
  const firCanopy = firTemplate(rand).toMesh("firCanopy", scene);
  firCanopy.material = firLeaves;
  const firTrunk = trunkMesh(scene, "firTrunk", 11.6, 0.28, 0.05);
  firTrunk.material = bark;

  const treeMatrix = (it) =>
    Matrix.Compose(new Vector3(it.s, it.s, it.s), Quaternion.RotationYawPitchRoll(it.yaw, 0, 0), new Vector3(it.x, it.y - 0.1, it.z));

  const meshes = [
    ...instanceBySector(broadCanopy, broad, treeMatrix, true),
    ...instanceBySector(broadTrunk, broad, treeMatrix, false),
    ...instanceBySector(firCanopy, firs, treeMatrix, true),
    ...instanceBySector(firTrunk, firs, treeMatrix, false),
  ];

  // --- Rocks ---------------------------------------------------------------------
  const rockMat = surfaceMaterial(scene, "boulder", "rock", { tint: rgb(0.85, 0.83, 0.8) });
  rockMat.albedoTexture.uScale = rockMat.albedoTexture.vScale = 2;
  const rockTemplates = [0, 1, 2].map((i) => {
    const r = rockTemplate(scene, `rock${i}`, 300 + i);
    r.material = rockMat;
    return r;
  });
  const rockItems = [[], [], []];
  let placed = 0;
  for (const island of world.islands) {
    const def = island.def;
    // Deserts get a bigger share of rocks to make up for having few trees.
    const want = Math.round((quality.rocks / ISLANDS.length) * (def.climate === "desert" ? 1.8 : 0.9));
    let made = 0;
    for (let tries = 0; tries < want * 14 && made < want; tries++) {
      const x = def.cx + (rand() * 2 - 1) * (def.coast - 40);
      const z = def.cz + (rand() * 2 - 1) * (def.coast - 40);
      const d = world.getRoadDistance(x, z);
      const s = 0.5 + Math.pow(rand(), 2) * 3.2;
      if (d < ROAD_HALF_WIDTH + 4 + s * 1.4 || inTown(x, z, 5) || !awayFromLandmarks(x, z) || !world.isClear(x, z)) continue;
      const y = world.getHeight(x, z);
      if (y < 1) continue;
      const n = world.getNormal(x, z, 2);
      // Rocks like slopes and road cuttings (and open desert).
      if (n[1] > 0.93 && rand() > (def.climate === "desert" ? 0.5 : 0.15)) continue;
      const it = { x, z, y: y - s * 0.35, s, yaw: rand() * Math.PI * 2, tilt: (rand() - 0.5) * 0.4 };
      rockItems[placed % 3].push(it);
      if (s > 1.1) colliders.addCircle(x, z, s * 1.0);
      placed++;
      made++;
    }
  }
  const rockMatrix = (it) =>
    Matrix.Compose(new Vector3(it.s, it.s, it.s), Quaternion.RotationYawPitchRoll(it.yaw, it.tilt, it.tilt * 0.5), new Vector3(it.x, it.y, it.z));
  rockTemplates.forEach((t, i) => meshes.push(...instanceBySector(t, rockItems[i], rockMatrix, false)));

  return { meshes, casters: meshes, counts: { broad: broad.length, firs: firs.length, rocks: placed } };
}
