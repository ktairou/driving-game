import { DynamicTexture, PBRMaterial, Texture, MeshBuilder, Mesh, Matrix, Quaternion, Vector3 } from "@babylonjs/core";
import { GeometryBuilder } from "../geom.js";
import { mulberry32 } from "../noise.js";
import { surfaceMaterial, plainMaterial, rgb } from "./materials.js";
import { ISLANDS, ROAD_HALF_WIDTH } from "./layout.js";

const BAY = 3.5; // metres per window bay
const FLOOR = 3.4; // metres per storey
const TEX_BAYS = 4; // each facade texture holds 4 bays x 2 storeys
const TEX_FLOORS = 2;
const SIDEWALK = 4;
const BUILD_LINE = ROAD_HALF_WIDTH + SIDEWALK + 0.6;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function facadeMaterial(scene, name, albedo, orm) {
  albedo.update(true);
  orm.update(true);
  for (const t of [albedo, orm]) {
    // Dynamic textures clamp by default; the facade must repeat up and along walls.
    t.wrapU = Texture.WRAP_ADDRESSMODE;
    t.wrapV = Texture.WRAP_ADDRESSMODE;
    t.anisotropicFilteringLevel = 4;
  }
  orm.gammaSpace = false;
  const m = new PBRMaterial(name, scene);
  m.albedoTexture = albedo;
  m.metallicTexture = orm;
  m.useAmbientOcclusionFromMetallicTextureRed = true;
  m.useRoughnessFromMetallicTextureGreen = true;
  m.useMetallnessFromMetallicTextureBlue = true;
  m.metallic = 1;
  m.roughness = 1;
  return m;
}

// Paints a facade (wall + windows) and a matching roughness map on canvases.
// `win` sets window width and height as a share of the bay / storey.
function paintFacade(scene, name, wallImg, wallTint, frameColor, seed, win = [0.6, 0.58]) {
  const W = 1024;
  const H = 512;
  const rand = mulberry32(seed);
  const albedo = new DynamicTexture(`${name}_albedo`, { width: W, height: H }, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
  const orm = new DynamicTexture(`${name}_orm`, { width: W, height: H }, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
  const a = albedo.getContext();
  const o = orm.getContext();

  // Wall: photo texture tiled (one tile is about 2.3 m of wall), then tinted.
  const tile = 170;
  for (let y = 0; y < H; y += tile) for (let x = 0; x < W; x += tile) a.drawImage(wallImg, x, y, tile, tile);
  a.globalCompositeOperation = "multiply";
  a.fillStyle = wallTint;
  a.fillRect(0, 0, W, H);
  a.globalCompositeOperation = "source-over";
  o.fillStyle = "rgb(255, 225, 0)";
  o.fillRect(0, 0, W, H);

  const bayPx = W / TEX_BAYS;
  const floorPx = H / TEX_FLOORS;
  for (let f = 0; f < TEX_FLOORS; f++) {
    a.fillStyle = "rgba(0,0,0,0.18)";
    a.fillRect(0, f * floorPx, W, 10);
    for (let b = 0; b < TEX_BAYS; b++) {
      const w = bayPx * win[0];
      const h = floorPx * win[1];
      const x = b * bayPx + (bayPx - w) / 2;
      const y = f * floorPx + floorPx * 0.2;
      a.fillStyle = frameColor;
      a.fillRect(x - 9, y - 9, w + 18, h + 18);
      o.fillStyle = "rgb(255, 130, 0)";
      o.fillRect(x - 9, y - 9, w + 18, h + 18);
      const g = a.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0, "#5d6f7d");
      g.addColorStop(1, "#1b242c");
      a.fillStyle = g;
      a.fillRect(x, y, w, h);
      o.fillStyle = "rgb(255, 18, 0)";
      o.fillRect(x, y, w, h);
      if (rand() < 0.45) {
        const bh = h * (0.15 + rand() * 0.6);
        a.fillStyle = rand() < 0.5 ? "#cfc6b4" : "#8f857a";
        a.fillRect(x, y, w, bh);
        o.fillStyle = "rgb(255, 210, 0)";
        o.fillRect(x, y, w, bh);
      }
      a.fillStyle = frameColor;
      a.fillRect(x + w / 2 - 4, y, 8, h);
      a.fillStyle = "rgba(235,232,225,0.95)";
      a.fillRect(x - 14, y + h + 9, w + 28, 12);
    }
  }
  return facadeMaterial(scene, name, albedo, orm);
}

// Office-tower curtain wall: glass panels with thin metal mullions.
function paintGlass(scene, name, glassTop, glassBottom, mullion, seed) {
  const W = 1024;
  const H = 512;
  const rand = mulberry32(seed);
  const albedo = new DynamicTexture(`${name}_albedo`, { width: W, height: H }, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
  const orm = new DynamicTexture(`${name}_orm`, { width: W, height: H }, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
  const a = albedo.getContext();
  const o = orm.getContext();
  const bayPx = W / TEX_BAYS;
  const floorPx = H / TEX_FLOORS;
  for (let f = 0; f < TEX_FLOORS; f++) {
    for (let b = 0; b < TEX_BAYS; b++) {
      const g = a.createLinearGradient(0, f * floorPx, 0, (f + 1) * floorPx);
      g.addColorStop(0, glassTop);
      g.addColorStop(1, glassBottom);
      a.fillStyle = g;
      a.fillRect(b * bayPx, f * floorPx, bayPx, floorPx);
      if (rand() < 0.2) {
        a.fillStyle = "rgba(230,225,210,0.35)";
        a.fillRect(b * bayPx, f * floorPx + floorPx * 0.75, bayPx, floorPx * 0.25);
      }
    }
  }
  o.fillStyle = "rgb(255, 14, 40)";
  o.fillRect(0, 0, W, H);
  a.fillStyle = mullion;
  o.fillStyle = "rgb(255, 90, 200)";
  for (let b = 0; b <= TEX_BAYS; b++) {
    a.fillRect(b * bayPx - 5, 0, 10, H);
    o.fillRect(b * bayPx - 5, 0, 10, H);
  }
  for (let f = 0; f <= TEX_FLOORS; f++) {
    a.fillRect(0, f * floorPx - 14, W, 28);
    o.fillRect(0, f * floorPx - 14, W, 28);
  }
  return facadeMaterial(scene, name, albedo, orm);
}

function addBox(g, x0, x1, z0, z1, y0, y1, ground) {
  const walls = [
    [[x0, z0], [x1, z0], [0, 0, -1]],
    [[x1, z0], [x1, z1], [1, 0, 0]],
    [[x1, z1], [x0, z1], [0, 0, 1]],
    [[x0, z1], [x0, z0], [-1, 0, 0]],
  ];
  for (const [a, b, n] of walls) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const u1 = len / (BAY * TEX_BAYS);
    const v0 = (y0 - ground) / (FLOOR * TEX_FLOORS);
    const v1 = (y1 - ground) / (FLOOR * TEX_FLOORS);
    g.addQuad([a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]], n, [0, v0], [u1, v0], [u1, v1], [0, v1]);
  }
}

function addRoof(g, x0, x1, z0, z1, y) {
  g.addQuad([x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1], [0, 1, 0], [x0 / 6, z0 / 6], [x1 / 6, z0 / 6], [x1 / 6, z1 / 6], [x0 / 6, z1 / 6]);
}

// Sloped "mansard" roof like Paris buildings: four faces leaning inward.
function addMansard(g, x0, x1, z0, z1, y, h, inset) {
  const X0 = x0 + inset;
  const X1 = x1 - inset;
  const Z0 = z0 + inset;
  const Z1 = z1 - inset;
  const t = y + h;
  const faces = [
    [[x0, y, z0], [x1, y, z0], [X1, t, Z0], [X0, t, Z0], [0, 0.5, -1]],
    [[x1, y, z0], [x1, y, z1], [X1, t, Z1], [X1, t, Z0], [1, 0.5, 0]],
    [[x1, y, z1], [x0, y, z1], [X0, t, Z1], [X1, t, Z1], [0, 0.5, 1]],
    [[x0, y, z1], [x0, y, z0], [X0, t, Z0], [X0, t, Z1], [-1, 0.5, 0]],
  ];
  for (const [p0, p1, p2, p3, n] of faces) g.addQuad(p0, p1, p2, p3, n, [0, 0], [3, 0], [3, 1], [0, 1]);
  addRoof(g, X0, X1, Z0, Z1, t);
}

const STYLES = {
  british: { floors: [2, 7], depth: [14, 26], width: [13, 29] },
  paris: { floors: [5, 6], depth: [16, 22], width: [18, 30], mansard: true },
  city: { floors: [6, 34], depth: [20, 30], width: [20, 34] },
  desert: { floors: [1, 3], depth: [10, 16], width: [9, 18] },
};

export async function buildTown(scene, world, colliders) {
  const [plaster, brick] = await Promise.all([loadImage("assets/textures/plaster_color.webp"), loadImage("assets/textures/brick_color.webp")]);
  const facades = {
    british: [
      paintFacade(scene, "facade_cream", plaster, "#fff8ea", "#e9e6df", 1),
      paintFacade(scene, "facade_brick", brick, "#f0e4dc", "#efece6", 2),
      paintFacade(scene, "facade_slate", plaster, "#b9c2ca", "#2c3034", 3),
      paintFacade(scene, "facade_sand", plaster, "#f2dcc0", "#f2efe9", 4),
    ],
    paris: [
      paintFacade(scene, "facade_paris1", plaster, "#f3e7cf", "#e8e1d2", 5, [0.46, 0.66]),
      paintFacade(scene, "facade_paris2", plaster, "#ecdcc0", "#ded7c8", 6, [0.46, 0.66]),
    ],
    city: [
      paintGlass(scene, "glass_blue", "#6f8aa3", "#20303f", "#c9ced3", 7),
      paintGlass(scene, "glass_dark", "#4b5966", "#151c23", "#8e959c", 8),
      paintFacade(scene, "facade_office", plaster, "#cfd3d6", "#3a4046", 9, [0.78, 0.6]),
    ],
    desert: [
      paintFacade(scene, "facade_mud", plaster, "#e8c99a", "#7a5a3a", 10, [0.3, 0.42]),
      paintFacade(scene, "facade_white", plaster, "#fbf3e3", "#6b8aa0", 11, [0.3, 0.42]),
    ],
  };
  const roofMat = surfaceMaterial(scene, "roof", "pavers", { tint: rgb(0.55, 0.55, 0.56) });
  const slate = plainMaterial(scene, "slateRoof", rgb(0.24, 0.26, 0.29), { metallic: 0.2, roughness: 0.55 });
  const paversMat = surfaceMaterial(scene, "pavers", "pavers", { tint: rgb(0.78, 0.84, 0.92) });

  const builders = new Map();
  const builder = (mat) => {
    if (!builders.has(mat)) builders.set(mat, new GeometryBuilder());
    return builders.get(mat);
  };
  const lampMatrices = [];
  const pavementSpots = [];

  for (const isl of ISLANDS) {
    const t = isl.town;
    const st = STYLES[t.style];
    const set = facades[t.style];
    const rand = mulberry32(isl.seed * 97);
    const ground = t.height;
    const { x0: sx0, x1: sx1, z: sz } = t.street;
    const reserved = isl.landmarks.map((lm) => {
      const r = (lm.base ?? 30) / 2 + 8;
      return [lm.x - r, lm.x + r, lm.z - r, lm.z + r];
    });
    // Side streets through town: keep buildings, pavement and lamps off them.
    const sideSamples = [];
    for (const r of world.network.roads) {
      if (r.id === isl.id) continue;
      for (const [x, z] of r.points) if (Math.abs(x - t.cx) < t.hx + 40 && Math.abs(z - t.cz) < t.hz + 40) sideSamples.push([x, z]);
    }
    const crossXs = sideSamples.filter(([, z]) => Math.abs(z - sz) < 12).map(([x]) => x);
    const onSideStreet = (x, pad) => crossXs.some((cx) => Math.abs(cx - x) < pad);
    const blocked = (a0, a1, b0, b1) =>
      reserved.some(([x0, x1, z0, z1]) => a1 > x0 && a0 < x1 && b1 > z0 && b0 < z1) ||
      sideSamples.some(([x, z]) => x > a0 - 8 && x < a1 + 8 && z > b0 - 8 && z < b1 + 8);

    for (const side of [-1, 1]) {
      let x = sx0 - 5 + rand() * 6;
      while (x < sx1 + 10) {
        const width = st.width[0] + rand() * (st.width[1] - st.width[0]);
        const xe = Math.min(x + width, sx1 + 15);
        const depth = st.depth[0] + rand() * (st.depth[1] - st.depth[0]);
        const zNear = sz + side * BUILD_LINE;
        const zFar = sz + side * (BUILD_LINE + depth);
        const zA = Math.min(zNear, zFar);
        const zB = Math.max(zNear, zFar);
        if (rand() < 0.1 || blocked(x, xe, zA, zB)) {
          x = xe + 6;
          continue;
        }
        const centre = 1 - Math.min(1, Math.abs((x + xe) / 2 - (sx0 + sx1) / 2) / ((sx1 - sx0) / 2));
        const span = st.floors[1] - st.floors[0];
        const floors = Math.max(st.floors[0], Math.round(st.floors[0] + span * (t.style === "city" ? centre * centre * (0.6 + rand() * 0.4) : rand() * 0.5 + centre * 0.5)));
        const top = ground + floors * FLOOR + 0.4;
        const mat = set[Math.floor(rand() * set.length)];
        addBox(builder(mat), x, xe, zA, zB, ground - 1, top, ground);
        if (st.mansard) addMansard(builder(slate), x, xe, zA, zB, top, 4.2, 2.2);
        else addRoof(builder(roofMat), x, xe, zA, zB, top);
        colliders.addBox((x + xe) / 2, (zA + zB) / 2, (xe - x) / 2, (zB - zA) / 2);
        x = xe + 3 + rand() * 7;
      }
    }

    // Pavements both sides of the main street.
    const walk = builder(paversMat);
    const curbH = 0.12;
    // Pavement pieces between side streets.
    const cuts = [...new Set(crossXs.map((x) => Math.round(x)))].sort((a, b) => a - b);
    const pieces = [];
    let from = sx0;
    for (const cx of cuts) {
      if (cx - 8 > from) pieces.push([from, cx - 8]);
      from = Math.max(from, cx + 8);
    }
    if (from < sx1) pieces.push([from, sx1]);
    for (const side of [-1, 1]) {
      const zi = sz + side * ROAD_HALF_WIDTH;
      const zo = sz + side * (ROAD_HALF_WIDTH + SIDEWALK + 2);
      const y = ground + 0.04 + curbH;
      const za = Math.min(zi, zo);
      const zb = Math.max(zi, zo);
      for (const [px0, px1] of pieces) {
        walk.addQuad([px0, y, za], [px1, y, za], [px1, y, zb], [px0, y, zb], [0, 1, 0], [px0 / 2, za / 2], [px1 / 2, za / 2], [px1 / 2, zb / 2], [px0 / 2, zb / 2]);
        walk.addQuad([px0, ground - 0.2, zi], [px1, ground - 0.2, zi], [px1, y, zi], [px0, y, zi], [0, 0, -side], [px0 / 2, 0], [px1 / 2, 0], [px1 / 2, 0.15], [px0 / 2, 0.15]);
        if (px1 - px0 > 20) pavementSpots.push({ island: isl.id, x0: px0 + 3, x1: px1 - 3, z: sz + side * (ROAD_HALF_WIDTH + 2.4), y });
      }
    }
    for (let x = sx0 + 10, k = 0; x < sx1 - 5; x += 32, k++) {
      if (onSideStreet(x, 10)) continue;
      const side = k % 2 === 0 ? 1 : -1;
      const z = sz + side * (ROAD_HALF_WIDTH + 0.8);
      const yaw = side > 0 ? Math.PI : 0;
      lampMatrices.push(Matrix.Compose(Vector3.One(), Quaternion.RotationYawPitchRoll(yaw, 0, 0), new Vector3(x, ground + 0.16, z)));
      colliders.addCircle(x, z, 0.2);
    }
  }

  const meshes = [];
  const casters = [];
  for (const [mat, g] of builders) {
    const m = g.toMesh(`town_${mat.name}`, scene);
    m.material = mat;
    meshes.push(m);
    if (mat !== paversMat) casters.push(m);
  }

  // --- Street lamps -------------------------------------------------------------
  const pole = MeshBuilder.CreateCylinder("lampPole", { height: 7.6, diameterTop: 0.12, diameterBottom: 0.2, tessellation: 10 }, scene);
  pole.position.y = 3.8;
  const arm = MeshBuilder.CreateBox("lampArm", { width: 0.1, height: 0.1, depth: 2.0 }, scene);
  arm.position.set(0, 7.5, 0.95);
  const head = MeshBuilder.CreateBox("lampHead", { width: 0.34, height: 0.14, depth: 0.7 }, scene);
  head.position.set(0, 7.42, 1.85);
  const lamp = Mesh.MergeMeshes([pole, arm, head], true, true);
  lamp.name = "lamps";
  lamp.material = plainMaterial(scene, "lampMetal", rgb(0.16, 0.17, 0.18), { metallic: 0.6, roughness: 0.45 });
  const buf = new Float32Array(lampMatrices.length * 16);
  lampMatrices.forEach((m, i) => m.copyToArray(buf, i * 16));
  lamp.thinInstanceSetBuffer("matrix", buf, 16, true);
  casters.push(lamp);
  meshes.push(lamp);

  for (const m of meshes) {
    m.receiveShadows = true;
    m.isPickable = false;
    if (m !== lamp) m.freezeWorldMatrix();
  }
  return { meshes, casters, pavementSpots };
}
