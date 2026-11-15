import { BAY, FLOOR, ATLAS_BAYS, DETAIL } from "./facades.js";

// The shapes of the town buildings. Each one stays inside its lot (the
// footprint and collision box town.js gave it); only what is drawn changes.
//
// Lots are axis-aligned: x runs along the street, the street side is zN and
// the back zF, and s (+1 or -1) points from the street to the back.
// Walls are drawn a storey at a time from the facade atlases (facades.js);
// roofs, chimneys, ledges and roof plant are extra quads and boxes merged
// into the per-material builders.

const EPS = 0.8 / 512; // keeps texture lookups just inside an atlas row
const TILE = 2; // metres per repeat of roof tiles and plain wall

// ---- Low-level pieces ------------------------------------------------------------------

const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

// A face from four corners (in order round the edge) with texture in metres:
// u along the bottom edge, v up the face.
function face(g, p0, p1, p2, p3, n, tile = TILE) {
  const w = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
  const h = Math.hypot(p3[0] - p0[0], p3[1] - p0[1], p3[2] - p0[2]);
  const u0 = (p0[0] + p0[2]) / tile;
  const v0 = p0[1] / tile;
  g.addQuad(p0, p1, p2, p3, n, [u0, v0], [u0 + w / tile, v0], [u0 + w / tile, v0 + h / tile], [u0, v0 + h / tile]);
}

function tri(g, a, b, c, n, tile = TILE) {
  const i = g.addVertex(a, n, [(a[0] + a[2]) / tile, a[1] / tile]);
  const j = g.addVertex(b, n, [(b[0] + b[2]) / tile, b[1] / tile]);
  const k = g.addVertex(c, n, [(c[0] + c[2]) / tile, c[1] / tile]);
  g.addTriangle(i, j, k, n);
}

// A box; the bottom is left off (it always stands on something).
export function box(g, x0, x1, y0, y1, z0, z1, { top = true, bottom = false, tile = TILE } = {}) {
  face(g, [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [0, 0, -1], tile);
  face(g, [x1, y0, z1], [x0, y0, z1], [x0, y1, z1], [x1, y1, z1], [0, 0, 1], tile);
  face(g, [x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [-1, 0, 0], tile);
  face(g, [x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [1, 0, 0], tile);
  if (top) g.addQuad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], [0, 1, 0], [x0 / tile, z0 / tile], [x1 / tile, z0 / tile], [x1 / tile, z1 / tile], [x0 / tile, z1 / tile]);
  if (bottom) g.addQuad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], [0, 0], [1, 0], [1, 1], [0, 1]);
}

// Box from a centre and half sizes.
const boxAt = (g, x, z, hx, hz, y0, y1, opt) => box(g, x - hx, x + hx, y0, y1, z - hz, z + hz, opt);

export function flat(g, x0, x1, z0, z1, y, tile = TILE) {
  const [a, b] = [Math.min(x0, x1), Math.max(x0, x1)];
  const [c, d] = [Math.min(z0, z1), Math.max(z0, z1)];
  g.addQuad([a, y, c], [b, y, c], [b, y, d], [a, y, d], [0, 1, 0], [a / tile, c / tile], [b / tile, c / tile], [b / tile, d / tile], [a / tile, d / tile]);
}

// Upright cylinder (smooth sides, flat top).
export function cylinder(g, cx, cz, r, y0, y1, seg, top = true) {
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1) / seg) * Math.PI * 2;
    const n0 = [Math.sin(a0), 0, Math.cos(a0)];
    const n1 = [Math.sin(a1), 0, Math.cos(a1)];
    const p = (n, y) => [cx + n[0] * r, y, cz + n[2] * r];
    const nm = norm([n0[0] + n1[0], 0, n0[2] + n1[2]]);
    g.addQuad(p(n0, y0), p(n1, y0), p(n1, y1), p(n0, y1), nm, [i / seg, 0], [(i + 1) / seg, 0], [(i + 1) / seg, 1], [i / seg, 1], [n0, n1, n1, n0]);
  }
  if (top) {
    const c = g.addVertex([cx, y1, cz], [0, 1, 0], [0.5, 0.5]);
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      const j = g.addVertex([cx + Math.sin(a0) * r, y1, cz + Math.cos(a0) * r], [0, 1, 0], [0.5 + Math.sin(a0) / 2, 0.5 + Math.cos(a0) / 2]);
      const k = g.addVertex([cx + Math.sin(a1) * r, y1, cz + Math.cos(a1) * r], [0, 1, 0], [0.5 + Math.sin(a1) / 2, 0.5 + Math.cos(a1) / 2]);
      g.addTriangle(c, j, k, [0, 1, 0]);
    }
  }
}

// A cone (a water tank's roof).
function cone(g, cx, cz, r, y0, h, seg) {
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2;
    const a1 = ((i + 1) / seg) * Math.PI * 2;
    const am = (a0 + a1) / 2;
    const n = norm([Math.sin(am) * h, r, Math.cos(am) * h]);
    const t = g.addVertex([cx, y0 + h, cz], n, [0.5, 1]);
    const j = g.addVertex([cx + Math.sin(a0) * r, y0, cz + Math.cos(a0) * r], n, [0, 0]);
    const k = g.addVertex([cx + Math.sin(a1) * r, y0, cz + Math.cos(a1) * r], n, [1, 0]);
    g.addTriangle(t, j, k, n);
  }
}

// A low dome (smooth), sitting on y.
function dome(g, cx, cz, r, y, seg = 8, rings = 3) {
  const pt = (i, j) => {
    const a = (i / seg) * Math.PI * 2;
    const t = (j / rings) * (Math.PI / 2);
    const n = [Math.sin(a) * Math.cos(t), Math.sin(t), Math.cos(a) * Math.cos(t)];
    return { p: [cx + n[0] * r, y + n[1] * r * 0.95, cz + n[2] * r], n, uv: [i / seg, j / rings] };
  };
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < seg; i++) {
      const a = pt(i, j);
      const b = pt(i + 1, j);
      const c = pt(i + 1, j + 1);
      const d = pt(i, j + 1);
      const n = norm([a.n[0] + b.n[0] + c.n[0] + d.n[0], a.n[1] + b.n[1] + c.n[1] + d.n[1], a.n[2] + b.n[2] + c.n[2] + d.n[2]]);
      if (j === rings - 1) {
        const ia = g.addVertex(a.p, a.n, a.uv);
        const ib = g.addVertex(b.p, b.n, b.uv);
        const ic = g.addVertex(c.p, c.n, c.uv);
        g.addTriangle(ia, ib, ic, n);
      } else g.addQuad(a.p, b.p, c.p, d.p, n, a.uv, b.uv, c.uv, d.uv, [a.n, b.n, c.n, d.n]);
    }
  }
}

// ---- Facade walls ------------------------------------------------------------------------

// A wall face from p to q ([x, z]) facing n ([nx, 0, nz]), laid out in whole
// bays (stretched a little to fit). Its ends are put in the order that makes
// the picture read left to right from outside (shop names aren't mirrored).
export function makeWall(p, q, n) {
  if ((q[0] - p[0]) * -n[2] + (q[1] - p[1]) * n[0] < 0) [p, q] = [q, p];
  const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
  const nb = Math.max(1, Math.round(len / BAY));
  return { p, q, n, len, nb, dx: (q[0] - p[0]) / len, dz: (q[1] - p[1]) / len, k: nb / (ATLAS_BAYS * len) };
}

const along = (w, s) => [w.p[0] + w.dx * s, w.p[1] + w.dz * s];
const rowV = (row, h) => row.v0 + EPS + (h * (row.v1 - row.v0 - 2 * EPS)) / row.m;

// A strip of facade: s0..s1 metres along the wall and y0..y1 up it, showing
// heights h0..h1 (metres from the row's floor) of one atlas row. u(s) = uOff + s * k.
function strip(g, w, s0, s1, y0, y1, row, h0, h1, uOff) {
  const a = along(w, s0);
  const b = along(w, s1);
  const va = rowV(row, h0);
  const vb = rowV(row, h1);
  g.addQuad([a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]], w.n, [uOff + s0 * w.k, va], [uOff + s1 * w.k, va], [uOff + s1 * w.k, vb], [uOff + s0 * w.k, vb]);
}

const randomBay = (rand) => Math.floor(rand() * ATLAS_BAYS) / ATLAS_BAYS;

// Street front: the ground floor (from 1 m under the pavement), then one strip
// per upper storey, each starting at a random bay so the lit windows at night
// don't repeat. `gOff`: texture u at the wall's left end for the ground floor.
// Returns the ground-floor units (shops, doors, lobbies) and where they are.
function streetFront(g, set, w, y, floors, rand, { gOff, fixedU = false, upperWall = w } = {}) {
  const { g: gRow, u: uRow } = set.rows;
  const gH = gRow.m;
  const go = gOff ?? Math.floor(rand() * 3) / 3;
  strip(g, w, 0, w.len, y - 1, y + gH, gRow, -1, gH, go);
  const fixed = randomBay(rand);
  for (let i = 1; i < floors; i++) {
    const y0 = y + gH + (i - 1) * FLOOR;
    strip(g, upperWall, 0, upperWall.len, y0, y0 + FLOOR, uRow, 0, FLOOR, fixedU ? fixed : randomBay(rand));
  }
  return unitsAlong(set, w, go, y, gH);
}

// The ground-floor units under a front: [{ type, text, a, b (metres along the wall), wall, y, gH }].
function unitsAlong(set, w, uOff, y, gH) {
  const out = [];
  const unitLen = 1 / 3 / w.k;
  const j0 = Math.floor(uOff * 3);
  const j1 = Math.ceil((uOff + w.len * w.k) * 3);
  for (let j = j0; j < j1; j++) {
    const start = (j / 3 - uOff) / w.k;
    const a = Math.max(0, start);
    const b = Math.min(w.len, start + unitLen);
    if (b - a < unitLen * 0.7) continue;
    const u = set.spec.units[((j % 3) + 3) % 3];
    out.push({ type: u.type, text: u.text, start, unitLen, a, b, wall: w, y, gH, style: set.spec.style });
  }
  return out;
}

// Plain side or back wall: two storeys per strip from the side row.
// `heights` is each storey's height, bottom first.
function sideWall(g, set, w, y, heights, rand) {
  const row = set.rows.s;
  const off = randomBay(rand);
  let i = 0;
  let yb = y;
  while (i < heights.length) {
    const n = Math.min(2, heights.length - i);
    let h = 0;
    for (let k = i; k < i + n; k++) h += heights[k];
    const rowH = n * FLOOR;
    const ext = i === 0 ? 1 : 0; // 1 m below ground, like the street fronts
    strip(g, w, 0, w.len, yb - ext, yb + h, row, (-ext * rowH) / h, rowH, off);
    yb += h;
    i += n;
  }
}

// The top `h` metres of the side row (plain wall above the windows), for parapets.
function parapetStrip(g, set, w, y, h) {
  strip(g, w, 0, w.len, y, y + h, set.rows.s, FLOOR * 2 - h, FLOOR * 2, 0);
}

const storeyHeights = (gH, floors) => [gH, ...Array(Math.max(0, floors - 1)).fill(FLOOR)];

// The three walls of a lot that aren't the street front.
function sidesAndBack(g, set, L, zFront, y, heights, rand, { back = true } = {}) {
  const { x0, x1, zF, s } = L;
  sideWall(g, set, makeWall([x0, zFront], [x0, zF], [-1, 0, 0]), y, heights, rand);
  sideWall(g, set, makeWall([x1, zFront], [x1, zF], [1, 0, 0]), y, heights, rand);
  if (back) sideWall(g, set, makeWall([x0, zF], [x1, zF], [0, 0, s]), y, heights, rand);
}

// ---- Roofs ---------------------------------------------------------------------------------

// A pitched roof with its ridge along the street, gable ends, and (on deep
// buildings) a flat roof behind it. Returns the ridge line.
function pitchedRoof(ctx, tiles, plain, x0, x1, zW, zF, s, yE, { pitch = 0.8, maxRun = 5.2, gables = true } = {}) {
  const run = Math.min(Math.abs(zF - zW) / 2, maxRun);
  const rise = run * pitch;
  const zR = zW + s * run;
  const zB = zW + s * 2 * run;
  const yR = yE + rise;
  const g = ctx.g(tiles);
  const oh = 0.3; // eaves overhang
  const nF = norm([0, run, -s * rise]);
  const nB = norm([0, run, s * rise]);
  face(g, [x0 - 0.15, yE - oh * pitch, zW - s * oh], [x1 + 0.15, yE - oh * pitch, zW - s * oh], [x1 + 0.15, yR, zR], [x0 - 0.15, yR, zR], nF);
  const deep = Math.abs(zF - zB) > 0.3;
  face(g, [x1 + 0.15, deep ? yE : yE - oh * pitch, deep ? zB : zB + s * oh], [x0 - 0.15, deep ? yE : yE - oh * pitch, deep ? zB : zB + s * oh], [x0 - 0.15, yR, zR], [x1 + 0.15, yR, zR], nB);
  if (gables) {
    const gp = ctx.g(plain);
    tri(gp, [x0, yE, zW], [x0, yR, zR], [x0, yE, zB], [-1, 0, 0]);
    tri(gp, [x1, yE, zW], [x1, yR, zR], [x1, yE, zB], [1, 0, 0]);
  }
  if (deep) flat(ctx.g(ctx.mats.flatRoof), x0, x1, zB, zF, yE);
  return { zR, yR, run, rise };
}

// Paris style mansard: four steep faces leaning in, a flat top.
function mansard(g, x0, x1, z0, z1, y, h, inset) {
  const [a, b] = [Math.min(x0, x1), Math.max(x0, x1)];
  const [c, d] = [Math.min(z0, z1), Math.max(z0, z1)];
  const A = a + inset;
  const B = b - inset;
  const C = c + inset;
  const D = d - inset;
  const t = y + h;
  face(g, [a, y, c], [b, y, c], [B, t, C], [A, t, C], norm([0, inset, -h]));
  face(g, [b, y, d], [a, y, d], [A, t, D], [B, t, D], norm([0, inset, h]));
  face(g, [a, y, d], [a, y, c], [A, t, C], [A, t, D], norm([-h, inset, 0]));
  face(g, [b, y, c], [b, y, d], [B, t, D], [B, t, C], norm([h, inset, 0]));
  flat(g, A, B, C, D, t);
}

// Rooftop clutter for flat roofs: air-conditioning boxes, kept off the middle
// (where a flag may stand).
function roofPlant(ctx, x0, x1, zN, zF, y, rand, count) {
  const g = ctx.g(ctx.mats.metal);
  const cx = (x0 + x1) / 2;
  const cz = (zN + zF) / 2;
  const hx = Math.abs(x1 - x0) / 2 - 1.5;
  const hz = Math.abs(zF - zN) / 2 - 1.5;
  for (let i = 0; i < count; i++) {
    const sx = rand() < 0.5 ? -1 : 1;
    const sz = rand() < 0.5 ? -1 : 1;
    const x = cx + sx * hx * (0.45 + rand() * 0.5);
    const z = cz + sz * hz * (0.45 + rand() * 0.5);
    boxAt(g, x, z, 0.9 + rand() * 0.5, 0.6 + rand() * 0.3, y, y + 0.9 + rand() * 0.6);
  }
}

// A New York water tank: a wooden barrel with a cone roof on a steel stand.
function waterTank(ctx, x, z, y, r = 1.5) {
  boxAt(ctx.g(ctx.mats.metal), x, z, r * 0.8, r * 0.8, y, y + 1.4);
  const g = ctx.g(ctx.mats.tankWood);
  cylinder(g, x, z, r, y + 1.4, y + 4.0, 8, false);
  cone(g, x, z, r * 1.08, y + 4.0, 1.1, 8);
}

// ---- Front-row buildings by style -----------------------------------------------------------

// British high-street terrace: two or three storeys, split into houses about
// two bays wide, each its own facade; a pitched roof with chimneys on the
// party walls; front doors (some with bay windows) or shops below.
function britishTerrace(ctx, L) {
  const { x0, x1, zN, zF, s, y, floors, rand } = L;
  const n = Math.max(1, Math.round((x1 - x0) / 6.6));
  const hw = (x1 - x0) / n;
  const shops = rand() < 0.55;
  const bays = !shops && rand() < 0.65;
  const zW = zN + s * (bays ? 0.6 : 0); // with bay windows the house fronts stand back
  const gH = ctx.ground.british;
  const top = y + gH + (floors - 1) * FLOOR;
  const heights = storeyHeights(gH, floors);
  const nF = [0, 0, -s];
  const picks = [];
  for (let i = 0; i < n; i++) {
    const pick = ctx.pick("british", rand, picks[i - 1]);
    picks.push(pick);
    const g = ctx.g(pick);
    const units = pick.set.spec.units;
    // A shop or a front door at this house: the matching unit of its picture.
    let j = units.findIndex((u) => u.type === (shops ? "shop" : "door"));
    if (shops && rand() < 0.5) j = units.findLastIndex((u) => u.type === "shop");
    const w = makeWall([x0 + i * hw, zW], [x0 + (i + 1) * hw, zW], nF);
    const found = streetFront(g, pick.set, w, y, floors, rand, { gOff: j / 3 });
    ctx.units(found, L);
    sideWall(g, pick.set, makeWall([x0 + i * hw, zF], [x0 + (i + 1) * hw, zF], [0, 0, s]), y, heights, rand);
    if (bays) bayWindow(ctx, pick, w, 3.5 + 1.35, zN, zW, s, y);
  }
  sideWall(ctx.g(picks[0]), picks[0].set, makeWall([x0, zW], [x0, zF], [-1, 0, 0]), y, heights, rand);
  sideWall(ctx.g(picks[n - 1]), picks[n - 1].set, makeWall([x1, zW], [x1, zF], [1, 0, 0]), y, heights, rand);
  const tiles = rand() < 0.6 ? ctx.mats.slate : ctx.mats.clay;
  const plain = ctx.plain(picks[0]);
  const roof = pitchedRoof(ctx, tiles, plain, x0, x1, zW, zF, s, top, { maxRun: 4.8 });
  // Chimney stacks on the party walls (every other one on long terraces).
  const stack = ctx.g(ctx.plain(picks[Math.floor(n / 2)]));
  for (let i = 0; i <= n; i += n > 3 ? 2 : 1) {
    const cx = Math.min(x1 - 0.4, Math.max(x0 + 0.4, x0 + i * hw));
    boxAt(stack, cx, roof.zR, 0.35, 0.55, roof.yR - 1.2, roof.yR + 1.1);
  }
  const fx = n % 2 === 0 ? x0 + (n / 2 + 0.5) * hw : (x0 + x1) / 2;
  return { x: fx, z: roof.zR, y: roof.yR };
}

// A bay window on a house front: three glazed faces standing out to the lot's
// front line, under a flat lead top. `at` is metres along the wall from its left.
function bayWindow(ctx, pick, w, at, zN, zW, s, y) {
  const g = ctx.g(pick);
  const lead = ctx.g(ctx.mats.lead);
  const row = pick.set.rows.u;
  const scale = w.len / (2 * BAY); // the house's bays are stretched to fit
  const cxs = at * scale;
  const c = along(w, cxs);
  const fw = 1.1 * scale; // half the front face
  const sw = 1.45 * scale; // half the back of the bay
  const y0 = y - 0.3;
  const y1 = y + 3.1;
  // The window picture: bay 5 of the upper row (centred on its window).
  const uc = (5 + 0.5) / ATLAS_BAYS;
  const du = fw / (ATLAS_BAYS * BAY);
  const v0 = rowV(row, 0.15);
  const v1 = rowV(row, FLOOR - 0.15);
  const dir = w.dx; // +1 or -1 along x
  const fL = [c[0] - dir * fw, zN];
  const fR = [c[0] + dir * fw, zN];
  const bL = [c[0] - dir * sw, zW];
  const bR = [c[0] + dir * sw, zW];
  const nf = [0, 0, -s];
  g.addQuad([fL[0], y0, fL[1]], [fR[0], y0, fR[1]], [fR[0], y1, fR[1]], [fL[0], y1, fL[1]], nf, [uc - du, v0], [uc + du, v0], [uc + du, v1], [uc - du, v1]);
  const du2 = 0.5 / (ATLAS_BAYS * BAY);
  const nl = norm([-dir * 0.6, 0, -s * 0.35]);
  const nr = norm([dir * 0.6, 0, -s * 0.35]);
  g.addQuad([bL[0], y0, bL[1]], [fL[0], y0, fL[1]], [fL[0], y1, fL[1]], [bL[0], y1, bL[1]], nl, [uc - du2, v0], [uc + du2, v0], [uc + du2, v1], [uc - du2, v1]);
  g.addQuad([fR[0], y0, fR[1]], [bR[0], y0, bR[1]], [bR[0], y1, bR[1]], [fR[0], y1, fR[1]], nr, [uc - du2, v0], [uc + du2, v0], [uc + du2, v1], [uc - du2, v1]);
  // Lead top.
  const yt = y1 + 0.18;
  lead.addQuad([bL[0], yt, bL[1]], [bR[0], yt, bR[1]], [fR[0], yt, fR[1]], [fL[0], yt, fL[1]], [0, 1, 0], [0, 0], [1, 0], [1, 1], [0, 1]);
  lead.addQuad([fL[0], y1, fL[1]], [fR[0], y1, fR[1]], [fR[0], yt, fR[1]], [fL[0], yt, fL[1]], nf, [0, 0], [1, 0], [1, 0.1], [0, 0.1]);
}

// British Victorian block: four to seven storeys, shops below, a pitched
// roof with one or two front gables and chimneys at the ends.
function britishBlock(ctx, L) {
  const { x0, x1, zN, zF, s, y, floors, rand } = L;
  const pick = ctx.pick("british", rand);
  const g = ctx.g(pick);
  const gH = ctx.ground.british;
  const top = y + gH + (floors - 1) * FLOOR;
  const w = makeWall([x0, zN], [x1, zN], [0, 0, -s]);
  ctx.units(streetFront(g, pick.set, w, y, floors, rand), L);
  sidesAndBack(g, pick.set, L, zN, y, storeyHeights(gH, floors), rand);
  const plain = ctx.plain(pick);
  const tiles = rand() < 0.7 ? ctx.mats.slate : ctx.mats.clay;
  const roof = pitchedRoof(ctx, tiles, plain, x0, x1, zN, zF, s, top, { maxRun: 6, pitch: 0.75 });
  // Front gables, each with its own little roof running back into the main one.
  const width = x1 - x0;
  const count = width >= 22 ? 2 : width >= 13 ? 1 : 0;
  const gw = Math.min(6.5, width / (count + 0.6));
  const gh = Math.min(roof.rise * 0.85, gw * 0.45);
  const depth = (gh / roof.rise) * roof.run + 0.4;
  const gt = ctx.g(tiles);
  const gp = ctx.g(plain);
  for (let i = 0; i < count; i++) {
    const cx = count === 1 ? (x0 + x1) / 2 : x0 + width * (i === 0 ? 0.27 : 0.73);
    const a = cx - gw / 2;
    const b = cx + gw / 2;
    tri(gp, [a, top, zN], [b, top, zN], [cx, top + gh, zN], [0, 0, -s]);
    const zf = zN - s * 0.3;
    const zb = zN + s * depth;
    const ny = gw / 2;
    face(gt, [a - 0.2, top - 0.15, zf], [a - 0.2, top - 0.15, zb], [cx, top + gh, zb], [cx, top + gh, zf], norm([-gh, ny, 0]));
    face(gt, [b + 0.2, top - 0.15, zb], [b + 0.2, top - 0.15, zf], [cx, top + gh, zf], [cx, top + gh, zb], norm([gh, ny, 0]));
  }
  const stack = ctx.g(plain);
  for (const cx of [x0 + 0.6, x1 - 0.6]) {
    boxAt(stack, cx, roof.zR, 0.45, 0.8, roof.yR - 1.5, roof.yR + 1.3);
  }
  return { x: (x0 + x1) / 2, z: roof.zR, y: roof.yR };
}

// Paris: a tall shop floor at the front line; the floors above stand 0.7 m
// back, so the balconies (second and top floors) reach the front line and no
// further; a stone cornice; a slate mansard with dormer windows and chimneys.
function parisBlock(ctx, L) {
  const { x0, x1, zN, zF, s, y, floors, rand } = L;
  const pick = ctx.pick("paris", rand);
  const set = pick.set;
  const g = ctx.g(pick);
  const stone = ctx.g(ctx.plain(pick));
  const gH = ctx.ground.paris;
  const yG = y + gH;
  const top = yG + (floors - 1) * FLOOR;
  const zU = zN + s * 0.7;
  const nF = [0, 0, -s];
  const wG = makeWall([x0, zN], [x1, zN], nF);
  const wU = makeWall([x0, zU], [x1, zU], nF);
  ctx.units(streetFront(g, set, wG, y, floors, rand, { upperWall: wU }), L);
  sidesAndBack(g, set, L, zU, y, storeyHeights(gH, floors), rand);
  // The shop floor's ends and the stone ledge over it.
  face(stone, [x0, y - 1, zN], [x0, y - 1, zU], [x0, yG + 0.3, zU], [x0, yG + 0.3, zN], [-1, 0, 0]);
  face(stone, [x1, y - 1, zU], [x1, y - 1, zN], [x1, yG + 0.3, zN], [x1, yG + 0.3, zU], [1, 0, 0]);
  face(stone, [x0, yG, zN], [x1, yG, zN], [x1, yG + 0.3, zN], [x0, yG + 0.3, zN], nF);
  flat(stone, x0, x1, zN, zU, yG + 0.3);
  // Balconies.
  const rail = ctx.g(ctx.mats.railing);
  for (const k of new Set([2, floors - 1])) {
    if (k < 2 || k >= floors) continue;
    const yb = yG + (k - 1) * FLOOR;
    const a = x0 + 0.15;
    const b = x1 - 0.15;
    face(stone, [a, yb - 0.12, zN], [b, yb - 0.12, zN], [b, yb + 0.12, zN], [a, yb + 0.12, zN], nF);
    flat(stone, a, b, zN, zU, yb + 0.12);
    stone.addQuad([a, yb - 0.12, zN], [b, yb - 0.12, zN], [b, yb - 0.12, zU], [a, yb - 0.12, zU], [0, -1, 0], [0, 0], [1, 0], [1, 1], [0, 1]);
    railingQuad(rail, [a, zN + s * 0.06], [b, zN + s * 0.06], yb + 0.12, 0.95, DETAIL.railing);
    railingQuad(rail, [a, zN], [a, zU], yb + 0.12, 0.95, DETAIL.railing);
    railingQuad(rail, [b, zN], [b, zU], yb + 0.12, 0.95, DETAIL.railing);
  }
  // Cornice along the top of the front, then the mansard.
  const zc = zU - s * 0.45;
  face(stone, [x0, top, zc], [x1, top, zc], [x1, top + 0.4, zc], [x0, top + 0.4, zc], nF);
  stone.addQuad([x0, top, zc], [x1, top, zc], [x1, top, zU], [x0, top, zU], [0, -1, 0], [0, 0], [1, 0], [1, 1], [0, 1]);
  flat(stone, x0, x1, zc, zU, top + 0.4);
  const yM = top + 0.4;
  const mH = 4.2;
  const mIn = 2.2;
  const zinc = ctx.mats.zinc;
  mansard(ctx.g(zinc), x0, x1, zU, zF, yM, mH, mIn);
  // Dormers in the front slope, over every other bay.
  const zt = ctx.g(zinc);
  const nb = wU.nb;
  const bw = wU.len / nb;
  const zd = zU + s * 0.45;
  const yd0 = yM + (0.45 / mIn) * mH;
  const yd1 = yM + 2.55;
  const zBack = zU + s * ((2.55 / mH) * mIn);
  let made = 0;
  for (let b = 1; b < nb - 0.5 && made < 2 + (nb > 6 ? 1 : 0); b += nb > 4 ? 3 : 2, made++) {
    const sMid = (b + 0.5) * bw;
    const cx = along(wU, sMid)[0];
    const hw = 0.62;
    const uc = (Math.floor(rand() * ATLAS_BAYS) + 0.5) / ATLAS_BAYS;
    const du = hw / (ATLAS_BAYS * BAY);
    const row = set.rows.u;
    const dir = wU.dx;
    g.addQuad([cx - dir * hw, yd0, zd], [cx + dir * hw, yd0, zd], [cx + dir * hw, yd1, zd], [cx - dir * hw, yd1, zd], nF, [uc - du, rowV(row, 1.0)], [uc + du, rowV(row, 1.0)], [uc + du, rowV(row, 2.75)], [uc - du, rowV(row, 2.75)]);
    for (const side of [-1, 1]) {
      const x = cx + side * hw;
      tri(zt, [x, yd0, zd], [x, yd1, zd], [x, yd1, zBack], [side, 0, 0]);
    }
    const ridge = yd1 + 0.5;
    tri(stone, [cx - hw, yd1, zd], [cx + hw, yd1, zd], [cx, ridge, zd], nF);
    face(zt, [cx - hw - 0.1, yd1 - 0.06, zd - s * 0.1], [cx - hw - 0.1, yd1 - 0.06, zBack], [cx, ridge, zBack], [cx, ridge, zd - s * 0.1], norm([-0.5, hw, 0]));
    face(zt, [cx + hw + 0.1, yd1 - 0.06, zBack], [cx + hw + 0.1, yd1 - 0.06, zd - s * 0.1], [cx, ridge, zd - s * 0.1], [cx, ridge, zBack], norm([0.5, hw, 0]));
  }
  // Chimney stacks on the party walls.
  const zMid = (zU + zF) / 2;
  const yTop = yM + mH;
  for (const cx of [x0 + mIn + 0.5, x1 - mIn - 0.5]) {
    const hz = Math.min(1.6, Math.abs(zF - zU) / 2 - mIn - 0.2);
    boxAt(stone, cx, zMid, 0.35, hz, yTop - 0.2, yTop + 1.4);
  }
  return { x: (x0 + x1) / 2, z: zMid, y: yTop };
}

// A see-through railing (alpha tested, drawn from both sides).
function railingQuad(g, a, b, y, h, band) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = norm([b[1] - a[1], 0, -(b[0] - a[0])]);
  const u1 = len / 2;
  g.addQuad([a[0], y, a[1]], [b[0], y, b[1]], [b[0], y + h, b[1]], [a[0], y + h, a[1]], n, [0, band[0] + 0.004], [u1, band[0] + 0.004], [u1, band[1] - 0.004], [0, band[1] - 0.004]);
}

// Downtown tower: a stone podium with the lobby, a glass shaft set back from
// it (stepping in again near the top of the tallest), roof plant, and a mast
// with a red light on the very tallest.
function cityTower(ctx, L) {
  const { x0, x1, zN, zF, s, y, floors, rand } = L;
  const pick = ctx.pick("city", rand, null, 0);
  const g = ctx.g(pick);
  const set = pick.set;
  const gH = ctx.ground.city;
  const P = 3;
  const yP = y + gH + (P - 1) * FLOOR;
  const w = makeWall([x0, zN], [x1, zN], [0, 0, -s]);
  // The lobby in the middle of the front.
  const gOff = 1 / 6 - (w.len / 2) * w.k;
  const units = streetFront(g, set, w, y, P, rand, { gOff });
  ctx.units(units, L);
  sidesAndBack(g, set, L, zN, y, storeyHeights(gH, P), rand);
  flat(ctx.g(ctx.mats.flatRoof), x0, x1, zN, zF, yP + 0.02);
  // Canopy over the lobby doors.
  for (const u of units) {
    if (u.type !== "lobby") continue;
    const m = along(u.wall, u.start + u.unitLen / 2);
    const hw = Math.min(u.unitLen * 0.38, 2.8);
    box(ctx.g(ctx.mats.metal), m[0] - hw, m[0] + hw, y + gH - 0.62, y + gH - 0.4, Math.min(zN, zN - s * 2.4), Math.max(zN, zN - s * 2.4), { bottom: true });
  }
  // The glass shaft.
  const glass = ctx.g(ctx.glass(rand));
  let [a, b] = [x0 + 2.5, x1 - 2.5];
  let [c, d] = [zN + s * 3, zF - s * 2.5];
  const shaft = floors - P;
  const step = floors >= 20 && Math.min(b - a, Math.abs(d - c)) > 16 ? P + Math.round(shaft * 0.68) : null;
  let yb = yP;
  const levels = step ? [step - P, floors - step] : [shaft];
  levels.forEach((n, i) => {
    const yt = yb + n * FLOOR;
    glassBox(glass, a, b, Math.min(c, d), Math.max(c, d), yb, yt, yP);
    if (i < levels.length - 1) {
      flat(ctx.g(ctx.mats.flatRoof), a, b, c, d, yt + 0.02);
      a += 2.5;
      b -= 2.5;
      c += s * 2.5;
      d -= s * 2.5;
    }
    yb = yt;
  });
  flat(ctx.g(ctx.mats.flatRoof), a, b, c, d, yb + 0.02);
  // A plant room in the middle (the flag stands on it), boxes, a mast.
  const cx = (a + b) / 2;
  const cz = (c + d) / 2;
  const phx = Math.min(5, (b - a) * 0.22);
  const phz = Math.min(4, Math.abs(d - c) * 0.22);
  const metal = ctx.g(ctx.mats.metal);
  boxAt(metal, cx, cz, phx, phz, yb, yb + 3.2);
  roofPlant(ctx, a, b, c, d, yb, rand, 2);
  if (floors >= 18) {
    const mx = cx + phx * 0.6;
    boxAt(metal, mx, cz, 0.18, 0.18, yb + 3.2, yb + 3.2 + 12);
    boxAt(ctx.g(ctx.mats.redLight), mx, cz, 0.3, 0.3, yb + 15.2, yb + 15.7, { bottom: true });
  }
  return { x: cx - phx * 0.4, z: cz, y: yb + 3.2 };
}

// A glass box drawn with the repeating curtain-wall picture (4 bays x 2 floors).
function glassBox(g, x0, x1, z0, z1, y0, y1, base) {
  const walls = [
    [[x0, z0], [x1, z0], [0, 0, -1]],
    [[x1, z0], [x1, z1], [1, 0, 0]],
    [[x1, z1], [x0, z1], [0, 0, 1]],
    [[x0, z1], [x0, z0], [-1, 0, 0]],
  ];
  for (const [p, q, n] of walls) {
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const u1 = len / (BAY * 4);
    const v0 = (y0 - base) / (FLOOR * 2);
    const v1 = (y1 - base) / (FLOOR * 2);
    g.addQuad([p[0], y0, p[1]], [q[0], y0, q[1]], [q[0], y1, q[1]], [p[0], y1, p[1]], n, [0, v0], [u1, v0], [u1, v1], [0, v1]);
  }
}

// Mid-rise office: the office picture all the way up, a flat roof with plant.
function cityOffice(ctx, L) {
  const { x0, x1, zN, zF, s, y, floors, rand } = L;
  const pick = ctx.pick("city", rand, null, 0);
  const g = ctx.g(pick);
  const gH = ctx.ground.city;
  const top = y + gH + (floors - 1) * FLOOR;
  ctx.units(streetFront(g, pick.set, makeWall([x0, zN], [x1, zN], [0, 0, -s]), y, floors, rand), L);
  sidesAndBack(g, pick.set, L, zN, y, storeyHeights(gH, floors), rand);
  const roofY = parapet(ctx, pick, L, zN, top, 0.7);
  roofPlant(ctx, x0, x1, zN, zF, roofY, rand, 1 + (rand() < 0.5 ? 1 : 0));
  return { x: (x0 + x1) / 2, z: (zN + zF) / 2, y: roofY };
}

// Brick walk-up: fire escapes on the front, a water tank on the roof.
function cityBrick(ctx, L) {
  const { x0, x1, zN, zF, s, y, floors, rand } = L;
  const pick = ctx.pick("city", rand, null, 1);
  const g = ctx.g(pick);
  const gH = ctx.ground.city;
  const top = y + gH + (floors - 1) * FLOOR;
  ctx.units(streetFront(g, pick.set, makeWall([x0, zN], [x1, zN], [0, 0, -s]), y, floors, rand, { fixedU: true }), L);
  sidesAndBack(g, pick.set, L, zN, y, storeyHeights(gH, floors), rand);
  const roofY = parapet(ctx, pick, L, zN, top, 0.7);
  const cx = (x0 + x1) / 2;
  if (rand() < 0.75) waterTank(ctx, cx + (rand() - 0.5) * (x1 - x0) * 0.4, zF - s * 4, roofY, 1.4 + rand() * 0.4);
  else roofPlant(ctx, x0, x1, zN, zF, roofY, rand, 1);
  return { x: cx, z: zN + s * 4, y: roofY };
}

// A parapet round a flat roof: the walls carry on up as plain wall. (The roof
// is laid just under its top: from the street the roof can't be seen, and
// from the hills a sunk roof would cost twice the triangles for no gain.)
function parapet(ctx, pick, L, zFront, top, h, { roofMat = ctx.mats.flatRoof } = {}) {
  const { x0, x1, zF, s } = L;
  const set = pick.set;
  const g = ctx.g(pick);
  const walls = [
    makeWall([x0, zFront], [x1, zFront], [0, 0, -s]),
    makeWall([x0, zF], [x1, zF], [0, 0, s]),
    makeWall([x0, zFront], [x0, zF], [-1, 0, 0]),
    makeWall([x1, zFront], [x1, zF], [1, 0, 0]),
  ];
  for (const w of walls) parapetStrip(g, set, w, top, h);
  flat(ctx.g(roofMat), x0, x1, zFront, zF, top + h - 0.12);
  return top + h - 0.12;
}

// Desert house or shop: thick walls, small arched windows, a flat roof behind
// a parapet; some with a wooden balcony (the floor above stands back for it),
// a small dome, water tanks.
function desertHouse(ctx, L) {
  const { x0, x1, zN, zF, s, y, floors, rand } = L;
  const pick = ctx.pick("desert", rand);
  const set = pick.set;
  const g = ctx.g(pick);
  const plainMat = ctx.plain(pick);
  const plain = ctx.g(plainMat);
  const gH = ctx.ground.desert;
  const yG = y + gH;
  const top = yG + (floors - 1) * FLOOR;
  const balcony = floors >= 2 && rand() < 0.4;
  const zU = balcony ? zN + s * 0.8 : zN;
  const nF = [0, 0, -s];
  const wG = makeWall([x0, zN], [x1, zN], nF);
  const wU = makeWall([x0, zU], [x1, zU], nF);
  ctx.units(streetFront(g, set, wG, y, floors, rand, { upperWall: wU }), L);
  sidesAndBack(g, set, L, zU, y, storeyHeights(gH, floors), rand);
  if (balcony) {
    face(plain, [x0, y - 1, zN], [x0, y - 1, zU], [x0, yG, zU], [x0, yG, zN], [-1, 0, 0]);
    face(plain, [x1, y - 1, zU], [x1, y - 1, zN], [x1, yG, zN], [x1, yG, zU], [1, 0, 0]);
    flat(plain, x0, x1, zN, zU, yG);
    // Wooden balcony along the middle, with a lattice front.
    const width = x1 - x0;
    const a = x0 + width * (0.2 + rand() * 0.1);
    const b = x1 - width * (0.2 + rand() * 0.1);
    const wood = ctx.g(ctx.mats.wood);
    box(wood, a, b, yG, yG + 0.15, Math.min(zN, zU), Math.max(zN, zU), { bottom: true });
    const lat = ctx.g(ctx.mats.railing);
    railingQuad(lat, [a, zN + s * 0.05], [b, zN + s * 0.05], yG + 0.15, 1.05, DETAIL.lattice);
    railingQuad(lat, [a, zN], [a, zU], yG + 0.15, 1.05, DETAIL.lattice);
    railingQuad(lat, [b, zN], [b, zU], yG + 0.15, 1.05, DETAIL.lattice);
    box(wood, a, b, yG + 1.2, yG + 1.28, Math.min(zN, zU), Math.max(zN, zU));
  }
  const roofY = parapet(ctx, pick, { ...L, zN: zU }, zU, top, 0.9, { roofMat: plainMat });
  // Roof things go in the back half; the flag stands in the front half.
  const cx = (x0 + x1) / 2;
  const back = (zU + zF) / 2 + (s * Math.abs(zF - zU)) / 4;
  if (floors <= 2 && rand() < 0.3) {
    const r = Math.min(x1 - x0, Math.abs(zF - zU)) * 0.2;
    const dx = (rand() - 0.5) * (x1 - x0 - 2 * r - 1);
    boxAt(plain, cx + dx, back, r * 1.02, r * 1.02, roofY, roofY + 0.7);
    dome(ctx.g(ctx.mats.dome), cx + dx, back, r, roofY + 0.7);
  } else if (rand() < 0.6) {
    const tanks = ctx.g(ctx.mats.tank);
    const tx = x1 - 1.4 - rand() * 2;
    cylinder(tanks, tx, back, 0.55, roofY, roofY + 1.2, 6);
    if (rand() < 0.5) cylinder(tanks, tx - 1.3, back, 0.55, roofY, roofY + 1.2, 6);
  }
  return { x: cx, z: (zU + zF) / 2 - (s * Math.abs(zF - zU)) / 4, y: roofY };
}

// A back door on the rear wall, standing just proud of it.
function backDoor(ctx, L) {
  const { x0, x1, zF, s, y, rand } = L;
  const x = x0 + 1.5 + rand() * Math.max(0, x1 - x0 - 3);
  const z = zF + s * 0.03;
  ctx.g(ctx.mats.backDoor).addQuad([x - 0.5, y, z], [x + 0.5, y, z], [x + 0.5, y + 2.15, z], [x - 0.5, y + 2.15, z], [0, 0, s], [0, 0], [1, 0], [1, 1], [0, 1]);
}

const FRONT = {
  british: (ctx, L) => (L.floors <= 3 ? britishTerrace(ctx, L) : britishBlock(ctx, L)),
  paris: parisBlock,
  city: (ctx, L) => (L.floors >= 12 ? cityTower(ctx, L) : L.floors <= 8 && L.rand() < 0.5 ? cityBrick(ctx, L) : cityOffice(ctx, L)),
  desert: desertHouse,
};

// Where the ground falls away under part of a lot (the end of a town, where a
// road climbs out of it), a plain stone base reaches down to it, so nothing floats.
// L.low is the lowest ground under the lot; walls already go 1 m under L.y.
function footing(ctx, L) {
  const { x0, x1, zN, zF, y, low } = L;
  if (low === undefined || low > y - 0.9) return;
  const g = ctx.g(ctx.mats.footing);
  const y0 = low - 0.3;
  const y1 = y - 1;
  const [za, zb] = [Math.min(zN, zF), Math.max(zN, zF)];
  face(g, [x0, y0, za], [x1, y0, za], [x1, y1, za], [x0, y1, za], [0, 0, -1]);
  face(g, [x1, y0, zb], [x0, y0, zb], [x0, y1, zb], [x1, y1, zb], [0, 0, 1]);
  face(g, [x0, y0, zb], [x0, y0, za], [x0, y1, za], [x0, y1, zb], [-1, 0, 0]);
  face(g, [x1, y0, za], [x1, y0, zb], [x1, y1, zb], [x1, y1, za], [1, 0, 0]);
}

// One front-row building. Returns where its true top is (for rooftop flags).
export function buildFront(ctx, L) {
  const top = FRONT[L.style](ctx, L);
  backDoor(ctx, L);
  footing(ctx, L);
  return top;
}

// ---- Second row ------------------------------------------------------------------------------

// Smaller buildings behind the main street, so towns have depth from the
// hills: houses and garages, low Paris blocks, brick warehouses, desert houses.
// Every storey is a plain 3.4 m one; the side facing the main street gets the
// upper-floor windows, the rest plain wall.
export function buildBack(ctx, L) {
  const { x0, x1, zN, zF, s, y, floors, rand, style } = L;
  const pick = ctx.pick(style, rand, null, style === "city" ? 1 : undefined);
  const set = pick.set;
  const g = ctx.g(pick);
  const top = y + floors * FLOOR;
  const heights = Array(floors).fill(FLOOR);
  footing(ctx, L);
  const w = makeWall([x0, zN], [x1, zN], [0, 0, -s]);
  for (let i = 0; i < floors; i++) strip(g, w, 0, w.len, y + i * FLOOR - (i ? 0 : 1), y + (i + 1) * FLOOR, set.rows.u, i ? 0 : -1, FLOOR, randomBay(rand));
  sidesAndBack(g, set, L, zN, y, heights, rand);
  const plain = ctx.plain(pick);
  if (style === "british") {
    if (L.garage) {
      flat(ctx.g(ctx.mats.flatRoof), x0, x1, zN, zF, top + 0.02);
      const d = ctx.g(ctx.mats.door);
      const m = (x0 + x1) / 2;
      d.addQuad([m - 1.3, y, zN - s * 0.03], [m + 1.3, y, zN - s * 0.03], [m + 1.3, y + 2.2, zN - s * 0.03], [m - 1.3, y + 2.2, zN - s * 0.03], [0, 0, -s], [0, 0], [1, 0], [1, 1], [0, 1]);
      return { x: m, z: (zN + zF) / 2, y: top };
    }
    const roof = pitchedRoof(ctx, rand() < 0.5 ? ctx.mats.slate : ctx.mats.clay, plain, x0, x1, zN, zF, s, top, { maxRun: 4.5 });
    boxAt(ctx.g(plain), x0 + 0.6, roof.zR, 0.35, 0.5, roof.yR - 1, roof.yR + 1);
    return { x: (x0 + x1) / 2, z: roof.zR, y: roof.yR };
  }
  if (style === "paris") {
    mansard(ctx.g(ctx.mats.zinc), x0, x1, zN, zF, top, 3.4, 1.8);
    return { x: (x0 + x1) / 2, z: (zN + zF) / 2, y: top + 3.4 };
  }
  if (style === "city") {
    const roofY = parapet(ctx, pick, L, zN, top, 0.7);
    if (rand() < 0.3) waterTank(ctx, (x0 + x1) / 2, (zN + zF) / 2, roofY, 1.3);
    return { x: (x0 + x1) / 2, z: (zN + zF) / 2, y: roofY };
  }
  const roofY = parapet(ctx, pick, L, zN, top, 0.8, { roofMat: plain });
  if (rand() < 0.3) cylinder(ctx.g(ctx.mats.tank), x1 - 1.2, (zN + zF) / 2, 0.5, roofY, roofY + 1.1, 6);
  return { x: (x0 + x1) / 2, z: (zN + zF) / 2, y: roofY };
}
