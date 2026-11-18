import { GeometryBuilder, normalize, cross, sub } from "../geom.js";
import { surfaceMaterial, plainMaterial, rgb } from "./materials.js";
import { ROAD_HALF_WIDTH, ROAD_SAMPLE_STEP } from "./layout.js";
import { SEA_FLOOR } from "./islands.js";

// Tower Bridge, built in code (the downloaded model's gateway was far too
// narrow for a two-lane road). It carries the road to France across the whole
// sea: a small tower at each shore, then pairs of stone towers with a
// pointed-arch gateway the road runs through and two high walkways joining
// them, and pale blue chains hung from tower to tower all the way across, with
// blue and white railings. It uses textures the game already has, so it costs
// no extra graphics memory. Its stone, ironwork and deck are merged into one
// mesh per material for each stretch (one per pair of towers), so only the
// stretches near you cast shadows (see main.js); the rest is merged into one
// mesh per material for the whole bridge.
//
// Sizes are in metres. `a` runs along the road from a tower's middle, `w`
// across it (+w is the road's right), `y` up from the road surface. The road
// over it is level (see levelSpan in network.js); the parts that run along the
// road follow its samples, the towers stand square to it.

const TILE = 4; // metres per stone texture repeat
const KERB = ROAD_HALF_WIDTH + 0.15; // footway edge: the same line as the plain bridge's walls
const RAIL = 7.3; // railings at the outer edge of the footway
const GIRDER = 9.6; // outer face of the blue edge girders
const CHAIN = 9; // chains and hangers hang over the edge girders
// Along the road, in road samples (2 m each): a tower is 20 m long and the two
// in a pair stand 64 m apart inside (the lifting span); an end tower is 12 m.
const TOWER_HALF = 5;
const PAIR_HALF = 21; // a pair's middle to each of its towers' middles
const END_LEN = 6;
// The deck is level and very nearly straight, so its long parts are built in
// 8 m pieces (posts every 4 m, chain links 4 m long) to keep the triangle count down.
const DECK_STEP = 4;
const POST_STEP = 2;
const CHAIN_STEP = 2;
const CHAIN_TOP = 36; // where the chains meet the towers
const CHAIN_LOW = 5; // the lowest a chain hangs between two pairs
const CHAIN_END = 9.5; // where the chains come down onto the end towers
// The gateway: 12 m wide at the road (the road is 10 m), springing at 7 m and
// coming to a point at about 14.3 m.
const GATE = { half: 6, spring: 7, r: 7.5, top: 16 };
const TOWER = { half: 10, leg: 13, body: 44, turret: 1.9 };
const WALKWAY = { w0: 6, w1: 11, y0: 34, y1: 40 };

// --- Small geometry helpers ----------------------------------------------------------
// A frame stands at a road sample: o is the road surface there, f along the
// road, r across it (to the right).
function frameAt(F, k) {
  const { c, right } = F[k];
  return { o: c, r: right, f: [-right[2], 0, right[0]] };
}
const P = (fr, a, w, y) => [fr.o[0] + fr.f[0] * a + fr.r[0] * w, fr.o[1] + y, fr.o[2] + fr.f[2] * a + fr.r[2] * w];
const dirOf = (fr, a, w, y) => [fr.f[0] * a + fr.r[0] * w, y, fr.f[2] * a + fr.r[2] * w];

// A box, square to the frame. `skip` names faces to leave out ("a0 a1 w0 w1 y0 y1").
function box(g, fr, a0, a1, w0, w1, y0, y1, skip = "") {
  const t = TILE;
  const q = (face, p0, p1, p2, p3, n, uv) => !skip.includes(face) && g.addQuad(p0, p1, p2, p3, n, ...uv);
  const uvs = (s0, s1, v0, v1) => [[s0 / t, v0 / t], [s1 / t, v0 / t], [s1 / t, v1 / t], [s0 / t, v1 / t]];
  q("a1", P(fr, a1, w0, y0), P(fr, a1, w1, y0), P(fr, a1, w1, y1), P(fr, a1, w0, y1), dirOf(fr, 1, 0, 0), uvs(w0, w1, y0, y1));
  q("a0", P(fr, a0, w0, y0), P(fr, a0, w1, y0), P(fr, a0, w1, y1), P(fr, a0, w0, y1), dirOf(fr, -1, 0, 0), uvs(w0, w1, y0, y1));
  q("w1", P(fr, a0, w1, y0), P(fr, a1, w1, y0), P(fr, a1, w1, y1), P(fr, a0, w1, y1), dirOf(fr, 0, 1, 0), uvs(a0, a1, y0, y1));
  q("w0", P(fr, a0, w0, y0), P(fr, a1, w0, y0), P(fr, a1, w0, y1), P(fr, a0, w0, y1), dirOf(fr, 0, -1, 0), uvs(a0, a1, y0, y1));
  q("y1", P(fr, a0, w0, y1), P(fr, a1, w0, y1), P(fr, a1, w1, y1), P(fr, a0, w1, y1), [0, 1, 0], uvs(a0, a1, w0, w1));
  q("y0", P(fr, a0, w0, y0), P(fr, a1, w0, y0), P(fr, a1, w1, y0), P(fr, a0, w1, y0), [0, -1, 0], uvs(a0, a1, w0, w1));
}

// An upright prism on a convex outline of [a, w] points.
function prism(g, fr, poly, y0, y1, { top = true } = {}) {
  const n = poly.length;
  const ca = poly.reduce((s, p) => s + p[0], 0) / n;
  const cw = poly.reduce((s, p) => s + p[1], 0) / n;
  let run = 0;
  for (let i = 0; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    let na = q[1] - p[1];
    let nw = p[0] - q[0];
    if (na * ((p[0] + q[0]) / 2 - ca) + nw * ((p[1] + q[1]) / 2 - cw) < 0) {
      na = -na;
      nw = -nw;
    }
    const s0 = run / TILE;
    const s1 = (run + len) / TILE;
    g.addQuad(P(fr, p[0], p[1], y0), P(fr, q[0], q[1], y0), P(fr, q[0], q[1], y1), P(fr, p[0], p[1], y1), normalize(dirOf(fr, na, nw, 0)), [s0, y0 / TILE], [s1, y0 / TILE], [s1, y1 / TILE], [s0, y1 / TILE]);
    run += len;
  }
  if (!top) return;
  const ids = poly.map(([a, w]) => g.addVertex(P(fr, a, w, y1), [0, 1, 0], [a / TILE, w / TILE]));
  for (let i = 1; i + 1 < n; i++) g.addTriangle(ids[0], ids[i], ids[i + 1], [0, 1, 0]);
}

// A pointed roof from a convex outline at y0 up to a point at `apex` ([a, w, y]).
function roof(g, fr, poly, y0, apex) {
  const top = P(fr, ...apex);
  for (let i = 0; i < poly.length; i++) {
    const A = P(fr, poly[i][0], poly[i][1], y0);
    const B = P(fr, poly[(i + 1) % poly.length][0], poly[(i + 1) % poly.length][1], y0);
    let n = normalize(cross(sub(B, A), sub(top, A)));
    if (n[1] < 0) n = n.map((v) => -v);
    const len = Math.hypot(B[0] - A[0], B[2] - A[2]) / TILE;
    const ia = g.addVertex(A, n, [0, 0]);
    const ib = g.addVertex(B, n, [len, 0]);
    const it = g.addVertex(top, n, [len / 2, (apex[2] - y0) / TILE]);
    g.addTriangle(ia, ib, it, n);
  }
}

const ring = (ca, cw, r, sides, turn = Math.PI / sides) => Array.from({ length: sides }, (_, i) => [ca + Math.cos(turn + (i * 2 * Math.PI) / sides) * r, cw + Math.sin(turn + (i * 2 * Math.PI) / sides) * r]);

// A square-section bar between two points. `across` is used when the bar is upright.
function bar(g, p0, p1, sw, sh, across = [1, 0, 0]) {
  const d = normalize(sub(p1, p0));
  let s = cross(d, [0, 1, 0]);
  s = Math.hypot(...s) < 1e-3 ? across : normalize(s);
  const up = normalize(cross(s, d));
  const c = (p, i, j) => [p[0] + s[0] * i * sw * 0.5 + up[0] * j * sh * 0.5, p[1] + s[1] * i * sw * 0.5 + up[1] * j * sh * 0.5, p[2] + s[2] * i * sw * 0.5 + up[2] * j * sh * 0.5];
  const len = Math.hypot(...sub(p1, p0));
  const uv = [[0, 0], [len, 0], [len, 1], [0, 1]];
  for (const [i0, j0, i1, j1, n] of [[1, -1, 1, 1, s], [-1, -1, -1, 1, s.map((v) => -v)], [-1, 1, 1, 1, up], [-1, -1, 1, -1, up.map((v) => -v)]]) {
    g.addQuad(c(p0, i0, j0), c(p1, i0, j0), c(p1, i1, j1), c(p0, i1, j1), n, ...uv);
  }
}

// A dark window with a pointed top, just proud of a face of a box: the face
// a = `value` (axis "a") or w = `value` (axis "w"), facing `sign`.
function gothicWindow(g, fr, axis, value, sign, c, y0, wide, high) {
  const at = value + sign * 0.05;
  const p = (s, y) => (axis === "a" ? P(fr, at, s, y) : P(fr, s, at, y));
  const n = axis === "a" ? dirOf(fr, sign, 0, 0) : dirOf(fr, 0, sign, 0);
  const ids = [p(c - wide / 2, y0), p(c + wide / 2, y0), p(c + wide / 2, y0 + high), p(c - wide / 2, y0 + high), p(c, y0 + high + wide * 0.6)].map((q, i) => g.addVertex(q, n, [i % 2, i > 1 ? 1 : 0]));
  g.addTriangle(ids[0], ids[1], ids[2], n);
  g.addTriangle(ids[0], ids[2], ids[3], n);
  g.addTriangle(ids[3], ids[2], ids[4], n);
}

// The gateway's outline across the road, [w, y] from one side to the other:
// two arcs leaning together to a point.
function gateCurve(steps = 10) {
  const c = GATE.r - GATE.half; // each arc's centre, on the far side of the middle
  const peak = Math.acos(c / GATE.r);
  const left = [];
  for (let i = 0; i <= steps; i++) {
    const t = (peak * i) / steps;
    left.push([c - GATE.r * Math.cos(t), GATE.spring + GATE.r * Math.sin(t)]);
  }
  return [...left, ...left.slice(0, -1).reverse().map(([w, y]) => [-w, y])];
}

// --- The bridge ------------------------------------------------------------------------
// Returns one entry per stretch: { meshes, box: [x0, z0, x1, z1] }, the meshes
// that cast shadows and the ground they cover. (It keeps the meshes itself.)
export function buildTowerBridge(scene, world, road, F, keep, colliders, { concrete }) {
  const { i0, i1, pairs } = road.towerSpan;
  const at = (k, w, y) => P(frameAt(F, k), 0, w, y);
  const uOf = (k) => (k - i0) * ROAD_SAMPLE_STEP;

  // Where everything stands (road samples): the pairs spread out so that every
  // chain span, the two down to the end towers included, is the same length.
  const mid = Math.round((i0 + i1) / 2);
  const pitch = (i1 - i0 - 2 * END_LEN + 2 * (PAIR_HALF + TOWER_HALF)) / (pairs + 1);
  const mids = Array.from({ length: pairs }, (_, j) => {
    const off = (j - (pairs - 1) / 2) * pitch;
    return mid + Math.sign(off) * Math.round(Math.abs(off));
  });
  const towerKs = mids.flatMap((m) => [m - PAIR_HALF, m + PAIR_HALF]);
  const endKs = [i0 + END_LEN / 2, i1 - END_LEN / 2];

  // Pale stone (the sandstone picture, greyed a little), and grey granite below.
  const stone = surfaceMaterial(scene, "towerBridgeStone", "sandstone", { tint: rgb(0.88, 0.86, 0.8) });
  const granite = surfaceMaterial(scene, "towerBridgeGranite", "sandstone", { tint: rgb(0.62, 0.62, 0.63) });
  const slate = plainMaterial(scene, "towerBridgeSlate", rgb(0.17, 0.19, 0.23), { roughness: 0.55 });
  const blue = plainMaterial(scene, "towerBridgeBlue", rgb(0.43, 0.63, 0.8), { metallic: 0.3, roughness: 0.45 });
  const white = plainMaterial(scene, "towerBridgeWhite", rgb(0.86, 0.87, 0.86), { metallic: 0.2, roughness: 0.5 });
  const glassMat = plainMaterial(scene, "towerBridgeWindows", rgb(0.07, 0.09, 0.11), { metallic: 0.6, roughness: 0.25 });
  const goldMat = plainMaterial(scene, "towerBridgeGold", rgb(0.85, 0.65, 0.25), { metallic: 1, roughness: 0.3 });
  const jointMat = plainMaterial(scene, "towerBridgeJoint", rgb(0.13, 0.13, 0.14), { metallic: 0.5, roughness: 0.7 });
  // The stone, the ironwork and the deck cast shadows: one set of builders per
  // stretch. The rest (roofs, railing posts, the piers under the deck, windows)
  // cast none worth drawing, so one builder each serves the whole bridge.
  const casting = [["stone", stone], ["blue", blue], ["foot", concrete]];
  const shared = { granite: new GeometryBuilder(), slate: new GeometryBuilder(), white: new GeometryBuilder() };
  const stretches = mids.map(() => ({ ...shared, ...Object.fromEntries(casting.map(([name]) => [name, new GeometryBuilder()])) }));
  const glass = new GeometryBuilder();
  const gold = new GeometryBuilder();
  const joint = new GeometryBuilder();
  // Each stretch runs halfway to the next pair's middle.
  const G = (k) => stretches[mids.reduce((best, m, j) => (Math.abs(k - m) < Math.abs(k - mids[best]) ? j : best), 0)];
  const seaBed = (fr) => Math.max(world.baseHeight(fr.o[0], fr.o[2]), SEA_FLOOR) - 2 - fr.o[1];
  // Sample indices from a to b, d apart, always ending on b.
  const steps = (a, b, d) => {
    const out = [];
    for (let k = a; k < b; k += d) out.push(k);
    out.push(b);
    return out;
  };

  // --- Deck: footways, edge girders and the slab under the road ------------------------
  const deckKs = steps(i0, i1, DECK_STEP);
  for (let p = 0; p + 1 < deckKs.length; p++) {
    const [k0, k1] = [deckKs[p], deckKs[p + 1]];
    const g = G(k0);
    const f0 = frameAt(F, k0);
    const f1 = frameAt(F, k1);
    const v0 = uOf(k0) / TILE;
    const v1 = uOf(k1) / TILE;
    for (const side of [-1, 1]) {
      const q = (b, w0, y0, w1, y1, n) => b.addQuad(P(f0, 0, side * w0, y0), P(f1, 0, side * w0, y0), P(f1, 0, side * w1, y1), P(f0, 0, side * w1, y1), n, [v0, w0 / TILE], [v1, w0 / TILE], [v1, w1 / TILE], [v0, w1 / TILE]);
      const outward = dirOf(f0, 0, side, 0);
      const inward = dirOf(f0, 0, -side, 0);
      q(g.foot, ROAD_HALF_WIDTH, -0.01, KERB, -0.01, [0, 1, 0]); // gutter beside the road
      q(g.foot, KERB, -0.05, KERB, 0.2, inward); // kerb
      q(g.foot, KERB, 0.2, RAIL, 0.2, [0, 1, 0]); // footway
      q(g.blue, RAIL, 0.2, RAIL, 0.7, inward); // edge girder
      q(g.blue, RAIL, 0.7, GIRDER, 0.7, [0, 1, 0]);
      q(g.blue, GIRDER, -1.8, GIRDER, 0.7, outward);
      q(g.blue, RAIL, -1.8, GIRDER, -1.8, [0, -1, 0]);
      q(g.blue, RAIL, -1.6, RAIL, -1.8, inward);
      // Can't drive onto the footway or through the towers (the same line as
      // the plain bridge's walls either side).
      const a = at(k0, side * KERB, 0);
      const b = at(k1, side * KERB, 0);
      colliders.addSegment(a[0], a[2], b[0], b[2]);
    }
    g.foot.addQuad(P(f0, 0, -RAIL, -1.6), P(f1, 0, -RAIL, -1.6), P(f1, 0, RAIL, -1.6), P(f0, 0, RAIL, -1.6), [0, -1, 0], [v0, 0], [v1, 0], [v1, 3.6], [v0, 3.6]);
  }
  // Close off the ends of the footways and slab where the plain bridge carries on ashore.
  for (const [k, s] of [[i0, -1], [i1, 1]]) {
    const fr = frameAt(F, k);
    const g = G(k);
    for (const side of [-1, 1]) g.foot.addQuad(P(fr, 0, side * KERB, -1.6), P(fr, 0, side * RAIL, -1.6), P(fr, 0, side * RAIL, 0.2), P(fr, 0, side * KERB, 0.2), dirOf(fr, s, 0, 0), [0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]);
    g.foot.addQuad(P(fr, 0, -KERB, -1.6), P(fr, 0, KERB, -1.6), P(fr, 0, KERB, -0.05), P(fr, 0, -KERB, -0.05), dirOf(fr, s, 0, 0), [0, 0], [2.5, 0], [2.5, 0.4], [0, 0.4]);
  }
  // Dark steel joints across the road where the two lifting halves of each
  // pair's middle span meet each other and the towers.
  for (const m of mids) {
    for (const k of [m - PAIR_HALF + TOWER_HALF, m, m + PAIR_HALF - TOWER_HALF]) {
      const fr = frameAt(F, k);
      joint.addQuad(P(fr, -0.15, -ROAD_HALF_WIDTH, 0.02), P(fr, 0.15, -ROAD_HALF_WIDTH, 0.02), P(fr, 0.15, ROAD_HALF_WIDTH, 0.02), P(fr, -0.15, ROAD_HALF_WIDTH, 0.02), [0, 1, 0], [0, 0], [1, 0], [1, 1], [0, 1]);
    }
  }

  // --- Railings: white posts, blue rails, wherever there's no stonework beside the footway ---
  const open = (k) => k >= i0 + END_LEN && k <= i1 - END_LEN && towerKs.every((t) => Math.abs(k - t) >= TOWER_HALF);
  const openRuns = [];
  for (let k = i0; k <= i1; k++) {
    if (!open(k)) continue;
    if (openRuns.length && openRuns[openRuns.length - 1][1] === k - 1) openRuns[openRuns.length - 1][1] = k;
    else openRuns.push([k, k]);
  }
  for (const side of [-1, 1]) {
    const w = side * (RAIL - 0.08);
    for (const [a, b] of openRuns) {
      for (const k of steps(a, b, POST_STEP)) bar(G(k).white, at(k, w, 0.2), at(k, w, 1.3), 0.12, 0.12, frameAt(F, k).r);
      const ks = steps(a, b, DECK_STEP);
      for (let p = 0; p + 1 < ks.length; p++) for (const y of [0.7, 1.22]) bar(G(ks[p]).blue, at(ks[p], w, y), at(ks[p + 1], w, y), 0.08, y > 1 ? 0.14 : 0.08);
    }
  }

  // --- The towers -----------------------------------------------------------------------
  const { half: A, leg: L, body: Y } = TOWER;
  const curve = gateCurve();
  for (const k of towerKs) {
    const fr = frameAt(F, k);
    const g = G(k);
    // Granite pier down to the sea bed, pointed up and down the river.
    prism(g.granite, fr, [[-A - 2, -16], [0, -21], [A + 2, -16], [A + 2, 16], [0, 21], [-A - 2, 16]], seaBed(fr), -1.6);
    // Two legs either side of the road, and the stonework over the gateway.
    for (const s of [-1, 1]) {
      box(g.stone, fr, -A, A, s > 0 ? GATE.half : -L, s > 0 ? L : -GATE.half, -1.6, Y, "y1");
      colliders.addBox(...xz(P(fr, 0, s * (GATE.half + L) / 2, 0)), (L - GATE.half) / 2, A, Math.atan2(fr.f[0], fr.f[2]));
    }
    box(g.stone, fr, -A, A, -GATE.half, GATE.half, GATE.top, Y, "w0 w1 y0 y1");
    // The pointed gateway: its faces either end, and its curved ceiling.
    for (let j = 0; j + 1 < curve.length; j++) {
      const [wa, ya] = curve[j];
      const [wb, yb] = curve[j + 1];
      for (const s of [-1, 1]) g.stone.addQuad(P(fr, s * A, wa, ya), P(fr, s * A, wb, yb), P(fr, s * A, wb, GATE.top), P(fr, s * A, wa, GATE.top), dirOf(fr, s, 0, 0), [wa / TILE, ya / TILE], [wb / TILE, yb / TILE], [wb / TILE, GATE.top / TILE], [wa / TILE, GATE.top / TILE]);
      const cw = (wa + wb) / 2 < 0 ? GATE.r - GATE.half : GATE.half - GATE.r;
      const n = normalize(dirOf(fr, 0, cw - (wa + wb) / 2, GATE.spring - (ya + yb) / 2));
      g.stone.addQuad(P(fr, -A, wa, ya), P(fr, A, wa, ya), P(fr, A, wb, yb), P(fr, -A, wb, yb), n, [-A / TILE, j / 3], [A / TILE, j / 3], [A / TILE, (j + 1) / 3], [-A / TILE, (j + 1) / 3]);
    }
    // Bands of stone round the tower, and the cornice at the top.
    for (const y of [GATE.top, 33]) box(g.stone, fr, -A - 0.25, A + 0.25, -L - 0.25, L + 0.25, y, y + 0.6);
    box(g.stone, fr, -A - 0.4, A + 0.4, -L - 0.4, L + 0.4, Y - 1, Y + 0.6);
    // A turret at each corner, and the tall roof in the middle.
    for (const sa of [-1, 1]) {
      for (const sw of [-1, 1]) {
        const ca = sa * A;
        const cw = sw * (L + 0.2);
        prism(g.stone, fr, ring(ca, cw, TOWER.turret, 8), -1.6, Y + 3, { top: false });
        roof(g.slate, fr, ring(ca, cw, TOWER.turret + 0.2, 8), Y + 3, [ca, cw, Y + 10.5]);
        bar(gold, P(fr, ca, cw, Y + 10.3), P(fr, ca, cw, Y + 12), 0.14, 0.14, fr.r);
      }
    }
    roof(g.slate, fr, [[-A + 1, -L + 2.5], [A - 1, -L + 2.5], [A - 1, L - 2.5], [-A + 1, L - 2.5]], Y + 0.6, [0, 0, Y + 16]);
    bar(gold, P(fr, 0, 0, Y + 15.5), P(fr, 0, 0, Y + 19), 0.22, 0.22, fr.r);
    // Windows on every face.
    for (const s of [-1, 1]) {
      for (const y of [19, 25]) for (const c of [-3.2, 0, 3.2, -9.5, 9.5]) gothicWindow(glass, fr, "a", s * A, s, c, y, 1.3, 3.2);
      gothicWindow(glass, fr, "a", s * A, s, -9.5, 2.5, 1.3, 2.8);
      gothicWindow(glass, fr, "a", s * A, s, 9.5, 2.5, 1.3, 2.8);
      for (const y of [3, 19, 25, 36]) for (const c of [-5, 0, 5]) gothicWindow(glass, fr, "w", s * L, s, c, y, 1.3, 3.2);
    }
  }

  // --- The high walkways between each pair's towers: lattice girders with a floor and roof ---
  const { w0: W0, w1: W1, y0: Y0, y1: Y1 } = WALKWAY;
  for (const m of mids) {
    const ta = frameAt(F, m - PAIR_HALF);
    const tb = frameAt(F, m + PAIR_HALF);
    const g = G(m);
    for (const s of [-1, 1]) {
      const end = (fr, a, w, y) => P(fr, a, s * w, y);
      for (const w of [W0, W1]) {
        for (const y of [Y0 + 0.3, Y1 - 0.3]) bar(g.blue, end(ta, A, w, y), end(tb, -A, w, y), 0.4, 0.6);
        const panels = 16;
        for (let p = 0; p <= panels; p++) {
          const t = p / panels;
          const lo = (y) => lerp3(end(ta, A, w, y), end(tb, -A, w, y), t);
          bar(g.blue, lo(Y0 + 0.3), lo(Y1 - 0.3), 0.3, 0.3, ta.f);
          if (p < panels) {
            const t2 = (p + 1) / panels;
            const hi = (y) => lerp3(end(ta, A, w, y), end(tb, -A, w, y), t2);
            bar(g.blue, p % 2 ? lo(Y1 - 0.3) : lo(Y0 + 0.3), p % 2 ? hi(Y0 + 0.3) : hi(Y1 - 0.3), 0.25, 0.25);
          }
        }
      }
      // Floor and roof.
      for (const [y0, y1, b] of [[Y0 - 0.2, Y0 + 0.2, g.white], [Y1 - 0.1, Y1 + 0.3, g.blue]]) {
        const lo = [end(ta, A, W0, y0), end(tb, -A, W0, y0), end(tb, -A, W1, y0), end(ta, A, W1, y0)];
        const hi = [end(ta, A, W0, y1), end(tb, -A, W0, y1), end(tb, -A, W1, y1), end(ta, A, W1, y1)];
        b.addQuad(...hi, [0, 1, 0], [0, 0], [16, 0], [16, 1], [0, 1]);
        b.addQuad(...lo, [0, -1, 0], [0, 0], [16, 0], [16, 1], [0, 1]);
        for (const [i, j] of [[0, 1], [2, 3]]) {
          const n = normalize(cross(sub(lo[j], lo[i]), [0, 1, 0])).map((v) => v * s);
          b.addQuad(lo[i], lo[j], hi[j], hi[i], n, [0, 0], [16, 0], [16, 1], [0, 1]);
        }
      }
    }
  }

  // --- End towers at each shore, where the chains come down -------------------------
  for (const k of endKs) {
    const fr = frameAt(F, k);
    const g = G(k);
    box(g.granite, fr, -6, 6, -13, 13, seaBed(fr), -1.6, "y0");
    for (const s of [-1, 1]) {
      const w0 = s > 0 ? RAIL : -13;
      const w1 = s > 0 ? 13 : -RAIL;
      box(g.stone, fr, -6, 6, w0, w1, -1.8, 15, "y0 y1");
      box(g.stone, fr, -6.3, 6.3, w0 - 0.3, w1 + 0.3, 14.4, 15.6);
      roof(g.slate, fr, [[-5.6, w0 + 0.4], [5.6, w0 + 0.4], [5.6, w1 - 0.4], [-5.6, w1 - 0.4]], 15.6, [0, (w0 + w1) / 2, 21]);
      for (const sa of [-1, 1]) {
        const ca = sa * 6;
        const cw = s * 13;
        prism(g.stone, fr, ring(ca, cw, 1.3, 8), -1.8, 17, { top: false });
        roof(g.slate, fr, ring(ca, cw, 1.45, 8), 17, [ca, cw, 21.5]);
        gothicWindow(glass, fr, "a", sa * 6, sa, s * 10.2, 6, 1.1, 2.6);
      }
      for (const c of [-2.5, 2.5]) gothicWindow(glass, fr, "w", s * RAIL, -s, c, 7, 1.1, 2.6);
      colliders.addBox(...xz(P(fr, 0, (w0 + w1) / 2, 0)), (w1 - w0) / 2, 6, Math.atan2(fr.f[0], fr.f[2]));
    }
  }

  // --- Chains: one unbroken line from shore to shore. They climb from each end
  // tower to the first tower's top, run on over the walkways, and between two
  // pairs sag low over the road and climb again. Hangers drop to the deck. ---
  const spans = [[i0 + END_LEN, towerKs[0] - TOWER_HALF, CHAIN_END, CHAIN_TOP]];
  for (let j = 1; j + 1 < towerKs.length; j += 2) spans.push([towerKs[j] + TOWER_HALF, towerKs[j + 1] - TOWER_HALF, CHAIN_TOP, CHAIN_TOP]);
  spans.push([towerKs[towerKs.length - 1] + TOWER_HALF, i1 - END_LEN, CHAIN_TOP, CHAIN_END]);
  for (const [ka, kb, ya, yb] of spans) {
    // A straight line between the two ends, sagging most in the middle (and
    // hanging lowest towards the shore on the spans down to the end towers).
    const sag = ya === yb ? ya - CHAIN_LOW : 12;
    const chainY = (k) => {
      const v = (k - ka) / (kb - ka);
      return ya + (yb - ya) * v - sag * 4 * v * (1 - v);
    };
    const ks = steps(ka, kb, CHAIN_STEP);
    for (const side of [-1, 1]) {
      const w = side * CHAIN;
      for (let p = 0; p + 1 < ks.length; p++) {
        const [k, k2] = [ks[p], ks[p + 1]];
        const b = G(k).blue;
        const y0 = chainY(k);
        const y1 = chainY(k2);
        bar(b, at(k, w, y0), at(k2, w, y1), 0.5, 0.45);
        bar(b, at(k, w, y0 - 1.5), at(k2, w, y1 - 1.5), 0.5, 0.45);
        // Lattice between the two edges of the chain.
        bar(b, at(k, w, y0), at(k, w, y0 - 1.5), 0.3, 0.3, frameAt(F, k).f);
        bar(b, at(k, w, p % 2 ? y0 : y0 - 1.5), at(k2, w, p % 2 ? y1 - 1.5 : y1), 0.22, 0.22);
        if (p % 2 === 0 && p && y0 - 1.5 > 2.5) bar(b, at(k, w, 0.7), at(k, w, y0 - 1.5), 0.12, 0.12, frameAt(F, k).f);
      }
    }
  }

  // --- Meshes: per stretch for what casts shadows, once for the rest ---------------------
  const out = stretches.map((g, j) => {
    const meshes = [];
    for (const [name, mat] of casting) if (g[name].vertexCount) meshes.push(keep(g[name].toMesh(`towerBridge${j}_${mat.name}`, scene), mat));
    // The ground the stretch covers (with room for its chains and towers).
    const ka = j ? Math.round((mids[j - 1] + mids[j]) / 2) : i0;
    const kb = j + 1 < mids.length ? Math.round((mids[j] + mids[j + 1]) / 2) : i1;
    const xs = [];
    const zs = [];
    for (let k = ka; k <= kb; k++) {
      xs.push(F[k].c[0]);
      zs.push(F[k].c[2]);
    }
    return { meshes, box: [Math.min(...xs) - 25, Math.min(...zs) - 25, Math.max(...xs) + 25, Math.max(...zs) + 25] };
  });
  for (const [g, mat] of [[shared.granite, granite], [shared.slate, slate], [shared.white, white], [glass, glassMat], [gold, goldMat], [joint, jointMat]]) if (g.vertexCount) keep(g.toMesh(`towerBridge_${mat.name}`, scene), mat);
  return out;
}

const xz = (p) => [p[0], p[2]];
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
