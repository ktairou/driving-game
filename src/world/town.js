import { PBRMaterial, MeshBuilder, Mesh, Matrix, Quaternion, Vector3, Color3 } from "@babylonjs/core";
import { GeometryBuilder } from "../geom.js";
import { mulberry32 } from "../noise.js";
import { surfaceMaterial, plainMaterial, rgb } from "./materials.js";
import { ISLANDS, ROAD_HALF_WIDTH } from "./layout.js";
import { buildFacades, roofTileTexture, detailTexture, GROUND } from "./facades.js";
import { buildFront, buildBack } from "./buildings.js";
import { buildStreetFurniture } from "./streetFurniture.js";

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

// Average colour of a photo (0..1 per channel, as stored).
function photoAverage(img) {
  const c = document.createElement("canvas");
  c.width = c.height = 8;
  const x = c.getContext("2d");
  x.drawImage(img, 0, 0, 8, 8);
  const d = x.getImageData(0, 0, 8, 8).data;
  const avg = [0, 0, 0];
  for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) avg[k] += d[i + k] / 255 / 64;
  return avg;
}

const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

// The second row behind each main street: lot sizes and storeys by style.
const BACK_ROW = {
  british: { width: [7, 10], depth: [7, 9], floors: [2, 2] },
  paris: { width: [13, 19], depth: [10, 13], floors: [3, 4] },
  city: { width: [13, 21], depth: [11, 15], floors: [2, 4] },
  desert: { width: [8, 12], depth: [8, 11], floors: [1, 2] },
};

const STYLES = {
  british: { floors: [2, 7], depth: [14, 26], width: [13, 29] },
  paris: { floors: [5, 6], depth: [16, 22], width: [18, 30], mansard: true },
  city: { floors: [6, 34], depth: [20, 30], width: [20, 34] },
  desert: { floors: [1, 3], depth: [10, 16], width: [9, 18] },
};

export async function buildTown(scene, world, colliders) {
  const [plaster, brick, stone] = await Promise.all(["plaster", "brick", "sandstone"].map((n) => loadImage(`assets/textures/${n}_color.webp`)));
  const facades = buildFacades(scene, { plaster, brick, stone });
  const roofMat = surfaceMaterial(scene, "roof", "pavers", { tint: rgb(0.55, 0.55, 0.56) });
  const paversMat = surfaceMaterial(scene, "pavers", "pavers", { tint: rgb(0.78, 0.84, 0.92) });

  // Roof tiles, plain parts and small details shared by all the buildings.
  // Colours that differ from part to part (clay or slate tiles, a white dome,
  // a wooden tank) are vertex colours, so each material is one draw for all.
  const tiles = new PBRMaterial("roofTiles", scene);
  tiles.albedoTexture = roofTileTexture(scene);
  tiles.metallic = 0;
  tiles.roughness = 0.72;
  const painted = plainMaterial(scene, "roofThings", rgb(1, 1, 1), { metallic: 0.25, roughness: 0.6 });
  const details = detailTexture(scene);
  const detailMat = (name, seeThrough) => {
    const m = new PBRMaterial(name, scene);
    m.albedoTexture = details;
    m.metallic = 0;
    m.roughness = 0.75;
    // Awnings and signs are seen from below, railings from both sides.
    m.backFaceCulling = false;
    m.twoSidedLighting = true;
    if (seeThrough) {
      m.useAlphaFromAlbedoTexture = true;
      m.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST;
      m.alphaCutOff = 0.5;
    } else m.transparencyMode = PBRMaterial.PBRMATERIAL_OPAQUE;
    return m;
  };
  const redLight = plainMaterial(scene, "mastLight", rgb(0.5, 0.04, 0.03), { roughness: 0.4 });
  redLight.emissiveColor = new Color3(1, 0.06, 0.03); // aircraft warning light, on day and night
  // Each entry is a material, or { mat, tint } for a vertex-coloured one.
  const mats = {
    flatRoof: roofMat,
    clay: { mat: tiles, tint: [0.66, 0.33, 0.22] },
    slate: { mat: tiles, tint: [0.3, 0.32, 0.36] },
    zinc: { mat: tiles, tint: [0.44, 0.48, 0.53] },
    lead: { mat: painted, tint: [0.22, 0.23, 0.25] },
    metal: { mat: painted, tint: [0.45, 0.46, 0.47] },
    door: { mat: painted, tint: [0.42, 0.42, 0.4] },
    backDoor: { mat: painted, tint: [0.2, 0.15, 0.11] },
    tank: { mat: painted, tint: [0.86, 0.86, 0.83] },
    tankWood: { mat: painted, tint: [0.34, 0.24, 0.16] },
    dome: { mat: painted, tint: [0.9, 0.88, 0.84] },
    wood: { mat: painted, tint: [0.36, 0.24, 0.14] },
    redLight,
    details: detailMat("streetDetail", false),
    railing: detailMat("railings", true),
  };
  // Plain wall to match each facade (gables, chimneys, parapets, ledges): the
  // same photo the facade was painted from, coloured like the facade's wall.
  const photoAvg = { plaster: photoAverage(plaster), stone: photoAverage(stone) };
  const plainMats = {
    plaster: surfaceMaterial(scene, "plainWall", "plaster"),
    stone: surfaceMaterial(scene, "plainStone", "sandstone"),
  };
  mats.footing = { mat: plainMats.plaster, tint: [0.42, 0.4, 0.37] }; // stone base where the ground falls away
  const plainFor = ({ set, ti }) => {
    const kind = set.spec.wall === "stone" ? "stone" : "plaster";
    const tint = set.tints[ti];
    return { mat: plainMats[kind], tint: set.wallColour.map((v, k) => Math.min(1.4, (toLinear(v) / Math.max(0.05, toLinear(photoAvg[kind][k]))) * tint[k])) };
  };

  // One builder per material. Vertex colours run in stretches: each call to
  // paint() colours everything added to that builder until the next call.
  const builders = new Map();
  const builder = (mat) => {
    if (!builders.has(mat)) builders.set(mat, new GeometryBuilder());
    return builders.get(mat);
  };
  const fillColours = (g) => {
    if (!g.extra) return;
    const c = g.colour ?? [1, 1, 1];
    while (g.extra.data.length < g.vertexCount * 4) g.extra.data.push(c[0], c[1], c[2], 1);
  };
  const paint = (what, tint = null) => {
    if (what.mat) return paint(what.mat, what.tint);
    const g = builder(what);
    if (tint || g.extra) {
      g.extra ??= { name: "color", stride: 4, data: [] };
      fillColours(g);
      g.colour = tint ?? [1, 1, 1];
    }
    return g;
  };
  // What the building shapes (buildings.js) need.
  let shopUnits = [];
  const ctx = {
    g: paint,
    mats,
    ground: GROUND,
    plain: plainFor,
    glass: (rand) => ({ mat: facades.glass.mat, tint: facades.glass.tints[rand() < 0.55 ? 0 : 1] }),
    // A facade for one building: a random picture of the style (or the given
    // one), not the same as `avoid`, in a random colour variant.
    pick(style, rand, avoid = null, index) {
      const list = facades.sets[style];
      let set = index !== undefined ? list[index] : list[Math.floor(rand() * list.length)];
      if (index === undefined && avoid && set === avoid.set && list.length > 1) set = list[(list.indexOf(set) + 1) % list.length];
      const ti = Math.floor(rand() * set.tints.length);
      return { set, ti, mat: set.mat, tint: set.tints[ti] };
    },
    units(found, L) {
      for (const u of found) {
        const xa = u.wall.p[0] + u.wall.dx * u.a;
        const xb = u.wall.p[0] + u.wall.dx * u.b;
        shopUnits.push({ ...u, side: L.s, x0: Math.min(xa, xb), x1: Math.max(xa, xb) });
      }
    },
  };
  // Lowest ground under a lot (where a footing may be needed).
  const lowest = (x0, x1, z0, z1) => {
    let low = Infinity;
    for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) low = Math.min(low, world.getHeight(x0 + ((x1 - x0) * i) / 4, z0 + ((z1 - z0) * j) / 4));
    return low;
  };
  const lampMatrices = [];
  const pavementSpots = [];
  const parks = [];
  const roofs = []; // tops of tall buildings, for flags
  const streets = []; // main streets, for the things on their pavements

  for (const isl of ISLANDS) for (const [ti, t] of isl.towns.entries()) {
    const st = STYLES[t.style];
    const rand = mulberry32(isl.seed * 97 + ti * 13);
    shopUnits = [];
    let lot = 0;
    const ground = t.height;
    const { x0: sx0, x1: sx1, z: sz } = t.street;
    const reserved = isl.landmarks.map((lm) => {
      const r = (lm.base ?? 30) / 2 + 8;
      return [lm.x - r, lm.x + r, lm.z - r, lm.z + r];
    });
    // Side streets through town: keep buildings, pavement and lamps off them.
    const sideSamples = [];
    // (The road the main street is part of doesn't count.)
    const onStreet = (r) => r.points.filter(([x, z]) => x > sx0 && x < sx1 && Math.abs(z - sz) < 3).length;
    const mainRoad = world.network.roads.reduce((best, r) => (onStreet(r) > onStreet(best) ? r : best));
    for (const r of world.network.roads) {
      if (r === mainRoad) continue;
      for (const [x, z] of r.points) if (Math.abs(x - t.cx) < t.hx + 40 && Math.abs(z - t.cz) < t.hz + 40) sideSamples.push([x, z]);
    }
    const crossXs = sideSamples.filter(([, z]) => Math.abs(z - sz) < 12).map(([x]) => x);
    const onSideStreet = (x, pad) => crossXs.some((cx) => Math.abs(cx - x) < pad);
    const blocked = (a0, a1, b0, b1) =>
      reserved.some(([x0, x1, z0, z1]) => a1 > x0 && a0 < x1 && b1 > z0 && b0 < z1) ||
      sideSamples.some(([x, z]) => x > a0 - 8 && x < a1 + 8 && z > b0 - 8 && z < b1 + 8);

    // A big park beside the main street, in place of a row of buildings
    // (on the other side of the street from town to town).
    {
      const side = ti % 2 === 0 ? 1 : -1;
      const near = sz + side * (BUILD_LINE - 0.5);
      const far = sz + side * (BUILD_LINE + 95);
      const z0 = Math.min(near, far);
      const z1 = Math.max(near, far);
      const mid0 = (sx0 + sx1) / 2 + (rand() - 0.5) * (sx1 - sx0) * 0.2;
      // As big as fits: slide it along (and if need be shrink it) to keep it
      // clear of side streets and landmarks.
      let park = null;
      for (const width of [Math.min(170, (sx1 - sx0) * 0.38), 120, 90]) {
        for (let k = 0; k < 13 && !park; k++) {
          const mid = mid0 + (k % 2 ? -1 : 1) * Math.ceil(k / 2) * 22;
          if (mid - width / 2 < sx0 || mid + width / 2 > sx1) continue;
          if (onSideStreet(mid, width / 2 + 12) || blocked(mid - width / 2, mid + width / 2, z0, z1)) continue;
          park = { x0: mid - width / 2, x1: mid + width / 2, z0, z1, y: ground, side, street: sz, town: t, seed: isl.seed * 31 + ti };
        }
        if (park) break;
      }
      if (park) {
        reserved.push([park.x0, park.x1, park.z0, park.z1]);
        parks.push(park);
      }
    }

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
        // (This draw once picked the facade. It stays, so every lot after it
        // keeps its place; the building's looks come from its own generator.)
        rand();
        const L = { style: t.style, x0: x, x1: xe, zN: zNear, zF: zFar, s: side, y: ground, floors, low: lowest(x, xe, zA, zB), rand: mulberry32(isl.seed * 7919 + ti * 1013 + lot++ * 37) };
        const top = buildFront(ctx, L);
        roofs.push({ x: top.x, z: top.z, y: top.y, floors, island: isl.id });
        colliders.addBox((x + xe) / 2, (zA + zB) / 2, (xe - x) / 2, (zB - zA) / 2);
        x = xe + 3 + rand() * 7;
      }
    }

    // A sparser second row behind the first, so the town has depth from the
    // hills: smaller, lower buildings on the flat town ground, clear of parks,
    // landmarks (and the people strolling round them), side roads and stations.
    {
      const back = BACK_ROW[t.style];
      const r2 = mulberry32(isl.seed * 53 + ti * 17 + 999);
      const keepOut = isl.landmarks.map((lm) => {
        const r = (lm.base ?? 30) / 2 + 30;
        return [lm.x - r, lm.x + r, lm.z - r, lm.z + r];
      });
      const clear = (a0, a1, b0, b1) => {
        if (a0 < t.cx - t.hx + 4 || a1 > t.cx + t.hx - 4 || b0 < t.cz - t.hz + 4 || b1 > t.cz + t.hz - 4) return false;
        if (blocked(a0, a1, b0, b1) || keepOut.some(([x0, x1, z0, z1]) => a1 > x0 && a0 < x1 && b1 > z0 && b0 < z1)) return false;
        for (const [px, pz] of [[a0, b0], [a1, b0], [a0, b1], [a1, b1], [(a0 + a1) / 2, (b0 + b1) / 2]]) {
          if (world.getRoadDistance(px, pz) < ROAD_HALF_WIDTH + 5 || !world.isClear(px, pz)) return false;
        }
        return true;
      };
      for (const side of [-1, 1]) {
        let x = sx0 + r2() * 12;
        while (x < sx1) {
          const width = back.width[0] + r2() * (back.width[1] - back.width[0]);
          const depth = back.depth[0] + r2() * (back.depth[1] - back.depth[0]);
          const garage = t.style === "british" && r2() < 0.3;
          const w = garage ? 6 : width;
          const d = garage ? 6.5 : depth;
          const zNear = sz + side * (BUILD_LINE + st.depth[1] + 7);
          const zFar = zNear + side * d;
          const zA = Math.min(zNear, zFar);
          const zB = Math.max(zNear, zFar);
          if (r2() < 0.5 || !clear(x, x + w, zA, zB)) {
            x += w + 4;
            continue;
          }
          const floors = garage ? 1 : back.floors[0] + Math.floor(r2() * (back.floors[1] - back.floors[0] + 1));
          const L = { style: t.style, x0: x, x1: x + w, zN: zNear, zF: zFar, s: side, y: ground, floors, garage, low: lowest(x, x + w, zA, zB), rand: mulberry32(isl.seed * 3571 + ti * 211 + lot++ * 41) };
          const top = buildBack(ctx, L);
          roofs.push({ x: top.x, z: top.z, y: top.y, floors, island: isl.id });
          colliders.addBox(x + w / 2, (zA + zB) / 2, w / 2, (zB - zA) / 2);
          x += w + 3 + r2() * 9;
        }
      }
    }
    streets.push({ style: t.style, sx0, sx1, sz, ground, units: shopUnits, crossXs, parkSide: ti % 2 === 0 ? 1 : -1, seed: isl.seed * 131 + ti * 7 });

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
        world.addSlab(px0, px1, za, zb, y);
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

  // Things on the pavements (added to the builders, like the buildings).
  buildStreetFurniture(scene, colliders, streets, mats, paint);

  const meshes = [];
  const casters = [];
  for (const [mat, g] of builders) {
    fillColours(g);
    const m = g.toMesh(`town_${mat.name}`, scene);
    m.material = mat;
    meshes.push(m);
    // (Not the pavement, nor see-through railings and glass.)
    if (mat !== paversMat && mat !== mats.railing && mat.alpha === 1) casters.push(m);
  }

  // --- Street lamps -------------------------------------------------------------
  // (No caps on the pole: one end is in the pavement, the other far overhead.
  // The triangles saved pay for the new buildings.)
  const pole = MeshBuilder.CreateCylinder("lampPole", { height: 7.6, diameterTop: 0.12, diameterBottom: 0.2, tessellation: 8, cap: Mesh.NO_CAP }, scene);
  pole.position.y = 3.8;
  const arm = MeshBuilder.CreateBox("lampArm", { width: 0.1, height: 0.1, depth: 2.0 }, scene);
  arm.position.set(0, 7.5, 0.95);
  const lamp = Mesh.MergeMeshes([pole, arm], true, true);
  lamp.name = "lamps";
  lamp.material = plainMaterial(scene, "lampMetal", rgb(0.16, 0.17, 0.18), { metallic: 0.6, roughness: 0.45 });
  // The lamp head is separate so it can glow at night.
  const head = MeshBuilder.CreateBox("lampHeads", { width: 0.34, height: 0.14, depth: 0.7 }, scene);
  head.bakeTransformIntoVertices(Matrix.Translation(0, 7.42, 1.85));
  const glow = plainMaterial(scene, "lampGlow", rgb(0.85, 0.85, 0.8), { roughness: 0.3 });
  glow.emissiveColor = new Color3(0, 0, 0);
  head.material = glow;
  const buf = new Float32Array(lampMatrices.length * 16);
  lampMatrices.forEach((m, i) => m.copyToArray(buf, i * 16));
  lamp.thinInstanceSetBuffer("matrix", buf, 16, true);
  head.thinInstanceSetBuffer("matrix", buf.slice(), 16, true);
  casters.push(lamp);
  meshes.push(lamp, head);
  // Where each lamp's light falls on the street.
  const lampSpots = lampMatrices.map((m) => {
    const p = Vector3.TransformCoordinates(new Vector3(0, 0, 1.85), m);
    return { x: p.x, y: p.y - 0.1, z: p.z };
  });

  for (const m of meshes) {
    m.receiveShadows = true;
    m.isPickable = false;
    if (m !== lamp && m !== head) m.freezeWorldMatrix();
  }
  return { meshes, casters, pavementSpots, lampSpots, lampGlow: glow, parks, roofs };
}
