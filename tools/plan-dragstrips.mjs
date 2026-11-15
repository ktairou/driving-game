// Picks the sites for the drag strips by searching the land, the way
// planStations picks fuel stations. Run it once; the sites it prints are
// then frozen into DRAG_STRIPS in src/world/layout.js, so the strips never
// move between versions.
//
//   node tools/plan-dragstrips.mjs           search and print new sites
//   node tools/plan-dragstrips.mjs --check   report on the sites in layout.js
//
// A site is a dead-straight strip (staging box, quarter mile, run-off) on
// open land, with a link road from the nearest public road into its staging
// box (at the back, or square into one side). The aim is ground within ROUGH
// metres of level and CLEAR metres from towns, landmarks, fuel stations and
// other roads; Britain is too hilly and the USA too crowded for that, so the
// search scores sites by how close they come and only rules out those beyond
// MAX_ROUGH and MIN_CLEAR (and the run-off may be shorter, RUNOFFS). Two per
// country, far apart. The fuel stations must come out the same as without
// the strips: --check prints them to compare.
import { World } from "../src/world/world.js";
import { planStations } from "../src/world/stations.js";
import { inTown } from "../src/world/road.js";
import { buildCurve } from "../src/world/network.js";
import { ISLANDS, DRAG_STRIPS, DRAG_STRIP, ROAD_SAMPLE_STEP } from "../src/world/layout.js";

const CHECK = process.argv.includes("--check");
const CLEAR = 120; // from towns, landmarks, fuel stations and other roads
const ROUGH = 6; // most the land may differ from the strip's level height
const LENGTH = DRAG_STRIP.stage + DRAG_STRIP.run + DRAG_STRIP.runoff;
const APRON = DRAG_STRIP.apron;
const BEHIND = 60; // the link road comes in straight for this far behind the start
const CELL = 10;

const t0 = Date.now();
const world = new World();
const stations = planStations(world);
const log = (...a) => console.error(...a);
log(`world + stations: ${Date.now() - t0} ms`);

// Distance to the nearest thing a strip must keep clear of, on a coarse grid
// per island (exact near each thing, then the minimum over all of them).
function obstacleGrid(isl, { roads = true, withStations = true, skip = null } = {}) {
  const { minX, minZ } = isl;
  const n = Math.ceil((2 * isl.def.half) / CELL) + 1;
  const dist = new Float32Array(n * n).fill(1e6);
  const REACH = 170;
  const stamp = (x, z, reach, f) => {
    const i0 = Math.max(0, Math.floor((x - reach - minX) / CELL));
    const i1 = Math.min(n - 1, Math.ceil((x + reach - minX) / CELL));
    const j0 = Math.max(0, Math.floor((z - reach - minZ) / CELL));
    const j1 = Math.min(n - 1, Math.ceil((z + reach - minZ) / CELL));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const v = f(minX + i * CELL, minZ + j * CELL);
        if (v < dist[j * n + i]) dist[j * n + i] = v;
      }
    }
  };
  if (roads) {
    for (const r of world.network.roads) {
      if (r === skip?.strip || r === skip?.link) continue;
      for (let k = 0; k < r.count; k += 2) {
        const [px, pz] = r.points[k];
        if (!isl._nearGrid(px, pz, REACH)) continue;
        stamp(px, pz, REACH, (x, z) => Math.hypot(x - px, z - pz));
      }
    }
  }
  for (const t of isl.def.towns) {
    stamp(t.cx, t.cz, Math.max(t.hx, t.hz) + REACH, (x, z) => Math.hypot(Math.max(Math.abs(x - t.cx) - t.hx, 0), Math.max(Math.abs(z - t.cz) - t.hz, 0)));
  }
  for (const lm of isl.def.landmarks) {
    const r = (lm.base ?? 30) / 2;
    stamp(lm.x, lm.z, r + REACH, (x, z) => Math.hypot(x - lm.x, z - lm.z) - r);
    if (lm.hill) stamp(lm.x, lm.z + (lm.hill.dz ?? 0), lm.hill.r + REACH, (x, z) => Math.hypot(x - lm.x, z - lm.z - (lm.hill.dz ?? 0)) - lm.hill.r);
  }
  if (withStations) for (const s of stations) if (s.island.id === isl.def.id) stamp(s.x, s.z, REACH + 30, (x, z) => Math.hypot(x - s.x, z - s.z) - 30);
  return (x, z) => {
    const i = Math.round((x - minX) / CELL);
    const j = Math.round((z - minZ) / CELL);
    if (i < 0 || j < 0 || i >= n || j >= n) return -1;
    return dist[j * n + i];
  };
}

// Natural ground on an 8 m grid (sampling the noise directly is too slow for the search).
function baseGrid(isl) {
  const S = 8;
  const { minX, minZ } = isl;
  const n = Math.ceil((2 * isl.def.half) / S) + 1;
  const h = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) h[j * n + i] = isl.baseHeight(minX + i * S, minZ + j * S);
  return (x, z) => {
    const fx = (x - minX) / S;
    const fz = (z - minZ) / S;
    if (fx < 0 || fz < 0 || fx > n - 1.001 || fz > n - 1.001) return -99;
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const k = j * n + i;
    return (h[k] * (1 - tx) + h[k + 1] * tx) * (1 - tz) + (h[k + n] * (1 - tx) + h[k + n + 1] * tx) * tz;
  };
}

// The footprint of a strip starting at (sx, sz) heading h. Its level height
// is halfway between the lowest and highest ground under the lanes, which
// keeps the deepest cut or fill as small as it can be. Returns that height,
// the roughness (deepest cut or fill) under the lanes and across the whole
// levelled apron, and the clearance from the lanes and from the apron.
// Britain and the USA are too hilly and too crowded with roads for a
// 700 m strip to meet ROUGH and CLEAR, so those are what the search aims
// for (they score best), and MAX_ROUGH and MIN_CLEAR are the hard limits.
// Where it helps, the run-off may be shorter (RUNOFFS, longest first): even
// the fastest car stops in the shortest one with the brakes that come on by
// themselves after the finish line.
const MAX_ROUGH = 12;
const MIN_CLEAR = 30;
const MIN_APRON_CLEAR = 12;
const RUNOFFS = [DRAG_STRIP.runoff, 220, 180];
function footprint(sx, sz, h, base, clear, length = LENGTH) {
  const fx = Math.sin(h);
  const fz = Math.cos(h);
  let lo = Infinity;
  let hi = -Infinity;
  let minClear = Infinity;
  let apronClear = Infinity;
  const hs = [];
  for (let u = -10; u <= length + 10; u += 15) {
    for (const w of [-APRON, -10, 0, 10, APRON]) {
      const x = sx + fx * u + fz * w;
      const z = sz + fz * u - fx * w;
      const b = base(x, z);
      if (b < 3.5) return null; // sea or beach
      const c = clear(x, z);
      if (Math.abs(w) <= 10) {
        minClear = Math.min(minClear, c);
        lo = Math.min(lo, b);
        hi = Math.max(hi, b);
      } else apronClear = Math.min(apronClear, c);
      if (minClear < MIN_CLEAR || apronClear < MIN_APRON_CLEAR) return null;
      hs.push(b);
    }
  }
  const H = (lo + hi) / 2;
  const rough = (hi - lo) / 2;
  if (rough > MAX_ROUGH) return null;
  const apronRough = Math.max(...hs.map((b) => Math.abs(b - H)));
  return { H, rough, apronRough, minClear };
}

// Road samples a link may start from: plain public roads, away from bridges,
// junctions, towns (and their traffic lights) and fuel stations.
const joinable = [];
for (const r of world.network.roads) {
  if (r.style) continue;
  for (let k = 0; k < r.count; k++) {
    const [x, z] = r.points[k];
    if (r.bridge[k] || inTown(x, z, 40) || world.network.isNearMeeting(x, z, 70)) continue;
    if (stations.some((s) => Math.hypot(s.ox - x, s.oz - z) < 140 || Math.hypot(s.x - x, s.z - z) < 140)) continue;
    joinable.push({ r, k, x, z });
  }
}

// The link road from the nearest public road to the back of the staging box.
// It comes in either at the back of the staging box, in line with the strip
// ("back"), or square into one side of it ("left" / "right"), whichever is
// shorter.
function link(sx, sz, h, H, isl, base, roadOnly) {
  const fx = Math.sin(h);
  const fz = Math.cos(h);
  // (Where the link meets the strip is a junction too, which fuel stations keep away from.)
  if (stations.some((s) => Math.hypot(s.ox - sx, s.oz - sz) < 80 || Math.hypot(s.x - sx, s.z - sz) < 80)) return null;
  const ends = [{ entry: "back", end: [sx, sz], dx: fx, dz: fz }];
  for (const [entry, side] of [["left", -1], ["right", 1]]) {
    // right of the strip = (fz, -fx)
    const ex = sx + fx * (DRAG_STRIP.stage / 2) + fz * side * 8;
    const ez = sz + fz * (DRAG_STRIP.stage / 2) - fx * side * 8;
    ends.push({ entry, end: [ex, ez], dx: -fz * side, dz: fx * side });
  }
  let best = null;
  for (const { entry, end, dx, dz } of ends) {
    // The link comes in straight for its last stretch.
    const run = entry === "back" ? BEHIND : 25;
    const ax = end[0] - dx * run;
    const az = end[1] - dz * run;
    // Road samples behind that, roughly in line with it, nearest first.
    const opts = [];
    for (const j of joinable) {
      if (j.r.island !== isl.def.id && j.r.island) continue;
      if ((j.x - end[0]) * dx + (j.z - end[1]) * dz > -run - 10) continue;
      const d = Math.hypot(j.x - ax, j.z - az);
      if (d > 600 || (best && d + run > best.len)) continue;
      const along = ((ax - j.x) * dx + (az - j.z) * dz) / d;
      if (along < 0) continue;
      opts.push({ j, d, cost: d + (1 - along) * 150 });
    }
    opts.sort((p, q) => p.cost - q.cost);
    for (const { j } of opts.slice(0, 24)) {
      // Straight at the road, then round to line up; or out square from the
      // road first, when that makes a gentler curve.
      const [tx, tz] = j.r.tangents[j.k];
      const side = (ax - j.x) * tz - (az - j.z) * tx > 0 ? 1 : -1;
      const out = [j.x + tz * side * 35, j.z - tx * side * 35];
      let ok = null;
      for (const ctrl of [[[j.x, j.z], [ax, az], end], [[j.x, j.z], out, [ax, az], end]]) {
        ok = checkLink(ctrl, j, H, isl, base, roadOnly);
        if (ok) break;
      }
      if (ok) {
        if (!best || ok.len < best.len) best = { ...ok, entry };
        break;
      }
    }
  }
  return best;
}

function checkLink(ctrl, j, H, isl, base, roadOnly) {
  const pts = buildCurve(ctrl, ROAD_SAMPLE_STEP, false);
  const len = (pts.length - 1) * ROAD_SAMPLE_STEP;
  // No tight bends (radius at least 30 m).
  let prev = null;
  for (let k = 1; k < pts.length; k++) {
    const a = Math.atan2(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    if (prev !== null) {
      let d = Math.abs(a - prev);
      if (d > Math.PI) d = 2 * Math.PI - d;
      if (d > ROAD_SAMPLE_STEP / 30) return null;
    }
    prev = a;
  }
  // Meets the public road at a proper angle (not a shallow merge).
  const [tx, tz] = j.r.tangents[j.k];
  const lx = pts[Math.min(8, pts.length - 1)][0] - pts[0][0];
  const lz = pts[Math.min(8, pts.length - 1)][1] - pts[0][1];
  if (Math.abs(tx * lz - tz * lx) / Math.hypot(lx, lz) < 0.6) return null;
  // On land, out of town, clear of landmarks and stations, and heading away from other roads.
  for (let k = 0; k < pts.length; k++) {
    const [x, z] = pts[k];
    if (base(x, z) < 3.2 || inTown(x, z, 25)) return null;
    if (isl.def.landmarks.some((lm) => Math.hypot(x - lm.x, z - lm.z) < (lm.base ?? 30) / 2 + 40)) return null;
    if (stations.some((s) => Math.hypot(s.x - x, s.z - z) < 70)) return null;
    if (k * ROAD_SAMPLE_STEP > 36 && roadOnly(x, z) < 24) return null;
  }
  const roadH = j.r.heights[j.k];
  if (Math.abs(H - roadH) > 0.06 * len) return null;
  return { ctrl, len, grade: Math.abs(H - roadH) / len, joins: j.r.id };
}

const round = (v, k = 100) => Math.round(v * k) / k;
const DIRS = ["east", "north-east", "north", "north-west", "west", "south-west", "south", "south-east"];

if (CHECK) {
  // Report on the frozen sites, with the strips and links in the world.
  const out = [];
  for (const s of DRAG_STRIPS) {
    const isl = world.islandById(s.island);
    const strip = world.network.roads.find((r) => r.strip === s);
    const lnk = world.network.roads.find((r) => r.linkOf === s);
    const clear = obstacleGrid(isl, { skip: { strip, link: lnk } });
    const base = (x, z) => isl.baseHeight(x, z);
    const fp = { H: strip.heights[0], rough: 0, apronRough: 0, minClear: Infinity, apronClear: Infinity };
    const fx = Math.sin(s.heading);
    const fz = Math.cos(s.heading);
    for (let u = -10; u <= s.length + 10; u += 6) {
      for (let w = -APRON; w <= APRON; w += APRON / 4) {
        const x = s.x + fx * u + fz * w;
        const z = s.z + fz * u - fx * w;
        const d = Math.abs(base(x, z) - fp.H);
        fp.apronRough = Math.max(fp.apronRough, d);
        if (Math.abs(w) <= 11) {
          fp.rough = Math.max(fp.rough, d);
          fp.minClear = Math.min(fp.minClear, clear(x, z));
        } else fp.apronClear = Math.min(fp.apronClear, clear(x, z));
        if (base(x, z) < 3) fp.wet = true;
      }
    }
    // Steepest stretch of the link road.
    let steep = 0;
    for (let k = 1; k < lnk.count; k++) steep = Math.max(steep, Math.abs(lnk.heights[k] - lnk.heights[k - 1]) / ROAD_SAMPLE_STEP);
    const jn = world.network.junctions.filter((j) => j.road === lnk);
    out.push({ id: s.id, length: s.length, entry: s.entry, H: round(fp.H), rough: round(fp.rough), apronRough: round(fp.apronRough), minClear: Math.round(fp.minClear), apronClear: Math.round(fp.apronClear), wet: !!fp.wet, link: lnk.count * ROAD_SAMPLE_STEP, joins: jn.map((j) => `${j.other.id}@${j.at}`), linkSteepest: round(steep, 1000) });
  }
  console.log(JSON.stringify({ strips: out, stations: stations.map((s) => [s.name, round(s.x), round(s.z), round(s.y)]) }, null, 1));
} else {
  const chosen = [];
  for (const def of ISLANDS) {
    const isl = world.islandById(def.id);
    const base = baseGrid(isl);
    const clear = obstacleGrid(isl);
    const roadOnly = obstacleGrid(isl, { withStations: false });
    const found = [];
    const half = def.half - 60;
    const tally = { centres: 0, footprints: 0, links: 0 };
    for (let cz = def.cz - half; cz <= def.cz + half; cz += 20) {
      for (let cx = def.cx - half; cx <= def.cx + half; cx += 20) {
        if (base(cx, cz) < 3.5 || clear(cx, cz) < MIN_CLEAR) continue;
        tally.centres++;
        for (let deg = 0; deg < 360; deg += 4) {
          const h = (deg * Math.PI) / 180;
          for (const runoff of RUNOFFS) {
            // (cx, cz) is the middle of the full-length strip; a shorter one keeps the same start.
            const length = DRAG_STRIP.stage + DRAG_STRIP.run + runoff;
            const sx = cx - Math.sin(h) * (LENGTH / 2);
            const sz = cz - Math.cos(h) * (LENGTH / 2);
            const fp = footprint(sx, sz, h, base, clear, length);
            if (!fp) continue;
            tally.footprints++;
            const ln = link(sx, sz, h, fp.H, isl, base, roadOnly);
            if (!ln) break;
            tally.links++;
            // Flat and well clear is best; a long link road or a short run-off counts against it a little.
            const score = Math.max(0, fp.rough - ROUGH) * 1.5 + fp.rough * 0.5 + fp.apronRough * 0.3 + Math.max(0, CLEAR - fp.minClear) / 20 + ln.len / 60 + (DRAG_STRIP.runoff - runoff) / 25;
            found.push({ cx, cz, sx, sz, h, length, ...fp, ln, score });
            break;
          }
        }
      }
    }
    log(`${def.name}: ${found.length} possible sites`, tally);
    // Two far apart (at least 60 % of the furthest any two could be), then
    // the best-scoring pair of those.
    let pair = null;
    let far = 0;
    for (let a = 0; a < found.length; a++) for (let b = a + 1; b < found.length; b++) far = Math.max(far, Math.hypot(found[a].cx - found[b].cx, found[a].cz - found[b].cz));
    for (let a = 0; a < found.length; a++) {
      for (let b = a + 1; b < found.length; b++) {
        const d = Math.hypot(found[a].cx - found[b].cx, found[a].cz - found[b].cz);
        if (d < Math.max(300, far * 0.6)) continue;
        const sc = found[a].score + found[b].score;
        if (!pair || sc < pair.sc) pair = { sc, list: [found[a], found[b]] };
      }
    }
    if (!pair && found.length) pair = { list: [found.sort((p, q) => p.score - q.score)[0]] };
    for (const f of pair?.list ?? []) {
      const dir = DIRS[Math.round(Math.atan2(f.cz - def.cz, f.cx - def.cx) / (Math.PI / 4) + 8) % 8];
      chosen.push({
        id: `${def.id}-${dir}`,
        name: `Drag strip · ${def.name} ${dir}`,
        island: def.id,
        x: round(f.sx),
        z: round(f.sz),
        heading: round(f.h, 1e4),
        length: f.length,
        entry: f.ln.entry,
        link: f.ln.ctrl.map(([x, z]) => [round(x), round(z)]),
        _info: { H: round(f.H), rough: round(f.rough), apronRough: round(f.apronRough), minClear: Math.round(f.minClear), link: f.ln.len, grade: round(f.ln.grade, 1000), joins: f.ln.joins, score: round(f.score) },
      });
    }
  }
  console.log(JSON.stringify(chosen, null, 1));
  log(`done in ${Date.now() - t0} ms`);
}
