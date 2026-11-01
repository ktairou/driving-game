import { MeshBuilder, Mesh, DynamicTexture, PBRMaterial, Color3 } from "@babylonjs/core";
import { GeometryBuilder, normalize } from "../geom.js";
import { surfaceMaterial, plainMaterial, rgb } from "./materials.js";
import { ISLANDS } from "./layout.js";

// Simplified, hand-built versions of famous landmarks.

function clockFace(scene) {
  const size = 512;
  const t = new DynamicTexture("clockFace", { width: size, height: size }, scene, true);
  const draw = () => {
    const c = t.getContext();
    const r = size / 2;
    c.clearRect(0, 0, size, size);
    c.fillStyle = "#c9a86a";
    c.fillRect(0, 0, size, size);
    c.beginPath();
    c.arc(r, r, r * 0.92, 0, Math.PI * 2);
    c.fillStyle = "#f3efe2";
    c.fill();
    c.lineWidth = 10;
    c.strokeStyle = "#1d1b18";
    c.stroke();
    c.fillStyle = "#1d1b18";
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * Math.PI * 2;
      const big = i % 5 === 0;
      c.save();
      c.translate(r, r);
      c.rotate(a);
      c.fillRect(-(big ? 5 : 2), -r * 0.86, big ? 10 : 4, big ? 34 : 14);
      c.restore();
    }
    const now = new Date();
    const hour = ((now.getHours() % 12) + now.getMinutes() / 60) / 12;
    const min = now.getMinutes() / 60;
    const hand = (frac, len, w) => {
      c.save();
      c.translate(r, r);
      c.rotate(frac * Math.PI * 2);
      c.fillRect(-w / 2, -len, w, len + 16);
      c.restore();
    };
    hand(hour, r * 0.48, 14);
    hand(min, r * 0.74, 8);
    c.beginPath();
    c.arc(r, r, 14, 0, Math.PI * 2);
    c.fill();
    t.update(true);
  };
  draw();
  // The hands show the real time on your iPad.
  setInterval(draw, 30000);
  return t;
}

function buildClockTower(scene, lm, ground, colliders) {
  const stone = surfaceMaterial(scene, "towerStone", "sandstone", { tint: rgb(1.0, 0.9, 0.7) });
  stone.albedoTexture.uScale = stone.albedoTexture.vScale = 4;
  const roof = plainMaterial(scene, "towerRoof", rgb(0.2, 0.24, 0.26), { metallic: 0.3, roughness: 0.5 });
  const gold = plainMaterial(scene, "gold", rgb(0.85, 0.65, 0.25), { metallic: 1, roughness: 0.3 });
  const faceMat = new PBRMaterial("clockFaceMat", scene);
  faceMat.albedoTexture = clockFace(scene);
  faceMat.roughness = 0.5;
  faceMat.metallic = 0;
  faceMat.emissiveColor = new Color3(0.12, 0.11, 0.09);

  const parts = { stone: [], roof: [], gold: [], face: [] };
  const box = (list, w, h, d, x, y, z) => {
    const b = MeshBuilder.CreateBox("p", { width: w, height: h, depth: d }, scene);
    b.position.set(lm.x + x, ground + y, lm.z + z);
    list.push(b);
    return b;
  };
  box(parts.stone, 12, 56, 12, 0, 28, 0); // shaft
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) box(parts.stone, 1.6, 74, 1.6, sx * 6.2, 37, sz * 6.2); // corner pinnacles
  box(parts.stone, 14, 11, 14, 0, 61.5, 0); // clock stage
  box(parts.gold, 14.6, 0.8, 14.6, 0, 56.4, 0);
  box(parts.gold, 14.6, 0.8, 14.6, 0, 67.2, 0);
  box(parts.stone, 11, 8, 11, 0, 71.5, 0); // belfry
  // Spire
  const spire = MeshBuilder.CreateCylinder("spire", { height: 24, diameterTop: 0.4, diameterBottom: 14, tessellation: 4 }, scene);
  spire.rotation.y = Math.PI / 4;
  spire.position.set(lm.x, ground + 87.5, lm.z);
  parts.roof.push(spire);
  box(parts.gold, 0.5, 6, 0.5, 0, 101, 0);
  // Four clock faces
  for (let k = 0; k < 4; k++) {
    const f = MeshBuilder.CreatePlane("face", { size: 9 }, scene);
    const a = (k * Math.PI) / 2;
    f.position.set(lm.x + Math.sin(a) * 7.05, ground + 61.5, lm.z + Math.cos(a) * 7.05);
    f.rotation.y = a + Math.PI;
    parts.face.push(f);
  }
  colliders.addBox(lm.x, lm.z, 7, 7);
  return [
    [Mesh.MergeMeshes(parts.stone, true, true), stone],
    [Mesh.MergeMeshes(parts.roof, true, true), roof],
    [Mesh.MergeMeshes(parts.gold, true, true), gold],
    [Mesh.MergeMeshes(parts.face, true, true), faceMat],
  ];
}

// Criss-cross iron lattice, see-through between the beams.
function latticeMaterial(scene) {
  const size = 256;
  const t = new DynamicTexture("lattice", { width: size, height: size }, scene, true);
  const c = t.getContext();
  c.clearRect(0, 0, size, size);
  c.strokeStyle = "#ffffff";
  c.lineCap = "square";
  // Thick girders up both edges, a thin cross bar, and big X braces.
  c.lineWidth = 30;
  c.beginPath();
  c.moveTo(0, 0);
  c.lineTo(0, size);
  c.moveTo(size, 0);
  c.lineTo(size, size);
  c.stroke();
  c.lineWidth = 10;
  c.beginPath();
  c.moveTo(0, 0);
  c.lineTo(size, 0);
  c.moveTo(0, size);
  c.lineTo(size, size);
  c.stroke();
  c.lineWidth = 16;
  c.beginPath();
  c.moveTo(0, 0);
  c.lineTo(size, size);
  c.moveTo(size, 0);
  c.lineTo(0, size);
  c.stroke();
  t.hasAlpha = true;
  t.update(true);
  t.wrapU = t.wrapV = 1;
  const m = new PBRMaterial("ironLattice", scene);
  m.albedoTexture = t;
  m.albedoColor = new Color3(0.32, 0.22, 0.15);
  m.useAlphaFromAlbedoTexture = true;
  m.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHATEST;
  m.alphaCutOff = 0.5;
  m.backFaceCulling = false;
  m.metallic = 0.3;
  m.roughness = 0.7;
  return m;
}

// A square, tapering lattice column whose centre and half-width follow `ring(y)`.
function latticeColumn(g, cx, cz, y0, y1, steps, ring) {
  for (let s = 0; s < steps; s++) {
    const ya = y0 + ((y1 - y0) * s) / steps;
    const yb = y0 + ((y1 - y0) * (s + 1)) / steps;
    const A = ring(ya);
    const B = ring(yb);
    const corners = (R, y) => [
      [cx + R.x - R.w, y, cz + R.z - R.w],
      [cx + R.x + R.w, y, cz + R.z - R.w],
      [cx + R.x + R.w, y, cz + R.z + R.w],
      [cx + R.x - R.w, y, cz + R.z + R.w],
    ];
    const ca = corners(A, ya);
    const cb = corners(B, yb);
    // One lattice panel is roughly as tall as it is wide.
    const tileU = Math.max(1, Math.round((A.w * 2) / 5));
    const tileV = Math.max(1, Math.round((yb - ya) / 5));
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4;
      const mid = [(ca[k][0] + ca[k2][0]) / 2 - (cx + A.x), 0, (ca[k][2] + ca[k2][2]) / 2 - (cz + A.z)];
      g.addQuad(ca[k], ca[k2], cb[k2], cb[k], normalize(mid), [0, 0], [tileU, 0], [tileU, tileV], [0, tileV]);
    }
  }
}

function buildIronTower(scene, lm, ground, colliders) {
  const lattice = latticeMaterial(scene);
  const deckMat = plainMaterial(scene, "towerDeck", rgb(0.28, 0.2, 0.14), { metallic: 0.3, roughness: 0.7 });
  const g = new GeometryBuilder();
  const top = 150;
  // Four curved legs meeting at the second platform.
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    latticeColumn(g, lm.x, lm.z, 0, 58, 10, (y) => {
      const t = y / 58;
      const r = 9 + 27 * Math.pow(1 - t, 1.7);
      return { x: sx * r, z: sz * r, w: 7 - 3 * t };
    });
    colliders.addCircle(lm.x + sx * 34, lm.z + sz * 34, 6);
  }
  // Upper shaft
  latticeColumn(g, lm.x, lm.z, 58, top, 12, (y) => {
    const t = (y - 58) / (top - 58);
    return { x: 0, z: 0, w: 2.2 + 10 * Math.pow(1 - t, 1.8) };
  });
  const decks = [];
  for (const [y, w] of [[30, 23], [58, 13], [top, 5]]) {
    const d = MeshBuilder.CreateBox("deck", { width: w * 2, height: 3, depth: w * 2 }, scene);
    d.position.set(lm.x, ground + y, lm.z);
    decks.push(d);
  }
  const mast = MeshBuilder.CreateCylinder("mast", { height: 14, diameter: 0.8, tessellation: 6 }, scene);
  mast.position.set(lm.x, ground + top + 8, lm.z);
  decks.push(mast);
  const mesh = g.toMesh("ironTower", scene);
  mesh.position.y = ground;
  return [
    [mesh, lattice],
    [Mesh.MergeMeshes(decks, true, true), deckMat],
  ];
}

function buildPyramid(scene, lm, ground, colliders, material) {
  const g = new GeometryBuilder();
  const h = lm.base / 2;
  const apex = [lm.x, ground + lm.height, lm.z];
  const c = [
    [lm.x - h, ground - 2, lm.z - h],
    [lm.x + h, ground - 2, lm.z - h],
    [lm.x + h, ground - 2, lm.z + h],
    [lm.x - h, ground - 2, lm.z + h],
  ];
  const tile = 6;
  for (let k = 0; k < 4; k++) {
    const a = c[k];
    const b = c[(k + 1) % 4];
    const mid = [(a[0] + b[0]) / 2 - lm.x, 0, (a[2] + b[2]) / 2 - lm.z];
    // Face normal: outward by the height, upward by the half-base.
    const n = normalize([(mid[0] / h) * lm.height, h, (mid[2] / h) * lm.height]);
    const i0 = g.addVertex(a, n, [0, 0]);
    const i1 = g.addVertex(b, n, [lm.base / tile, 0]);
    const i2 = g.addVertex(apex, n, [lm.base / tile / 2, Math.hypot(lm.height, h) / tile]);
    g.addTriangle(i0, i1, i2, n);
  }
  colliders.addBox(lm.x, lm.z, h, h);
  const mesh = g.toMesh("pyramid", scene);
  return [[mesh, material]];
}

export function buildLandmarks(scene, world, colliders) {
  const meshes = [];
  const sandstone = surfaceMaterial(scene, "pyramidStone", "sandstone", { tint: rgb(1.0, 0.92, 0.78) });
  for (const isl of ISLANDS) {
    for (const lm of isl.landmarks) {
      const ground = world.getHeight(lm.x, lm.z);
      let made = [];
      if (lm.type === "clockTower") made = buildClockTower(scene, lm, ground, colliders);
      else if (lm.type === "ironTower") made = buildIronTower(scene, lm, ground, colliders);
      else if (lm.type === "pyramid") made = buildPyramid(scene, lm, ground, colliders, sandstone);
      for (const [mesh, mat] of made) {
        mesh.material = mat;
        mesh.receiveShadows = true;
        mesh.isPickable = false;
        mesh.freezeWorldMatrix();
        meshes.push(mesh);
      }
    }
  }
  return { meshes, casters: meshes };
}
