import { DynamicTexture, PBRMaterial, Texture, MeshBuilder, Mesh, Matrix, Quaternion, Vector3 } from "@babylonjs/core";
import { GeometryBuilder } from "../geom.js";
import { mulberry32 } from "../noise.js";
import { surfaceMaterial, plainMaterial, rgb } from "./materials.js";
import { ROAD_HALF_WIDTH, TOWN, MAIN_STREET } from "./layout.js";

const BAY = 3.5; // metres per window bay
const FLOOR = 3.4; // metres per storey
const TEX_BAYS = 4; // the facade texture holds 4 bays x 2 storeys
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

// Paints a facade (wall + windows) and a matching roughness map on canvases.
function paintFacade(scene, name, wallImg, wallTint, frameColor, seed) {
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
  o.fillStyle = "rgb(255, 225, 0)"; // ao 1, rough ~0.88, metal 0
  o.fillRect(0, 0, W, H);

  const bayPx = W / TEX_BAYS;
  const floorPx = H / TEX_FLOORS;
  for (let f = 0; f < TEX_FLOORS; f++) {
    // Thin ledge between storeys.
    a.fillStyle = "rgba(0,0,0,0.18)";
    a.fillRect(0, f * floorPx, W, 10);
    for (let b = 0; b < TEX_BAYS; b++) {
      const x = b * bayPx + bayPx * 0.2;
      const w = bayPx * 0.6;
      const y = f * floorPx + floorPx * 0.2;
      const h = floorPx * 0.58;
      // Frame
      a.fillStyle = frameColor;
      a.fillRect(x - 9, y - 9, w + 18, h + 18);
      o.fillStyle = "rgb(255, 130, 0)";
      o.fillRect(x - 9, y - 9, w + 18, h + 18);
      // Glass: dark, with a soft sky-ish gradient; very smooth so it reflects.
      const g = a.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0, "#5d6f7d");
      g.addColorStop(1, "#1b242c");
      a.fillStyle = g;
      a.fillRect(x, y, w, h);
      o.fillStyle = "rgb(255, 18, 0)";
      o.fillRect(x, y, w, h);
      // Some windows have blinds partly down.
      if (rand() < 0.45) {
        const bh = h * (0.15 + rand() * 0.6);
        a.fillStyle = rand() < 0.5 ? "#cfc6b4" : "#8f857a";
        a.fillRect(x, y, w, bh);
        o.fillStyle = "rgb(255, 210, 0)";
        o.fillRect(x, y, w, bh);
      }
      // Middle bar
      a.fillStyle = frameColor;
      a.fillRect(x + w / 2 - 4, y, 8, h);
      // Sill
      a.fillStyle = "rgba(235,232,225,0.95)";
      a.fillRect(x - 14, y + h + 9, w + 28, 12);
    }
  }
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

function addBox(g, x0, x1, z0, z1, y0, y1, uvScaleU, uvScaleV) {
  // Four walls; u runs along each wall, v runs up from the ground.
  const walls = [
    [[x0, z0], [x1, z0], [0, 0, -1]],
    [[x1, z0], [x1, z1], [1, 0, 0]],
    [[x1, z1], [x0, z1], [0, 0, 1]],
    [[x0, z1], [x0, z0], [-1, 0, 0]],
  ];
  for (const [a, b, n] of walls) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const u1 = len / uvScaleU;
    const v0 = (y0 - TOWN.height) / uvScaleV;
    const v1 = (y1 - TOWN.height) / uvScaleV;
    g.addQuad([a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]], n, [0, v0], [u1, v0], [u1, v1], [0, v1]);
  }
}

export async function buildTown(scene, hf, colliders) {
  const [plaster, brick] = await Promise.all([
    loadImage("assets/textures/plaster_color.webp"),
    loadImage("assets/textures/brick_color.webp"),
  ]);
  const facades = [
    paintFacade(scene, "facade_cream", plaster, "#fff8ea", "#e9e6df", 1),
    paintFacade(scene, "facade_brick", brick, "#f0e4dc", "#efece6", 2),
    paintFacade(scene, "facade_slate", plaster, "#b9c2ca", "#2c3034", 3),
    paintFacade(scene, "facade_sand", plaster, "#f2dcc0", "#f2efe9", 4),
  ];
  const wallBuilders = facades.map(() => new GeometryBuilder());
  const roof = new GeometryBuilder();
  const rand = mulberry32(99);

  const x0 = MAIN_STREET.x0 - 5;
  const x1 = MAIN_STREET.x1 + 15;
  const ground = TOWN.height;

  for (const side of [-1, 1]) {
    let x = x0 + rand() * 6;
    while (x < x1 - 10) {
      const width = 13 + rand() * 16;
      const xe = Math.min(x + width, x1);
      if (rand() < 0.12) {
        x = xe + 6; // an empty lot now and then
        continue;
      }
      const depth = 14 + rand() * 12;
      const centre = 1 - Math.abs((x + xe) / 2 - TOWN.cx) / TOWN.hx;
      const floors = Math.max(2, Math.round(2 + rand() * 3 + centre * 4));
      const top = ground + floors * FLOOR + 0.4;
      const zNear = side * BUILD_LINE;
      const zFar = side * (BUILD_LINE + depth);
      const zA = Math.min(zNear, zFar);
      const zB = Math.max(zNear, zFar);
      const variant = Math.floor(rand() * facades.length);
      addBox(wallBuilders[variant], x, xe, zA, zB, ground - 1, top, BAY * TEX_BAYS, FLOOR * TEX_FLOORS);
      roof.addQuad([x, top, zA], [xe, top, zA], [xe, top, zB], [x, top, zB], [0, 1, 0], [x / 6, zA / 6], [xe / 6, zA / 6], [xe / 6, zB / 6], [x / 6, zB / 6]);
      colliders.addBox((x + xe) / 2, (zA + zB) / 2, (xe - x) / 2, (zB - zA) / 2);
      x = xe + 3 + rand() * 7;
    }
  }

  const casters = [];
  const meshes = [];
  wallBuilders.forEach((g, i) => {
    if (!g.vertexCount) return;
    const m = g.toMesh(`buildings_${i}`, scene);
    m.material = facades[i];
    casters.push(m);
    meshes.push(m);
  });
  const roofMat = surfaceMaterial(scene, "roof", "pavers", { tint: rgb(0.55, 0.55, 0.56) });
  const roofMesh = roof.toMesh("roofs", scene);
  roofMesh.material = roofMat;
  meshes.push(roofMesh);

  // --- Pavements both sides of the main street -----------------------------
  const walk = new GeometryBuilder();
  const curbH = 0.12;
  const wx0 = MAIN_STREET.x0;
  const wx1 = MAIN_STREET.x1;
  for (const side of [-1, 1]) {
    const zi = side * ROAD_HALF_WIDTH;
    const zo = side * (ROAD_HALF_WIDTH + SIDEWALK + 2);
    const y = ground + 0.04 + curbH;
    const za = Math.min(zi, zo);
    const zb = Math.max(zi, zo);
    walk.addQuad([wx0, y, za], [wx1, y, za], [wx1, y, zb], [wx0, y, zb], [0, 1, 0], [wx0 / 2, za / 2], [wx1 / 2, za / 2], [wx1 / 2, zb / 2], [wx0 / 2, zb / 2]);
    // Kerb face toward the road.
    walk.addQuad([wx0, ground - 0.2, zi], [wx1, ground - 0.2, zi], [wx1, y, zi], [wx0, y, zi], [0, 0, -side], [wx0 / 2, 0], [wx1 / 2, 0], [wx1 / 2, 0.15], [wx0 / 2, 0.15]);
  }
  const paversMat = surfaceMaterial(scene, "pavers", "pavers", { tint: rgb(0.78, 0.84, 0.92) });
  const walkMesh = walk.toMesh("pavements", scene);
  walkMesh.material = paversMat;
  meshes.push(walkMesh);

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
  const lampMatrices = [];
  for (let x = wx0 + 10, k = 0; x < wx1 - 5; x += 32, k++) {
    const side = k % 2 === 0 ? 1 : -1;
    const z = side * (ROAD_HALF_WIDTH + 0.8);
    // Arm points across the road toward the centre line.
    const yaw = side > 0 ? Math.PI : 0;
    lampMatrices.push(Matrix.Compose(Vector3.One(), Quaternion.RotationYawPitchRoll(yaw, 0, 0), new Vector3(x, ground + 0.16, z)));
    colliders.addCircle(x, z, 0.2);
  }
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
  return { meshes, casters };
}
