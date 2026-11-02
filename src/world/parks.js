import { DynamicTexture, PBRMaterial, MeshBuilder, Mesh, Matrix, Quaternion, Vector3 } from "@babylonjs/core";
import { GeometryBuilder } from "../geom.js";
import { mulberry32 } from "../noise.js";
import { surfaceMaterial, plainMaterial, rgb } from "./materials.js";

// A big park beside every town's main street (the town leaves the room):
// a hedge all round with a way in from the street, a path from there to a
// fountain in the middle, a path across and a ring path round it, benches,
// flower beds, lamps that light up at night, a name board, and lots of trees.
// The trees are handed to the nature builder so they're drawn with the rest.
//
// Each park has its own frame: u runs along the street (it's just x), w is how
// far in from the street edge.

const PATH_W = 4;
const RING_W = 3;
const PLAZA_R = 11;
const HEDGE_H = 1.1;
const HEDGE_D = 1.2;
const GATE = 4.5; // half the width of the way in

export function parkName(t) {
  if (t.style === "paris") return `Parc de ${t.name}`;
  if (t.style === "desert") return `${t.name} Gardens`;
  return `${t.name} Park`;
}

function flowerTexture(scene) {
  const size = 256;
  const t = new DynamicTexture("flowerBed", { width: size, height: size }, scene, true);
  const c = t.getContext();
  c.fillStyle = "#33552a";
  c.fillRect(0, 0, size, size);
  const rand = mulberry32(919);
  for (let i = 0; i < 420; i++) {
    c.fillStyle = ["#2f5d27", "#4a7d34", "#264d20", "#5b8a3a"][i % 4];
    c.beginPath();
    c.arc(rand() * size, rand() * size, 4 + rand() * 6, 0, Math.PI * 2);
    c.fill();
  }
  // Flowers in clumps of one colour, like a planted bed.
  const colours = ["#d8263a", "#f2c12e", "#f4f1ea", "#8a4fc9", "#ef6fa8", "#f08a24"];
  for (let k = 0; k < 40; k++) {
    const colour = colours[k % colours.length];
    const fx = rand() * size;
    const fy = rand() * size;
    for (let i = 0; i < 9; i++) {
      c.fillStyle = colour;
      c.beginPath();
      c.arc(fx + (rand() - 0.5) * 26, fy + (rand() - 0.5) * 26, 2 + rand() * 2.2, 0, Math.PI * 2);
      c.fill();
    }
  }
  t.update(true);
  return t;
}

function nameBoard(scene, text) {
  const t = new DynamicTexture(`parkSign_${text}`, { width: 512, height: 128 }, scene, true);
  const c = t.getContext();
  c.fillStyle = "#1f4a2c";
  c.fillRect(0, 0, 512, 128);
  c.strokeStyle = "#e9e2c8";
  c.lineWidth = 6;
  c.strokeRect(10, 10, 492, 108);
  c.fillStyle = "#f4efdc";
  c.textAlign = "center";
  c.textBaseline = "middle";
  let px = 58;
  do {
    c.font = `bold ${px}px Georgia, "Times New Roman", serif`;
    px -= 2;
  } while (c.measureText(text).width > 450 && px > 20);
  c.fillText(text, 256, 68);
  t.update(true);
  const m = new PBRMaterial(`parkSignMat_${text}`, scene);
  m.albedoTexture = t;
  m.metallic = 0;
  m.roughness = 0.6;
  return m;
}

// A strip of path laid over the ground along a line of points.
function pathStrip(g, world, pts, hw, lift, closed = false) {
  const n = pts.length;
  let prev = null;
  for (let i = 0; i < n; i++) {
    const a = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
    const b = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const tx = b[0] - a[0];
    const tz = b[1] - a[1];
    const l = Math.hypot(tx, tz) || 1;
    const nx = -tz / l;
    const nz = tx / l;
    const side = (s) => {
      const x = pts[i][0] + nx * hw * s;
      const z = pts[i][1] + nz * hw * s;
      return g.addVertex([x, world.getHeight(x, z) + lift, z], [0, 1, 0], [x / 3, z / 3]);
    };
    const cur = [side(-1), side(1)];
    if (prev) {
      g.addTriangle(prev[0], prev[1], cur[1], [0, 1, 0]);
      g.addTriangle(prev[0], cur[1], cur[0], [0, 1, 0]);
    }
    prev = cur;
  }
  if (closed) {
    const first = [0, 1].map((k) => g.vertexCount - n * 2 + k);
    g.addTriangle(prev[0], prev[1], first[1], [0, 1, 0]);
    g.addTriangle(prev[0], first[1], first[0], [0, 1, 0]);
  }
}

// A flat disc laid over the ground (the paved space round the fountain, the tops of round beds).
function disc(g, world, cx, cz, r, lift, uvScale, flat = null) {
  const seg = 32;
  const y = (x, z) => (flat ?? world.getHeight(x, z)) + lift;
  const c = g.addVertex([cx, y(cx, cz), cz], [0, 1, 0], [cx / uvScale, cz / uvScale]);
  const ring = [];
  for (let k = 0; k < seg; k++) {
    const a = (k / seg) * Math.PI * 2;
    const x = cx + Math.cos(a) * r;
    const z = cz + Math.sin(a) * r;
    ring.push(g.addVertex([x, y(x, z), z], [0, 1, 0], [x / uvScale, z / uvScale]));
  }
  for (let k = 0; k < seg; k++) g.addTriangle(c, ring[k], ring[(k + 1) % seg], [0, 1, 0]);
}

// An upright band round a circle (the stone edge of a round bed).
function band(g, cx, cz, r, y0, y1) {
  const seg = 32;
  for (let k = 0; k < seg; k++) {
    const a0 = (k / seg) * Math.PI * 2;
    const a1 = ((k + 1) / seg) * Math.PI * 2;
    const p = (a, y) => [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r];
    const am = (a0 + a1) / 2;
    g.addQuad(p(a0, y0), p(a1, y0), p(a1, y1), p(a0, y1), [Math.cos(am), 0, Math.sin(am)], [a0 * r, 0], [a1 * r, 0], [a1 * r, 0.4], [a0 * r, 0.4]);
  }
}

// A box with its bottom following the ground (for hedges).
function groundBox(g, world, x0, x1, z0, z1, h) {
  const bottom = (x, z) => world.getHeight(x, z) - 0.3;
  const top = Math.max(bottom(x0, z0), bottom(x1, z0), bottom(x1, z1), bottom(x0, z1)) + 0.3 + h;
  const c = [
    [x0, z0],
    [x1, z0],
    [x1, z1],
    [x0, z1],
  ];
  const uv = (a, b) => [a / 2, b / 2];
  g.addQuad([x0, top, z0], [x1, top, z0], [x1, top, z1], [x0, top, z1], [0, 1, 0], uv(x0, z0), uv(x1, z0), uv(x1, z1), uv(x0, z1));
  const normals = [
    [0, 0, -1],
    [1, 0, 0],
    [0, 0, 1],
    [-1, 0, 0],
  ];
  for (let k = 0; k < 4; k++) {
    const [ax, az] = c[k];
    const [bx, bz] = c[(k + 1) % 4];
    const len = Math.hypot(bx - ax, bz - az);
    g.addQuad([ax, bottom(ax, az), az], [bx, bottom(bx, bz), bz], [bx, top, bz], [ax, top, az], normals[k], [0, 0], [len / 2, 0], [len / 2, h / 2], [0, h / 2]);
  }
}

function benchTemplates(scene) {
  const wood = plainMaterial(scene, "benchWood", rgb(0.45, 0.29, 0.16), { roughness: 0.75 });
  const iron = plainMaterial(scene, "benchIron", rgb(0.09, 0.1, 0.11), { metallic: 0.6, roughness: 0.5 });
  const parts = [];
  const slat = (y, z, h, d, tilt = 0) => {
    const b = MeshBuilder.CreateBox("slat", { width: 1.9, height: h, depth: d }, scene);
    b.rotation.x = tilt;
    b.position.set(0, y, z);
    parts.push(b);
  };
  for (const z of [-0.14, 0, 0.14]) slat(0.46, z, 0.04, 0.12);
  for (const y of [0.66, 0.8]) slat(y, -0.24 - (y - 0.6) * 0.15, 0.1, 0.03, -0.15);
  const seat = Mesh.MergeMeshes(parts, true, true);
  seat.name = "benchSeats";
  seat.material = wood;
  const legs = [];
  for (const x of [-0.82, 0.82]) {
    const leg = MeshBuilder.CreateBox("benchLeg", { width: 0.06, height: 0.88, depth: 0.08 }, scene);
    leg.position.set(x, 0.44, -0.22);
    const front = MeshBuilder.CreateBox("benchLegF", { width: 0.06, height: 0.44, depth: 0.08 }, scene);
    front.position.set(x, 0.22, 0.16);
    const rail = MeshBuilder.CreateBox("benchRail", { width: 0.06, height: 0.06, depth: 0.5 }, scene);
    rail.position.set(x, 0.43, -0.03);
    legs.push(leg, front, rail);
  }
  const frame = Mesh.MergeMeshes(legs, true, true);
  frame.name = "benchFrames";
  frame.material = iron;
  return [seat, frame];
}

function lampTemplates(scene, glow) {
  const metal = plainMaterial(scene, "parkLampMetal", rgb(0.07, 0.08, 0.08), { metallic: 0.6, roughness: 0.45 });
  const pole = MeshBuilder.CreateCylinder("parkLampPole", { height: 4.1, diameterTop: 0.09, diameterBottom: 0.16, tessellation: 8 }, scene);
  pole.position.y = 2.05;
  const cap = MeshBuilder.CreateCylinder("parkLampCap", { height: 0.18, diameterTop: 0.05, diameterBottom: 0.5, tessellation: 8 }, scene);
  cap.position.y = 4.62;
  const base = MeshBuilder.CreateCylinder("parkLampBase", { height: 0.4, diameter: 0.3, tessellation: 8 }, scene);
  base.position.y = 0.2;
  const body = Mesh.MergeMeshes([pole, cap, base], true, true);
  body.name = "parkLamps";
  body.material = metal;
  const head = MeshBuilder.CreateCylinder("parkLampHeads", { height: 0.45, diameterTop: 0.42, diameterBottom: 0.28, tessellation: 8 }, scene);
  head.position.y = 4.3;
  head.bakeCurrentTransformIntoVertices();
  head.material = glow;
  return [body, head];
}

export function buildParks(scene, world, colliders, parks, quality, glow) {
  const pathMat = surfaceMaterial(scene, "parkPath", "pavers", { tint: rgb(0.9, 0.83, 0.72) });
  pathMat.zOffset = -2;
  const lawnMat = surfaceMaterial(scene, "parkLawn", "grass", { tint: rgb(0.8, 0.95, 0.72) });
  lawnMat.zOffset = -1;
  const stone = surfaceMaterial(scene, "parkStone", "sandstone", { tint: rgb(0.92, 0.9, 0.86) });
  const water = plainMaterial(scene, "fountainWater", rgb(0.16, 0.3, 0.36), { roughness: 0.12 });
  const hedgeMat = surfaceMaterial(scene, "hedge", "grass", { tint: rgb(0.72, 1.0, 0.6), bump: 1.2 });
  const flowers = new PBRMaterial("flowers", scene);
  flowers.albedoTexture = flowerTexture(scene);
  flowers.metallic = 0;
  flowers.roughness = 0.85;
  const signPostMat = plainMaterial(scene, "parkSignPost", rgb(0.12, 0.14, 0.12), { metallic: 0.4, roughness: 0.5 });

  const paths = new GeometryBuilder();
  const lawn = new GeometryBuilder();
  const stoneG = new GeometryBuilder();
  const waterG = new GeometryBuilder();
  const hedge = new GeometryBuilder();
  const beds = new GeometryBuilder();
  const benchMats = [];
  const lampMats = [];
  const lampSpots = [];
  const walkSpots = [];
  const trees = [];
  const extras = []; // fountains and name boards: [mesh, caster?]
  const perPark = Math.round(quality.trees / 40);

  for (const p of parks) {
    const rand = mulberry32(p.seed);
    const t = p.town;
    const D = p.z1 - p.z0;
    const W = p.x1 - p.x0;
    const cx = (p.x0 + p.x1) / 2;
    const zAt = (w) => (p.side > 0 ? p.z0 + w : p.z1 - w);
    const toward = -p.side; // the street is this way in z
    const cz = zAt(D / 2);
    const R = Math.max(PLAZA_R + 10, Math.min(W, D) / 2 - 12);
    const y0 = world.getHeight(cx, cz);
    const bench = (x, z, faceX, faceZ) => {
      const yaw = Math.atan2(faceX - x, faceZ - z);
      benchMats.push(Matrix.Compose(Vector3.One(), Quaternion.RotationYawPitchRoll(yaw, 0, 0), new Vector3(x, world.getHeight(x, z) + 0.02, z)));
      colliders.addBox(x, z, 0.95, 0.3, yaw);
    };
    const lamp = (x, z) => {
      const y = world.getHeight(x, z);
      lampMats.push(Matrix.Translation(x, y, z));
      lampSpots.push({ x, y, z, lightHeight: 4.3 });
      colliders.addCircle(x, z, 0.15);
    };

    // Desert parks get a watered lawn; elsewhere the ground is grass already.
    if (t.style === "desert") {
      const nu = Math.ceil(W / 6);
      const nw = Math.ceil(D / 6);
      const pt = (i, j) => {
        const x = p.x0 + (i / nu) * W;
        const z = p.z0 + (j / nw) * D;
        return [x, world.getHeight(x, z) + 0.03, z];
      };
      const uv = (q) => [q[0] / 4, q[2] / 4];
      for (let j = 0; j < nw; j++) {
        for (let i = 0; i < nu; i++) {
          const q = [pt(i, j), pt(i + 1, j), pt(i + 1, j + 1), pt(i, j + 1)];
          lawn.addQuad(...q, [0, 1, 0], ...q.map(uv));
        }
      }
    }

    // Paths: in from the street to the far side, across, and a ring round the fountain.
    const line = (x0, z0, x1, z1) => {
      const n = Math.max(2, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 2));
      return Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, z0 + ((z1 - z0) * i) / n]);
    };
    pathStrip(paths, world, line(cx, zAt(-1.5), cx, zAt(D - 4)), PATH_W / 2, 0.07);
    pathStrip(paths, world, line(p.x0 + 4, cz, p.x1 - 4, cz), PATH_W / 2, 0.065);
    const ring = Array.from({ length: 72 }, (_, k) => [cx + Math.cos((k / 72) * Math.PI * 2) * R, cz + Math.sin((k / 72) * Math.PI * 2) * R]);
    pathStrip(paths, world, ring, RING_W / 2, 0.06, true);
    disc(paths, world, cx, cz, PLAZA_R, 0.075, 3);

    // The fountain.
    {
      const parts = [];
      const drum = MeshBuilder.CreateCylinder("fBasin", { height: 0.75, diameter: 10, tessellation: 40 }, scene);
      drum.position.set(cx, y0 + 0.3, cz);
      const rim = MeshBuilder.CreateTorus("fRim", { diameter: 9.7, thickness: 0.55, tessellation: 40 }, scene);
      rim.position.set(cx, y0 + 0.7, cz);
      const column = MeshBuilder.CreateCylinder("fColumn", { height: 2.3, diameterTop: 0.6, diameterBottom: 1.1, tessellation: 16 }, scene);
      column.position.set(cx, y0 + 1.6, cz);
      const bowl = MeshBuilder.CreateCylinder("fBowl", { height: 0.55, diameterTop: 3.4, diameterBottom: 0.9, tessellation: 24 }, scene);
      bowl.position.set(cx, y0 + 2.95, cz);
      const top = MeshBuilder.CreateCylinder("fTop", { height: 1.1, diameterTop: 0.2, diameterBottom: 0.45, tessellation: 12 }, scene);
      top.position.set(cx, y0 + 3.7, cz);
      parts.push(drum, rim, column, bowl, top);
      const f = Mesh.MergeMeshes(parts, true, true);
      f.name = "fountain";
      f.material = stone;
      extras.push([f, true]);
      disc(waterG, world, cx, cz, 4.6, 0.72, 4, y0);
      disc(waterG, world, cx, cz, 1.5, 3.2, 4, y0);
      colliders.addCircle(cx, cz, 5.2);
    }

    // Benches round the fountain, facing it.
    for (let k = 0; k < 8; k++) {
      const a = (Math.floor(k / 2) * Math.PI) / 2 + Math.PI / 4 + (k % 2 ? 0.28 : -0.28);
      bench(cx + Math.cos(a) * (PLAZA_R - 1.3), cz + Math.sin(a) * (PLAZA_R - 1.3), cx, cz);
    }
    // ...along the straight paths, facing the path...
    for (let w = 10; w < D - 8; w += 15) {
      if (Math.abs(w - D / 2) < R + 4) continue;
      const s = w % 2 ? 1 : -1;
      bench(cx + s * (PATH_W / 2 + 1.1), zAt(w), cx, zAt(w));
    }
    for (let x = p.x0 + 10; x < p.x1 - 8; x += 16) {
      if (Math.abs(x - cx) < R + 4) continue;
      const s = Math.round(x) % 2 ? 1 : -1;
      bench(x, cz + s * (PATH_W / 2 + 1.1), x, cz);
    }
    // ...and outside the ring, looking in.
    for (let k = 0; k < 8; k++) {
      const a = ((k + 0.5) / 8) * Math.PI * 2;
      bench(cx + Math.cos(a) * (R + RING_W / 2 + 1.1), cz + Math.sin(a) * (R + RING_W / 2 + 1.1), cx, cz);
    }

    // Lamps round the ring, the fountain and the way in.
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
      lamp(cx + Math.cos(a) * (R - RING_W / 2 - 1), cz + Math.sin(a) * (R - RING_W / 2 - 1));
    }
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      lamp(cx + Math.cos(a) * (PLAZA_R + 1.2), cz + Math.sin(a) * (PLAZA_R + 1.2));
    }
    lamp(cx - PATH_W / 2 - 1, zAt(5));
    lamp(cx + PATH_W / 2 + 1, zAt(5));

    // Flower beds: four round ones inside the ring, two long ones by the way in.
    const bedSpots = [];
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      const r = (PLAZA_R + R) / 2;
      const bx = cx + Math.cos(a) * r;
      const bz = cz + Math.sin(a) * r;
      const by = world.getHeight(bx, bz);
      disc(beds, world, bx, bz, 3.4, 0.32, 3, by);
      band(stoneG, bx, bz, 3.45, by - 0.2, by + 0.34);
      bedSpots.push([bx, bz, 3.6]);
    }
    for (const s of [-1, 1]) {
      const bx0 = cx + s * (PATH_W / 2 + 1.5);
      const bx1 = cx + s * (PATH_W / 2 + 4);
      const w0 = 8;
      const w1 = Math.min(D / 2 - R - 4, 24);
      if (w1 - w0 < 4) continue;
      const za = Math.min(zAt(w0), zAt(w1));
      const zb = Math.max(zAt(w0), zAt(w1));
      const xa = Math.min(bx0, bx1);
      const xb = Math.max(bx0, bx1);
      const by = world.getHeight((xa + xb) / 2, (za + zb) / 2);
      beds.addQuad([xa, by + 0.32, za], [xb, by + 0.32, za], [xb, by + 0.32, zb], [xa, by + 0.32, zb], [0, 1, 0], [xa / 3, za / 3], [xb / 3, za / 3], [xb / 3, zb / 3], [xa / 3, zb / 3]);
      const e = (ax, az, bx, bz, n) => stoneG.addQuad([ax, by - 0.2, az], [bx, by - 0.2, bz], [bx, by + 0.34, bz], [ax, by + 0.34, az], n, [0, 0], [Math.hypot(bx - ax, bz - az) / 2, 0], [Math.hypot(bx - ax, bz - az) / 2, 0.3], [0, 0.3]);
      e(xa, za, xb, za, [0, 0, -1]);
      e(xb, za, xb, zb, [1, 0, 0]);
      e(xb, zb, xa, zb, [0, 0, 1]);
      e(xa, zb, xa, za, [-1, 0, 0]);
      bedSpots.push([(xa + xb) / 2, (za + zb) / 2, Math.hypot(xb - xa, zb - za) / 2 + 0.5]);
    }

    // A hedge all the way round, with a gap for the way in.
    const hedgeRun = (x0, x1, z0, z1) => {
      const along = x1 - x0 > z1 - z0;
      const len = along ? x1 - x0 : z1 - z0;
      const n = Math.max(1, Math.round(len / 6));
      for (let i = 0; i < n; i++) {
        const a0 = (len * i) / n;
        const a1 = (len * (i + 1)) / n;
        if (along) groundBox(hedge, world, x0 + a0, x0 + a1, z0, z1, HEDGE_H);
        else groundBox(hedge, world, x0, x1, z0 + a0, z0 + a1, HEDGE_H);
      }
      colliders.addBox((x0 + x1) / 2, (z0 + z1) / 2, (x1 - x0) / 2, (z1 - z0) / 2);
    };
    const zs0 = Math.min(zAt(0), zAt(HEDGE_D));
    const zs1 = Math.max(zAt(0), zAt(HEDGE_D));
    hedgeRun(p.x0, cx - GATE, zs0, zs1);
    hedgeRun(cx + GATE, p.x1, zs0, zs1);
    const zf0 = Math.min(zAt(D - HEDGE_D), zAt(D));
    const zf1 = Math.max(zAt(D - HEDGE_D), zAt(D));
    hedgeRun(p.x0, p.x1, zf0, zf1);
    hedgeRun(p.x0, p.x0 + HEDGE_D, p.z0 + HEDGE_D, p.z1 - HEDGE_D);
    hedgeRun(p.x1 - HEDGE_D, p.x1, p.z0 + HEDGE_D, p.z1 - HEDGE_D);

    // The name board by the way in, facing the street.
    {
      const name = parkName(t);
      const mat = nameBoard(scene, name);
      const bx = cx + GATE + 2.6;
      const bz = zAt(-0.4);
      const gy = world.getHeight(bx, bz);
      const posts = [];
      for (const s of [-1, 1]) {
        const post = MeshBuilder.CreateBox("signPost", { width: 0.1, height: 2.4, depth: 0.1 }, scene);
        post.position.set(bx + s * 1.5, gy + 1.1, bz);
        posts.push(post);
      }
      const back = MeshBuilder.CreateBox("signBack", { width: 3.6, height: 0.95, depth: 0.08 }, scene);
      back.position.set(bx, gy + 1.75, bz - toward * 0.02);
      posts.push(back);
      const frame = Mesh.MergeMeshes(posts, true, true);
      frame.material = signPostMat;
      extras.push([frame, true]);
      const g = new GeometryBuilder();
      const n = [0, 0, toward];
      // Text reads left to right from the street side.
      const l = toward < 0 ? bx - 1.75 : bx + 1.75;
      const r = toward < 0 ? bx + 1.75 : bx - 1.75;
      const z = bz + toward * 0.05;
      g.addQuad([l, gy + 1.3, z], [r, gy + 1.3, z], [r, gy + 2.2, z], [l, gy + 2.2, z], n, [0, 0], [1, 0], [1, 1], [0, 1]);
      const face = g.toMesh(`parkSign_${name}`, scene);
      face.material = mat;
      extras.push([face, false]);
      colliders.addBox(bx, bz, 1.8, 0.2);
    }

    // People stroll along the path across (either side of the fountain).
    walkSpots.push({ island: t.island, x0: p.x0 + 6, x1: cx - PLAZA_R - 2, z: cz + 1, y: world.getHeight((p.x0 + cx) / 2, cz) + 0.07 });
    walkSpots.push({ island: t.island, x0: cx + PLAZA_R + 2, x1: p.x1 - 6, z: cz - 1, y: world.getHeight((p.x1 + cx) / 2, cz) + 0.07 });

    // Trees: thick round the outside, scattered on the lawns inside the ring.
    const spots = [];
    const step = 6.5;
    for (let z = p.z0 + 4; z < p.z1 - 4; z += step) {
      for (let x = p.x0 + 4; x < p.x1 - 4; x += step) {
        const px = x + (rand() - 0.5) * step * 0.8;
        const pz = z + (rand() - 0.5) * step * 0.8;
        const w = p.side > 0 ? pz - p.z0 : p.z1 - pz;
        const dc = Math.hypot(px - cx, pz - cz);
        if (w < 7 || w > D - 4 || px < p.x0 + 3.5 || px > p.x1 - 3.5) continue;
        if (Math.abs(px - cx) < PATH_W / 2 + 3.5 || Math.abs(pz - cz) < PATH_W / 2 + 3.5) continue;
        if (Math.abs(dc - R) < RING_W / 2 + 4 || dc < PLAZA_R + 5) continue;
        if (bedSpots.some(([bx, bz, br]) => Math.hypot(px - bx, pz - bz) < br + 2.5)) continue;
        const keep = dc > R ? 0.85 : 0.3;
        if (rand() > keep) continue;
        spots.push({ x: px, z: pz });
      }
    }
    for (let i = spots.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [spots[i], spots[j]] = [spots[j], spots[i]];
    }
    for (const s of spots.slice(0, perPark)) trees.push({ ...s, y: world.getHeight(s.x, s.z) });
  }

  const meshes = [];
  const casters = [];
  const add = (g, name, mat, cast) => {
    if (!g.indices.length) return;
    const m = g.toMesh(name, scene);
    m.material = mat;
    meshes.push(m);
    if (cast) casters.push(m);
  };
  add(lawn, "parkLawns", lawnMat, false);
  add(paths, "parkPaths", pathMat, false);
  add(stoneG, "parkStone", stone, true);
  add(waterG, "fountainWater", water, false);
  add(hedge, "hedges", hedgeMat, true);
  add(beds, "flowerBeds", flowers, false);
  for (const [m, cast] of extras) {
    meshes.push(m);
    if (cast) casters.push(m);
  }
  const instance = (template, mats) => {
    const buf = new Float32Array(mats.length * 16);
    mats.forEach((m, i) => m.copyToArray(buf, i * 16));
    template.thinInstanceSetBuffer("matrix", buf, 16, true);
    meshes.push(template);
    casters.push(template);
  };
  if (benchMats.length) for (const t of benchTemplates(scene)) instance(t, benchMats);
  if (lampMats.length) for (const t of lampTemplates(scene, glow)) instance(t, lampMats);
  for (const m of meshes) {
    m.receiveShadows = true;
    m.isPickable = false;
    m.freezeWorldMatrix();
  }
  return { meshes, casters, trees, lampSpots, walkSpots };
}
