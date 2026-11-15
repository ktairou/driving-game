import { Matrix, Quaternion, Vector3 } from "@babylonjs/core";
import { GeometryBuilder } from "../geom.js";
import { mulberry32 } from "../noise.js";
import { plainMaterial, rgb } from "./materials.js";
import { ROAD_HALF_WIDTH } from "./layout.js";
import { DETAIL } from "./facades.js";
import { box, cylinder } from "./buildings.js";

// Things on the main-street pavements: awnings and hanging signs on the shops,
// cafe tables under the Paris awnings, post boxes, bins, bollards at the side
// streets and a bus stop on each main street.
//
// Across the pavement (metres from the street's centre line): parked cars
// reach about 5, lamps and flags stand at 5.8, people walk 6.2 to 8.6 and the
// buildings start at 9.6. So solid things go at the kerb (5.3 to 6.1, clear
// of lamps, flags and parked cars) or against the shop fronts (8.7 to 9.6).

const KERB = ROAD_HALF_WIDTH + 0.55;
const PAVE_UP = 0.16; // pavement top above the town's ground

// How high an awning's top edge is, and how far it reaches out, by style.
const AWNING = {
  british: { top: 2.92, out: 1.45, chance: 0.4 },
  paris: { top: 3.5, out: 1.8, chance: 0.85 },
  city: { top: 3.35, out: 1.6, chance: 0.45 },
  desert: { top: 2.92, out: 1.5, chance: 0.6 },
};

// Which hanging-sign picture suits a shop's name (cup, book, cross, scissors).
function signPicture(text, rand) {
  if (/cafe|tea|diner|bakery|bistro/i.test(text ?? "")) return 0;
  if (/book|news/i.test(text ?? "")) return 1;
  if (/chemist|drug|pharm/i.test(text ?? "")) return 2;
  if (/barber/i.test(text ?? "")) return 3;
  return Math.floor(rand() * 4);
}

// Copies a shape (`parts`: [colour, GeometryBuilder] pairs) to each of its
// places into one builder with vertex colours. There are few of each thing,
// so one static mesh for all of them is cheaper than a set of instances each.
function bake(target, parts, matrices) {
  target.extra ??= { name: "color", stride: 4, data: [] };
  for (const mx of matrices) {
    const m = mx.m;
    for (const [c, g] of parts) {
      const base = target.vertexCount;
      for (let i = 0; i < g.vertexCount; i++) {
        const [x, y, z] = [g.positions[i * 3], g.positions[i * 3 + 1], g.positions[i * 3 + 2]];
        const [nx, ny, nz] = [g.normals[i * 3], g.normals[i * 3 + 1], g.normals[i * 3 + 2]];
        target.positions.push(x * m[0] + y * m[4] + z * m[8] + m[12], x * m[1] + y * m[5] + z * m[9] + m[13], x * m[2] + y * m[6] + z * m[10] + m[14]);
        target.normals.push(nx * m[0] + ny * m[4] + nz * m[8], nx * m[1] + ny * m[5] + nz * m[9], nx * m[2] + ny * m[6] + nz * m[10]);
        target.uvs.push(g.uvs[i * 2], g.uvs[i * 2 + 1]);
        target.extra.data.push(c[0], c[1], c[2], 1);
      }
      for (const i of g.indices) target.indices.push(base + i);
    }
  }
}

const place = (x, y, z, yaw = 0) => Matrix.Compose(Vector3.One(), Quaternion.RotationYawPitchRoll(yaw, 0, 0), new Vector3(x, y, z));

const RED = [0.62, 0.05, 0.04];
const BLUE = [0.07, 0.17, 0.42];
const BLACK = [0.05, 0.05, 0.055];
const BIN = [0.09, 0.15, 0.11];
const STEEL = [0.45, 0.46, 0.47];
const SIGN = [0.75, 0.08, 0.06];
const IRON = [0.2, 0.21, 0.2];

// streets: [{ style, island, sx0, sx1, sz, ground, units, crossXs, parkSide, seed }]
// mats: { details, metal } (shared with the buildings); paint(material) gives its builder.
export function buildStreetFurniture(scene, colliders, streets, mats, paint) {
  const things = paint(plainMaterial(scene, "streetThings", rgb(1, 1, 1), { metallic: 0.3, roughness: 0.45 }));
  const glassMat = plainMaterial(scene, "shelterGlass", rgb(0.5, 0.6, 0.64), { roughness: 0.1 });
  glassMat.alpha = 0.32; // see-through panels
  const glassG = paint(glassMat);
  const where = { postUK: [], postUS: [], bins: [], bollards: [], shelters: [], tables: [] };
  const det = paint(mats.details);
  const bracket = paint(mats.metal);

  for (const st of streets) {
    const rand = mulberry32(st.seed);
    const { sx0, sx1, sz, style } = st;
    const y = st.ground + PAVE_UP;
    // Kerb places already taken: lamps and flags (both sides, to be safe).
    const busy = [];
    for (let x = sx0 + 10; x < sx1 - 5; x += 32) busy.push(x);
    for (let x = sx0 + 26; x < sx1 - 10; x += 64) busy.push(x);
    const clearOfPosts = (x, r) => busy.every((b) => Math.abs(b - x) > r);
    const onSide = (x, pad) => st.crossXs.some((c) => Math.abs(c - x) < pad);
    // Where each side street meets the main street (its road samples, grouped).
    const crossings = [];
    for (const cx of [...st.crossXs].sort((p, q) => p - q)) {
      const last = crossings[crossings.length - 1];
      if (last && cx - last.max < 10) last.max = cx;
      else crossings.push({ min: cx, max: cx });
    }
    // Between the spots where traffic.js may park a car (every 22 m from x0 + 14).
    const noParking = (x, half = 0) => {
      const m = (((x - sx0 - 14) % 22) + 22) % 22;
      return m - half >= 8.5 && m + half <= 13.5;
    };
    const fronted = (x, side) => st.units.some((u) => u.side === side && x > u.x0 - 1 && x < u.x1 + 1);
    const kerbOK = (x, side, half = 0.4) => noParking(x, half) && clearOfPosts(x, 2.5 + half) && !onSide(x, 14 + half) && fronted(x, side);

    // Awnings, cafe tables and hanging signs on the shop units.
    const aw = AWNING[style];
    for (const u of st.units) {
      if (u.type !== "shop" && u.type !== "archShop") continue;
      const scale = u.unitLen / 7;
      const w = u.wall;
      const out1 = -u.side; // from the wall towards the street, in z
      const zw = w.p[1];
      const hasAwning = rand() < aw.chance;
      if (hasAwning) {
        const s0 = Math.max(u.a, u.start + 0.4 * scale);
        const s1 = Math.min(u.b, u.start + u.unitLen - 0.4 * scale);
        if (s1 - s0 > 2) {
          const xa = w.p[0] + w.dx * s0;
          const xb = w.p[0] + w.dx * s1;
          const band = DETAIL.stripes[Math.floor(rand() * DETAIL.stripes.length)];
          awning(det, Math.min(xa, xb), Math.max(xa, xb), zw, out1, u.y + aw.top, aw.out, band);
          // Two cafe tables under some Paris awnings, against the shop front.
          if (style === "paris" && rand() < 0.16) {
            const mid = (xa + xb) / 2;
            for (const x of [mid - 1.1, mid + 1.1]) {
              const z = zw + out1 * 0.62;
              where.tables.push(place(x, y, z, out1 > 0 ? 0 : Math.PI));
              colliders.addCircle(x, z, 0.38);
            }
          }
        }
      }
      // A hanging sign on the shop's left pilaster (British and Paris shops).
      if ((style === "british" || style === "paris") && rand() < 0.3 && u.start >= u.a - 0.01) {
        const x = w.p[0] + w.dx * (u.start + 0.18 * scale);
        hangingSign(det, bracket, x, zw, out1, u.y + aw.top + (hasAwning ? 0.15 : -0.35), signPicture(u.text, rand));
      }
    }

    for (const side of [-1, 1]) {
      const zk = sz + side * KERB;
      const yaw = side > 0 ? 0 : Math.PI;
      // Bins along the kerb now and then.
      let last = -1e9;
      for (let x = sx0 + 20; x < sx1 - 10; x += 2) {
        if (x - last < 95 || !kerbOK(x, side)) continue;
        where.bins.push(place(x, y, zk, yaw));
        colliders.addCircle(x, zk, 0.3);
        last = x;
      }
      // A post box on each side of British and American main streets.
      if (style === "british" || style === "city") {
        const mid = (sx0 + sx1) / 2 + side * 30;
        for (let d = 0; d < 160; d += 2) {
          const x = mid + (d % 4 ? -d / 2 : d / 2);
          if (!kerbOK(x, side, 0.4) || where.bins.some((m) => Math.abs(m.m[12] - x) < 3 && Math.abs(m.m[14] - zk) < 1)) continue;
          (style === "british" ? where.postUK : where.postUS).push(place(x, y, zk, yaw));
          colliders.addCircle(x, zk, 0.32);
          break;
        }
      }
      // A bollard on each pavement corner at each side street.
      for (const c of crossings) {
        for (const x of [c.min - 9.6, c.max + 9.6]) {
          if (x < sx0 || x > sx1 || onSide(x, 9) || !clearOfPosts(x, 1.2)) continue;
          where.bollards.push(place(x, y, sz + side * (ROAD_HALF_WIDTH + 0.45)));
          colliders.addCircle(x, sz + side * (ROAD_HALF_WIDTH + 0.45), 0.12);
        }
      }
    }

    // One bus stop, on the side away from the park, near the middle.
    {
      const side = -st.parkSide;
      const mid = (sx0 + sx1) / 2;
      for (let k = 0; k < 1200; k++) {
        const x = mid + (k % 2 ? -1 : 1) * Math.ceil(k / 2) * 0.25;
        if (!kerbOK(x, side, 2.3) || where.bins.some((m) => Math.abs(m.m[12] - x) < 4.5 && Math.abs(m.m[14] - (sz + side * KERB)) < 1)) continue;
        const z = sz + side * ROAD_HALF_WIDTH;
        where.shelters.push(place(x, y, z, side > 0 ? 0 : Math.PI));
        colliders.addBox(x, sz + side * (ROAD_HALF_WIDTH + 0.72), 1.85, 0.42);
        colliders.addCircle(x + 2.3 * (side > 0 ? 1 : -1), sz + side * (ROAD_HALF_WIDTH + 0.35), 0.1);
        break;
      }
    }
  }

  // ---- The shapes (each made once, drawn at all its places) -------------------
  {
    // British pillar box: a red post with a domed cap and a black foot.
    const g = new GeometryBuilder();
    cylinder(g, 0, 0, 0.27, 0.12, 1.32, 8, false);
    cylinder(g, 0, 0, 0.31, 1.32, 1.42, 8);
    cylinder(g, 0, 0, 0.2, 1.42, 1.52, 8);
    const f = new GeometryBuilder();
    cylinder(f, 0, 0, 0.3, 0, 0.12, 8);
    f.addQuad([-0.13, 1.0, -0.275], [0.13, 1.0, -0.275], [0.13, 1.05, -0.275], [-0.13, 1.05, -0.275], [0, 0, -1], [0, 0], [1, 0], [1, 1], [0, 1]);
    bake(things, [[RED, g], [BLACK, f]], where.postUK);
  }
  {
    // American mailbox: a blue box with a rounded top, on short legs.
    const g = new GeometryBuilder();
    box(g, -0.28, 0.28, 0.25, 1.05, -0.24, 0.24, { top: false });
    const top = new GeometryBuilder();
    for (let i = 0; i < 6; i++) {
      const a0 = (i / 6) * Math.PI;
      const a1 = ((i + 1) / 6) * Math.PI;
      const p = (a) => [Math.cos(a) * 0.28, 1.05 + Math.sin(a) * 0.2];
      const [x0, y0] = p(a0);
      const [x1, y1] = p(a1);
      const n = [Math.cos((a0 + a1) / 2), Math.sin((a0 + a1) / 2), 0];
      top.addQuad([x0, y0, -0.24], [x1, y1, -0.24], [x1, y1, 0.24], [x0, y0, 0.24], n, [0, 0], [1, 0], [1, 1], [0, 1]);
    }
    for (const z of [-0.24, 0.24]) {
      const c = top.addVertex([0, 1.05, z], [0, 0, Math.sign(z)], [0.5, 0.5]);
      for (let i = 0; i < 6; i++) {
        const a0 = (i / 6) * Math.PI;
        const a1 = ((i + 1) / 6) * Math.PI;
        const j = top.addVertex([Math.cos(a0) * 0.28, 1.05 + Math.sin(a0) * 0.2, z], [0, 0, Math.sign(z)], [0, 0]);
        const k = top.addVertex([Math.cos(a1) * 0.28, 1.05 + Math.sin(a1) * 0.2, z], [0, 0, Math.sign(z)], [1, 0]);
        top.addTriangle(c, j, k, [0, 0, Math.sign(z)]);
      }
    }
    const legs = new GeometryBuilder();
    for (const lx of [-0.24, 0.2]) box(legs, lx, lx + 0.04, 0, 0.25, -0.2, 0.2);
    bake(things, [[BLUE, g], [BLUE, top], [BLACK, legs]], where.postUS);
  }
  {
    const g = new GeometryBuilder();
    cylinder(g, 0, 0, 0.25, 0, 0.94, 6);
    bake(things, [[BIN, g]], where.bins);
  }
  {
    const g = new GeometryBuilder();
    cylinder(g, 0, 0, 0.11, 0, 0.92, 6);
    bake(things, [[BLACK, g]], where.bollards);
  }
  {
    // Bus shelter, built with +z away from the road: glass back and ends,
    // a roof, a bench, and the stop's sign on a pole at the kerb.
    const frame = new GeometryBuilder();
    const glass = new GeometryBuilder();
    const sign = new GeometryBuilder();
    for (const x of [-1.8, 1.8]) for (const z of [0.36, 1.1]) box(frame, x - 0.04, x + 0.04, 0, 2.4, z - 0.04, z + 0.04);
    box(frame, -1.9, 1.9, 2.4, 2.48, 0.2, 1.3, { bottom: true });
    box(frame, -1.2, 1.2, 0.45, 0.5, 0.82, 1.06, { bottom: true });
    box(glass, -1.76, 1.76, 0.15, 2.3, 1.08, 1.12, { bottom: true });
    for (const x of [-1.8, 1.8]) box(glass, x - 0.02, x + 0.02, 0.15, 2.3, 0.4, 1.07);
    box(frame, 2.27, 2.33, 0, 2.6, 0.32, 0.38);
    box(sign, 2.12, 2.48, 2.3, 2.85, 0.33, 0.37, { bottom: true });
    bake(things, [[STEEL, frame], [SIGN, sign]], where.shelters);
    bake(glassG, [[[1, 1, 1], glass]], where.shelters);
  }
  {
    // Cafe table with two chairs, built with +z away from the road.
    const g = new GeometryBuilder();
    cylinder(g, 0, 0, 0.32, 0.7, 0.75, 6);
    cylinder(g, 0, 0, 0.03, 0, 0.7, 3, false);
    for (const x of [-0.55, 0.55]) {
      // Each chair: a seat on a solid base, and a back.
      box(g, x - 0.19, x + 0.19, 0, 0.46, -0.19, 0.19);
      const bx = x + (x < 0 ? -0.2 : 0.2);
      box(g, bx - 0.025, bx + 0.025, 0.46, 0.85, -0.19, 0.19, { top: false });
    }
    bake(things, [[IRON, g]], where.tables);
  }
  return Object.fromEntries(Object.entries(where).map(([k, v]) => [k, v.length]));
}

// A sloping fabric awning on a shop front: the slope, a hanging valance and
// closed ends. `out` (+1 or -1) is which way along z the street is.
function awning(g, xa, xb, zw, out, top, reach, band) {
  const drop = 0.62;
  const val = 0.3;
  const zf = zw + out * reach;
  const yf = top - drop;
  const v0 = band[0] + 0.004;
  const v1 = band[1] - 0.004;
  const u = (x) => x / 4;
  const l = Math.hypot(reach, drop);
  const nSlope = [0, reach / l, (out * drop) / l];
  g.addQuad([xa, top, zw], [xb, top, zw], [xb, yf, zf], [xa, yf, zf], nSlope, [u(xa), v1], [u(xb), v1], [u(xb), v0], [u(xa), v0]);
  g.addQuad([xa, yf, zf], [xb, yf, zf], [xb, yf - val, zf], [xa, yf - val, zf], [0, 0, out], [u(xa), v1], [u(xb), v1], [u(xb), v0], [u(xa), v0]);
  for (const [x, nx] of [[xa, -1], [xb, 1]]) {
    const i = g.addVertex([x, top, zw], [nx, 0, 0], [0.02, v1]);
    const j = g.addVertex([x, yf, zf], [nx, 0, 0], [0.02, (v0 + v1) / 2]);
    const k = g.addVertex([x, yf - val, zf], [nx, 0, 0], [0.02, v0]);
    g.addTriangle(i, j, k, [nx, 0, 0]);
  }
}

// A sign hanging from an iron bracket, standing out square from the wall.
function hangingSign(det, bracket, x, zw, out, y, pic) {
  const z0 = zw + out * 0.3;
  const z1 = zw + out * 0.95;
  box(bracket, x - 0.025, x + 0.025, y + 0.5, y + 0.56, Math.min(zw, zw + out * 1.05), Math.max(zw, zw + out * 1.05), { bottom: true });
  const [u0, u1] = [pic / 4 + 0.01, (pic + 1) / 4 - 0.01];
  const [v0, v1] = [DETAIL.signs[0] + 0.01, DETAIL.signs[1] - 0.01];
  const za = Math.min(z0, z1);
  const zb = Math.max(z0, z1);
  for (const sx of [-1, 1]) {
    const xf = x + sx * 0.03;
    // Picture faces (each reads the right way round from its own side).
    const [zl, zr] = sx > 0 ? [za, zb] : [zb, za];
    det.addQuad([xf, y, zl], [xf, y, zr], [xf, y + 0.5, zr], [xf, y + 0.5, zl], [sx, 0, 0], [u0, v0], [u1, v0], [u1, v1], [u0, v1]);
  }
  // Edges of the board in the dark frame colour.
  const e = [pic / 4 + 0.004, DETAIL.signs[0] + 0.004];
  const edge = (p0, p1, p2, p3, n) => det.addQuad(p0, p1, p2, p3, n, e, e, e, e);
  edge([x - 0.03, y + 0.5, za], [x + 0.03, y + 0.5, za], [x + 0.03, y + 0.5, zb], [x - 0.03, y + 0.5, zb], [0, 1, 0]);
  edge([x - 0.03, y, za], [x + 0.03, y, za], [x + 0.03, y + 0.5, za], [x - 0.03, y + 0.5, za], [0, 0, -1]);
  edge([x + 0.03, y, zb], [x - 0.03, y, zb], [x - 0.03, y + 0.5, zb], [x + 0.03, y + 0.5, zb], [0, 0, 1]);
  edge([x - 0.03, y, za], [x + 0.03, y, za], [x + 0.03, y, zb], [x - 0.03, y, zb], [0, -1, 0]);
}
