import { DynamicTexture, PBRMaterial, MaterialPluginBase, MeshBuilder, Mesh, VertexData, Matrix, Quaternion, Vector3 } from "@babylonjs/core";
import { GeometryBuilder } from "../geom.js";
import { mulberry32 } from "../noise.js";
import { plainMaterial, rgb } from "./materials.js";
import { ISLANDS, TOWNS, ROAD_HALF_WIDTH, ROAD_SAMPLE_STEP } from "./layout.js";
import { inTown } from "./road.js";
import { stationFlagSpot } from "./stations.js";

// Each country's flag, flying in lots of places so it's always clear which
// country you're in: on the tallest roofs in every town, along the main
// streets, at both ends of each town, at fuel stations, landmarks and park
// gates, now and then beside country roads, and in pairs (with a "Welcome to"
// sign) where each bridge lands.
//
// One mesh per country, drawn once for all its flags; the cloth ripples in the
// wind on the graphics chip, so hundreds of flags cost very little.

// --- The flags themselves (drawn on a 2:1 canvas; each flag mesh has its own true shape) ---
const W = 512;
const H = 256;

function unionJack(c) {
  const u = W / 60; // the official design is 60 x 30 units
  c.fillStyle = "#012169";
  c.fillRect(0, 0, W, H);
  const diag = (width, colour) => {
    c.strokeStyle = colour;
    c.lineWidth = width;
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(W, H);
    c.moveTo(0, H);
    c.lineTo(W, 0);
    c.stroke();
  };
  diag(6 * u, "#ffffff");
  // The red diagonals sit off-centre: below the white on the hoist (pole) half,
  // above it on the fly half.
  const shift = 1.118 * u;
  for (const [x0, dy] of [
    [0, shift],
    [W / 2, -shift],
  ]) {
    c.save();
    c.beginPath();
    c.rect(x0, 0, W / 2, H);
    c.clip();
    c.translate(0, dy);
    diag(2 * u, "#C8102E");
    c.restore();
  }
  c.fillStyle = "#ffffff";
  c.fillRect(W / 2 - 5 * u, 0, 10 * u, H);
  c.fillRect(0, H / 2 - 5 * u, W, 10 * u);
  c.fillStyle = "#C8102E";
  c.fillRect(W / 2 - 3 * u, 0, 6 * u, H);
  c.fillRect(0, H / 2 - 3 * u, W, 6 * u);
}

function tricolore(c) {
  ["#002654", "#ffffff", "#ED2939"].forEach((col, i) => {
    c.fillStyle = col;
    c.fillRect((i * W) / 3, 0, W / 3 + 1, H);
  });
}

function egypt(c) {
  ["#CE1126", "#ffffff", "#000000"].forEach((col, i) => {
    c.fillStyle = col;
    c.fillRect(0, (i * H) / 3, W, H / 3 + 1);
  });
  // The golden eagle in the middle (simplified).
  const gold = "#C09300";
  const cx = W / 2;
  const cy = H / 2;
  const s = H / 3 / 2.2; // fits in the white band
  c.fillStyle = gold;
  c.beginPath();
  // wings
  c.moveTo(cx - 0.25 * s, cy - 0.4 * s);
  c.lineTo(cx - 1.25 * s, cy - 0.75 * s);
  c.lineTo(cx - 1.05 * s, cy + 0.35 * s);
  c.lineTo(cx - 0.35 * s, cy + 0.6 * s);
  c.closePath();
  c.moveTo(cx + 0.25 * s, cy - 0.4 * s);
  c.lineTo(cx + 1.25 * s, cy - 0.75 * s);
  c.lineTo(cx + 1.05 * s, cy + 0.35 * s);
  c.lineTo(cx + 0.35 * s, cy + 0.6 * s);
  c.closePath();
  c.fill();
  // body (a shield) and head
  c.beginPath();
  c.moveTo(cx - 0.42 * s, cy - 0.45 * s);
  c.lineTo(cx + 0.42 * s, cy - 0.45 * s);
  c.lineTo(cx + 0.42 * s, cy + 0.35 * s);
  c.lineTo(cx, cy + 0.85 * s);
  c.lineTo(cx - 0.42 * s, cy + 0.35 * s);
  c.closePath();
  c.fill();
  c.beginPath();
  c.arc(cx, cy - 0.72 * s, 0.24 * s, 0, Math.PI * 2);
  c.fill();
  // stripes on the shield
  c.fillStyle = "#ffffff";
  for (let k = -1; k <= 1; k++) c.fillRect(cx + k * 0.24 * s - 0.05 * s, cy - 0.35 * s, 0.1 * s, 0.8 * s);
}

function star(c, x, y, r) {
  c.beginPath();
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    const rr = k % 2 ? r * 0.382 : r;
    c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  c.closePath();
  c.fill();
}

function starsAndStripes(c) {
  const stripe = H / 13;
  for (let i = 0; i < 13; i++) {
    c.fillStyle = i % 2 ? "#ffffff" : "#B22234";
    c.fillRect(0, i * stripe, W, stripe + 1);
  }
  const cw = W * 0.4;
  const ch = stripe * 7;
  c.fillStyle = "#3C3B6E";
  c.fillRect(0, 0, cw, ch);
  c.fillStyle = "#ffffff";
  // 50 stars: nine rows, six and five in turn.
  for (let row = 0; row < 9; row++) {
    const n = row % 2 ? 5 : 6;
    for (let k = 0; k < n; k++) {
      const x = (cw / 12) * (row % 2 ? 2 + k * 2 : 1 + k * 2);
      const y = (ch / 10) * (row + 1);
      star(c, x, y, ch * 0.045);
    }
  }
}

// Width : height of each real flag.
const FLAGS = {
  britain: { draw: unionJack, ratio: 2 },
  france: { draw: tricolore, ratio: 1.5 },
  egypt: { draw: egypt, ratio: 1.5 },
  usa: { draw: starsAndStripes, ratio: 1.9 },
};

function flagTexture(scene, id) {
  const t = new DynamicTexture(`flag_${id}`, { width: W, height: H }, scene, true);
  FLAGS[id].draw(t.getContext());
  t.update(true);
  return t;
}

// Ripples the cloth: each point moves out of the flag's plane by a wave that
// runs from the pole to the free end, growing towards the end. Each flag gets
// its own timing from where it stands.
class FlagWave extends MaterialPluginBase {
  constructor(material) {
    super(material, "FlagWave", 200, { FLAGWAVE: false });
    this.time = 0;
    this._enable(true);
  }

  getClassName() {
    return "FlagWave";
  }

  prepareDefines(defines) {
    defines.FLAGWAVE = true;
  }

  getUniforms() {
    return {
      ubo: [{ name: "flagTime", size: 1, type: "float" }],
      vertex: `#ifdef FLAGWAVE
        uniform float flagTime;
      #endif`,
    };
  }

  bindForSubMesh(ubo) {
    ubo.updateFloat("flagTime", this.time);
  }

  getCustomCode(shaderType) {
    if (shaderType !== "vertex") return null;
    return {
      CUSTOM_VERTEX_UPDATE_POSITION: `
        #ifdef FLAGWAVE
          float flagPhase = 0.0;
          #ifdef INSTANCES
            flagPhase = dot(world3.xz, vec2(0.37, 0.23));
          #endif
          float flagK = 2.6;
          float flagArg = positionUpdated.x * flagK - flagTime * 5.2 + flagPhase + positionUpdated.y * 0.7;
          float flagAmp = 0.13 * positionUpdated.x;
          float flagS = sin(flagArg);
          float flagC = cos(flagArg);
          positionUpdated.z += flagAmp * flagS;
          positionUpdated.y -= 0.025 * positionUpdated.x * positionUpdated.x;
        #endif
      `,
      CUSTOM_VERTEX_UPDATE_NORMAL: `
        #ifdef FLAGWAVE
          float flagDx = 0.13 * flagS + flagAmp * flagK * flagC;
          float flagDy = flagAmp * 0.7 * flagC;
          normalUpdated = normalize(vec3(-flagDx, -flagDy, 1.0));
        #endif
      `,
    };
  }
}

// The cloth: a grid in the x-y plane, x from the pole (0) to the free end,
// y from the top (0) down to -1. Flags are scaled to size where they fly.
function flagMesh(scene, id, ratio) {
  const nx = 12;
  const ny = 4;
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      positions.push((i / nx) * ratio, -j / ny, 0);
      normals.push(0, 0, 1);
      uvs.push(i / nx, 1 - j / ny);
    }
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i;
      indices.push(a, a + 1, a + nx + 1, a + 1, a + nx + 2, a + nx + 1);
    }
  }
  const mesh = new Mesh(`flags_${id}`, scene);
  const vd = new VertexData();
  vd.positions = positions;
  vd.normals = normals;
  vd.uvs = uvs;
  vd.indices = indices;
  vd.applyToMesh(mesh);
  return mesh;
}

function welcomeBoard(scene, id, name) {
  const t = new DynamicTexture(`welcome_${id}`, { width: 1024, height: 384 }, scene, true);
  const c = t.getContext();
  c.fillStyle = "#f6f3ea";
  c.fillRect(0, 0, 1024, 384);
  c.strokeStyle = "#20304a";
  c.lineWidth = 14;
  c.strokeRect(12, 12, 1000, 360);
  // The flag on the left...
  c.save();
  c.translate(56, 92);
  const fw = 280;
  const fh = fw / FLAGS[id].ratio;
  c.translate(0, (200 - fh) / 2);
  c.scale(fw / W, fh / H);
  FLAGS[id].draw(c);
  c.restore();
  c.strokeStyle = "#20304a";
  c.lineWidth = 4;
  c.strokeRect(56, 92 + (200 - fw / FLAGS[id].ratio) / 2, fw, fw / FLAGS[id].ratio);
  // ...and the words.
  c.fillStyle = "#20304a";
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.font = "bold 64px Arial, Helvetica, sans-serif";
  c.fillText("Welcome to", 670, 140);
  let px = 110;
  do {
    c.font = `bold ${px}px Arial, Helvetica, sans-serif`;
    px -= 4;
  } while (c.measureText(name).width > 560);
  c.fillText(name, 670, 250);
  t.update(true);
  const m = new PBRMaterial(`welcomeMat_${id}`, scene);
  m.albedoTexture = t;
  m.metallic = 0;
  m.roughness = 0.55;
  return m;
}

export function buildFlags(scene, world, colliders, { roofs, parks, stations }) {
  const rand = mulberry32(1776);
  const net = world.network;
  const WIND = 0.5; // which way the flags fly (radians, round the pole)
  const flagsBy = Object.fromEntries(Object.keys(FLAGS).map((id) => [id, []]));
  const poles = []; // [x, y, z, height, thickness]
  const welcome = [];
  const countryAt = (x, z) => world.islandAt(x, z)?.def.id;

  // A pole of the given height standing at (x, z), flying a flag `size` tall.
  const fly = (country, x, z, height, size, base = null) => {
    if (!FLAGS[country]) return;
    const y = base ?? world.getHeight(x, z);
    const thick = height > 9 ? 1.6 : 1;
    poles.push([x, y, z, height, thick]);
    const yaw = WIND + (rand() - 0.5) * 0.35;
    flagsBy[country].push(Matrix.Compose(new Vector3(size, size, size), Quaternion.RotationYawPitchRoll(yaw, 0, 0), new Vector3(x, y + height - 0.45, z)));
    if (base === null) colliders.addCircle(x, z, 0.12 * thick);
  };
  const clearOfRoads = (x, z, d) => world.getRoadDistance(x, z) > d;

  // 1. On the tallest roofs of every town.
  for (const t of TOWNS) {
    const mine = roofs.filter((r) => Math.abs(r.x - t.cx) < t.hx + 20 && Math.abs(r.z - t.cz) < t.hz + 20).sort((a, b) => b.floors - a.floors || b.y - a.y);
    const picked = [];
    for (const r of mine) {
      if (picked.length >= 7) break;
      if (picked.some((p) => Math.hypot(p.x - r.x, p.z - r.z) < 28)) continue;
      picked.push(r);
      fly(t.island, r.x, r.z, 8, 2.4, r.y);
    }
  }

  // 2. Along each main street (between the lamps), and 3. a big pair at each end of town.
  for (const t of TOWNS) {
    const { x0, x1, z } = t.street;
    const crossing = (x) =>
      net.roads.some((r) => r.points.some(([px, pz]) => Math.abs(px - x) < 12 && Math.abs(pz - z) < 12 && !(px > x0 - 30 && px < x1 + 30 && Math.abs(pz - z) < 1.5)));
    for (let x = x0 + 26, k = 0; x < x1 - 10; x += 32, k++) {
      if (k % 2 || crossing(x)) continue; // every other gap between lamps
      const side = (k / 2) % 2 ? 1 : -1;
      fly(t.island, x, z + side * (ROAD_HALF_WIDTH + 0.8), 8, 1.7);
    }
    for (const ex of [x0 - 16, x1 + 16]) {
      for (const side of [-1, 1]) {
        const pz = z + side * (ROAD_HALF_WIDTH + 4.5);
        if (clearOfRoads(ex, pz, ROAD_HALF_WIDTH + 2)) fly(t.island, ex, pz, 13, 3);
      }
    }
  }

  // 4. Where each bridge lands: a pair of big flags and a welcome sign for
  // everyone driving in off the bridge.
  for (const road of net.roads) {
    if (!road.from || !road.bridge.some(Boolean)) continue; // only the bridges between countries
    const n = road.count;
    for (let i = 1; i < n; i++) {
      if (road.bridge[i] === road.bridge[i - 1]) continue;
      // dir: the way traffic arriving from the bridge goes.
      const dir = road.bridge[i - 1] ? 1 : -1;
      const j = Math.max(0, Math.min(n - 1, i + dir * 18));
      if (road.bridge[j]) continue;
      const [px, pz] = road.points[j];
      const country = countryAt(px, pz);
      if (!country) continue;
      const [tx, tz] = road.tangents[j];
      const ax = tx * dir;
      const az = tz * dir;
      for (const s of [-1, 1]) {
        const fx = px + az * s * (ROAD_HALF_WIDTH + 4);
        const fz = pz - ax * s * (ROAD_HALF_WIDTH + 4);
        if (world.getHeight(fx, fz) > 1) fly(country, fx, fz, 13, 3);
      }
      // The sign stands on the side people drive on, a little further on.
      const k = Math.max(0, Math.min(n - 1, j + dir * 10));
      if (road.bridge[k]) continue;
      const [qx, qz] = road.points[k];
      const drive = world.islandById(country).def.drive === "left" ? -1 : 1;
      const sx = qx + az * drive * (ROAD_HALF_WIDTH + 6);
      const sz = qz - ax * drive * (ROAD_HALF_WIDTH + 6);
      if (world.getHeight(sx, sz) > 1 && clearOfRoads(sx, sz, ROAD_HALF_WIDTH + 3)) welcome.push({ country, x: sx, z: sz, facing: [-ax, -az] });
    }
  }

  // 5. At every fuel station, behind the forecourt.
  for (const s of stations) {
    const [x, z] = stationFlagSpot(s);
    fly(s.island.id, x, z, 10, 2);
  }

  // 6. A pair beside each landmark (not the ones out in the water).
  for (const isl of ISLANDS) {
    for (const lm of isl.landmarks) {
      if (lm.sea || !lm.name) continue;
      const r = (lm.base ?? 40) / 2 + 12;
      let made = 0;
      for (let k = 0; k < 8 && made < 2; k++) {
        const a = (k * Math.PI) / 4 + (made ? Math.PI : 0);
        const x = lm.x + Math.cos(a) * r;
        const z = lm.z + Math.sin(a) * r;
        if (world.getHeight(x, z) < 2 || !clearOfRoads(x, z, ROAD_HALF_WIDTH + 2.5) || inTown(x, z, -5) || !world.isClear(x, z)) continue;
        fly(isl.id, x, z, 11, 2.2);
        made++;
      }
    }
  }

  // 7. Either side of every park gate.
  for (const p of parks) {
    const cx = (p.x0 + p.x1) / 2;
    const z = p.side > 0 ? p.z0 + 3 : p.z1 - 3;
    for (const s of [-1, 1]) fly(p.town.island, cx + s * 7.5, z, 8, 1.6);
  }

  // 8. Now and then beside country roads.
  for (const road of net.roads) {
    if (road.style) continue; // not on bridges
    const country = road.island;
    const n = road.count;
    const every = Math.round(420 / ROAD_SAMPLE_STEP);
    for (let i = Math.round(every / 2), k = 0; i < n - 10; i += every, k++) {
      const [x, z] = road.points[i];
      if (road.bridge[i] || inTown(x, z, 60) || net.isNearMeeting(x, z, 45)) continue;
      const [tx, tz] = road.tangents[i];
      const s = k % 2 ? 1 : -1;
      const fx = x + tz * s * (ROAD_HALF_WIDTH + 3.5);
      const fz = z - tx * s * (ROAD_HALF_WIDTH + 3.5);
      if (world.getHeight(fx, fz) < 3 || !world.isClear(fx, fz) || !clearOfRoads(fx, fz, ROAD_HALF_WIDTH + 2)) continue;
      fly(country ?? countryAt(fx, fz), fx, fz, 10, 2);
    }
  }

  // --- Meshes ------------------------------------------------------------------
  const meshes = [];
  const casters = [];
  const plugins = [];
  const instance = (mesh, mats) => {
    const buf = new Float32Array(mats.length * 16);
    mats.forEach((m, i) => m.copyToArray(buf, i * 16));
    mesh.thinInstanceSetBuffer("matrix", buf, 16, true);
    mesh.isPickable = false;
    mesh.receiveShadows = true;
    meshes.push(mesh);
  };
  for (const [id, mats] of Object.entries(flagsBy)) {
    if (!mats.length) continue;
    const mesh = flagMesh(scene, id, FLAGS[id].ratio);
    const mat = new PBRMaterial(`flagCloth_${id}`, scene);
    mat.albedoTexture = flagTexture(scene, id);
    mat.metallic = 0;
    mat.roughness = 0.85;
    mat.backFaceCulling = false;
    mat.twoSidedLighting = true;
    plugins.push(new FlagWave(mat));
    mesh.material = mat;
    instance(mesh, mats);
  }
  // Poles (white, with a gold ball on top).
  const pole = MeshBuilder.CreateCylinder("flagPoles", { height: 1, diameterTop: 0.07, diameterBottom: 0.12, tessellation: 8 }, scene);
  pole.bakeTransformIntoVertices(Matrix.Translation(0, 0.5, 0));
  pole.material = plainMaterial(scene, "flagPole", rgb(0.86, 0.87, 0.88), { metallic: 0.5, roughness: 0.35 });
  const ball = MeshBuilder.CreateSphere("flagBalls", { diameter: 0.16, segments: 6 }, scene);
  ball.material = plainMaterial(scene, "flagBall", rgb(0.85, 0.65, 0.2), { metallic: 1, roughness: 0.3 });
  instance(
    pole,
    poles.map(([x, y, z, h, k]) => Matrix.Compose(new Vector3(k, h, k), Quaternion.Identity(), new Vector3(x, y - 0.3, z))),
  );
  instance(
    ball,
    poles.map(([x, y, z, h, k]) => Matrix.Compose(new Vector3(k, k, k), Quaternion.Identity(), new Vector3(x, y - 0.3 + h + 0.06 * k, z))),
  );
  casters.push(pole);

  // Welcome signs: a board on two legs, facing the traffic coming in.
  const boardMats = {};
  const legs = [];
  for (const w of welcome) {
    const mat = (boardMats[w.country] ??= welcomeBoard(scene, w.country, world.islandById(w.country).def.name === "USA" ? "the USA" : world.islandById(w.country).def.name));
    const y = world.getHeight(w.x, w.z);
    const [fx, fz] = w.facing; // towards the drivers
    const rx = -fz; // the board's left-to-right, as the drivers see it
    const rz = fx;
    const half = 3.2;
    const g = new GeometryBuilder();
    const p = (s, h, o = 0.06) => [w.x + rx * s * half + fx * o, y + h, w.z + rz * s * half + fz * o];
    g.addQuad(p(-1, 2.0), p(1, 2.0), p(1, 4.4), p(-1, 4.4), [fx, 0, fz], [0, 0], [1, 0], [1, 1], [0, 1]);
    const face = g.toMesh(`welcome_${w.country}`, scene);
    face.material = mat;
    face.isPickable = false;
    face.receiveShadows = true;
    face.freezeWorldMatrix();
    meshes.push(face);
    const back = MeshBuilder.CreateBox("welcomeBack", { width: half * 2 + 0.2, height: 2.6, depth: 0.1 }, scene);
    back.rotation.y = Math.atan2(fx, fz);
    back.position.set(w.x, y + 3.2, w.z);
    legs.push(back);
    for (const s of [-1, 1]) {
      const leg = MeshBuilder.CreateBox("welcomeLeg", { width: 0.16, height: 4.4, depth: 0.16 }, scene);
      leg.position.set(w.x + rx * s * (half - 0.6), y + 2.1, w.z + rz * s * (half - 0.6));
      legs.push(leg);
      colliders.addCircle(leg.position.x, leg.position.z, 0.15);
    }
  }
  if (legs.length) {
    const frame = Mesh.MergeMeshes(legs, true, true);
    frame.name = "welcomeFrames";
    frame.material = plainMaterial(scene, "welcomeFrame", rgb(0.15, 0.17, 0.2), { metallic: 0.4, roughness: 0.5 });
    frame.isPickable = false;
    frame.receiveShadows = true;
    frame.freezeWorldMatrix();
    meshes.push(frame);
    casters.push(frame);
  }

  const count = Object.values(flagsBy).reduce((a, m) => a + m.length, 0);
  return {
    meshes,
    casters,
    count,
    signs: welcome.length,
    update(dt) {
      for (const p of plugins) p.time = (p.time + dt) % 1000;
    },
  };
}
