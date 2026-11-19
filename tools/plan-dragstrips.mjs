// Picks the sites for the half-mile drag strips by searching the land, the
// way planStations picked the fuel stations. Run it once the roads are
// final; the sites it prints are then frozen into DRAG_STRIPS in
// src/world/layout.js, so the strips never move between versions.
//
//   node tools/plan-dragstrips.mjs           search and print new sites
//   node tools/plan-dragstrips.mjs --check   report on the sites in layout.js
//   node tools/plan-dragstrips.mjs --only britain   search one country alone
//       and take only its best site (to move one strip that no longer fits;
//       freeze it under the old strip's id, so saved bests carry over)
//
// A site is a dead-straight strip (staging box, half mile, run-off) on open
// land, with a link road from the nearest public road into its staging box
// (at the back, or square into one side). A strip is over a kilometre long,
// longer than half of any country, so the search allows what it must: the
// beach (the strip is built up on a low bank there), deeper cuts and banks
// in hilly Britain, and a run-off down to the shortest one the fastest car
// was tested to stop in (RUNOFFS). It scores sites by how level and how
// clear they are, takes the best in each country, and a second one where
// there is room for another that is nearly as good, far from the first.
//
// It keeps clear of towns, landmarks (and the hills they stand on), fuel
// stations, other roads, speed traps and street race start gates, by the
// same distances tools/plan-extras.mjs used to pick those. The ground is
// judged without the crags and sea cliffs (islands.js keeps those away from
// a strip, so they will not be there once it is built).
import { World } from "../src/world/world.js";
import { planStations } from "../src/world/stations.js";
import { inTown } from "../src/world/road.js";
import { buildCurve } from "../src/world/network.js";
import { ISLANDS, DRAG_STRIPS, DRAG_STRIP, ROAD_SAMPLE_STEP, SPEED_TRAPS, STREET_RACES } from "../src/world/layout.js";

const CHECK = process.argv.includes("--check");
const ONLY = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
const CLEAR = 120; // aimed-for distance from towns, landmarks, fuel stations and other roads
const ROUGH = 6; // aimed-for most the land may differ from the strip's level height
const LENGTH = DRAG_STRIP.stage + DRAG_STRIP.run + DRAG_STRIP.runoff;
const APRON = DRAG_STRIP.apron;
const HALF = (DRAG_STRIP.lanes * DRAG_STRIP.lane) / 2; // half the width of the lanes
const LANES_W = HALF + 2; // ...and a little beyond: the ground judged as under the lanes
const BEHIND = 60; // the link road comes in straight for this far behind the start
const CELL = 10;
const SHORE = 2.2; // lowest ground (m) under the strip: the beach, but not the wet sand
const TRAP_GAP = 140; // from a speed trap to the lanes or the link road's junction (plan-extras.mjs)
const GATE_GAP = 160; // ...and from a street race's start gate
const FINISH_GAP = 45; // a junction this near a street race's finish line would get in its way
const TOWER = ISLANDS.flatMap((d) => d.landmarks).find((lm) => lm.type === "towerBridge");

// (A fresh search ignores the strips already frozen in layout.js.)
if (!CHECK) DRAG_STRIPS.length = 0;
const t0 = Date.now();
const world = new World();
const stations = planStations(world);
const log = (...a) => console.error(...a);
log(`world + stations: ${Date.now() - t0} ms`);

// Points a strip must keep well away from: speed traps and race start gates
// (with the grid behind each), by island.
const spots = (id) => [
  ...SPEED_TRAPS.filter((t) => t.island === id).map((t) => ({ x: t.x, z: t.z, gap: TRAP_GAP })),
  ...STREET_RACES.filter((r) => r.island === id).flatMap((r) => [{ x: r.x, z: r.z, gap: GATE_GAP }, { x: r.start[0], z: r.start[1], gap: GATE_GAP }]),
];
const finishes = (id) => STREET_RACES.filter((r) => r.island === id).map((r) => r.finish);

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
  // Speed traps and start gates: well beyond CLEAR, so they rule a site out.
  for (const p of spots(isl.def.id)) stamp(p.x, p.z, p.gap + 10, (x, z) => Math.hypot(x - p.x, z - p.z) - (p.gap - 30));
  return (x, z) => {
    const i = Math.round((x - minX) / CELL);
    const j = Math.round((z - minZ) / CELL);
    if (i < 0 || j < 0 || i >= n || j >= n) return -1;
    return dist[j * n + i];
  };
}

// Ground without crags or sea cliffs on an 8 m grid (sampling the noise
// directly is too slow for the search).
function baseGrid(isl) {
  const S = 8;
  const { minX, minZ } = isl;
  const n = Math.ceil((2 * isl.def.half) / S) + 1;
  const h = new Float32Array(n * n);
  isl._freedom = () => 0;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) h[j * n + i] = isl.baseHeight(minX + i * S, minZ + j * S);
  delete isl._freedom;
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
// is halfway between the lowest and highest ground under the lanes (about:
// network.js stripHeight samples 10 m each side of the middle), which
// keeps the deepest cut or fill as small as it can be. Returns that height,
// the roughness (deepest cut or fill) under the lanes and across the whole
// levelled apron, and the clearance from the lanes.
// MAX_ROUGH and MIN_CLEAR are the hard limits (hilly Britain needs the most).
// The run-off may be shorter where it helps (RUNOFFS, longest first): even
// the fastest car stops in the shortest one with the brakes that come on by
// themselves after the finish line (tested in the game).
const MAX_ROUGH = 16;
const MIN_CLEAR = 30;
const MIN_APRON_CLEAR = 12;
const RUNOFFS = [DRAG_STRIP.runoff, 290];
function footprint(sx, sz, h, base, clear, length = LENGTH) {
  const fx = Math.sin(h);
  const fz = Math.cos(h);
  let lo = Infinity;
  let hi = -Infinity;
  let minClear = Infinity;
  let apronClear = Infinity;
  const hs = [];
  for (let u = -10; u <= length + 10; u += 15) {
    for (const w of [-APRON, -LANES_W, -10, 0, 10, LANES_W, APRON]) {
      const x = sx + fx * u + fz * w;
      const z = sz + fz * u - fx * w;
      const b = base(x, z);
      if (b < SHORE) return null; // the water's edge or the sea
      const c = clear(x, z);
      if (Math.abs(w) <= LANES_W) {
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
  if (rough > MAX_ROUGH || H < 3.5) return null;
  const apronRough = Math.max(...hs.map((b) => Math.abs(b - H)));
  return { H, rough, apronRough, minClear };
}

// Road samples a link may start from: plain public roads, away from bridges,
// junctions, towns (and their traffic lights), fuel stations, speed traps,
// race start gates and finishes, and Tower Bridge.
const joinable = [];
for (const r of world.network.roads) {
  if (r.style) continue;
  for (let k = 0; k < r.count; k++) {
    const [x, z] = r.points[k];
    if (r.bridge[k] || inTown(x, z, 40) || world.network.isNearMeeting(x, z, 70)) continue;
    if (stations.some((s) => Math.hypot(s.ox - x, s.oz - z) < 140 || Math.hypot(s.x - x, s.z - z) < 140)) continue;
    if (spots(r.island).some((p) => Math.hypot(p.x - x, p.z - z) < p.gap)) continue;
    if (finishes(r.island).some(([fx, fz]) => Math.hypot(fx - x, fz - z) < FINISH_GAP)) continue;
    if (TOWER && Math.hypot(x - TOWER.x, z - TOWER.z) < 450) continue;
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
    const ex = sx + fx * (DRAG_STRIP.stage / 2) + fz * side * HALF;
    const ez = sz + fz * (DRAG_STRIP.stage / 2) - fx * side * HALF;
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

// How near two found sites' centre lines come (sampled every 20 m).
function apart(a, b) {
  let best = Infinity;
  const pts = (f) => Array.from({ length: Math.ceil(f.length / 20) + 1 }, (_, k) => [f.sx + Math.sin(f.h) * k * 20, f.sz + Math.cos(f.h) * k * 20]);
  const pb = pts(b);
  for (const [x, z] of pts(a)) for (const [x2, z2] of pb) best = Math.min(best, Math.hypot(x - x2, z - z2));
  return best;
}
const DIRS = ["east", "north-east", "north", "north-west", "west", "south-west", "south", "south-east"];

// Nearest a strip's lanes (or its link road's junction) come to a point.
function stripGap(s, x, z) {
  const fx = Math.sin(s.heading);
  const fz = Math.cos(s.heading);
  const u = Math.max(0, Math.min(s.length, (x - s.x) * fx + (z - s.z) * fz));
  return Math.min(Math.hypot(x - (s.x + fx * u), z - (s.z + fz * u)) - HALF, Math.hypot(x - s.link[0][0], z - s.link[0][1]));
}

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
        if (Math.abs(w) <= LANES_W + 1) {
          fp.rough = Math.max(fp.rough, d);
          fp.minClear = Math.min(fp.minClear, clear(x, z));
        } else fp.apronClear = Math.min(fp.apronClear, clear(x, z));
        if (base(x, z) < SHORE) fp.wet = true;
      }
    }
    // Steepest stretch of the link road.
    let steep = 0;
    for (let k = 1; k < lnk.count; k++) steep = Math.max(steep, Math.abs(lnk.heights[k] - lnk.heights[k - 1]) / ROAD_SAMPLE_STEP);
    const jn = world.network.junctions.filter((j) => j.road === lnk);
    const near = spots(s.island).map((p) => Math.round(stripGap(s, p.x, p.z) - p.gap));
    const fin = finishes(s.island).map(([x, z]) => Math.round(Math.hypot(x - s.link[0][0], z - s.link[0][1])));
    // Would the search still take this site, as it is now (the same test it
    // makes of every site, on the ground without crags)?
    const fits = footprint(s.x, s.z, s.heading, baseGrid(isl), clear, s.length);
    out.push({ fits: !!fits, id: s.id, length: s.length, entry: s.entry, H: round(fp.H), rough: round(fp.rough), apronRough: round(fp.apronRough), minClear: Math.round(fp.minClear), apronClear: Math.round(fp.apronClear), wet: !!fp.wet, link: lnk.count * ROAD_SAMPLE_STEP, joins: jn.map((j) => `${j.other.id}@${j.at}`), linkSteepest: round(steep, 1000), trapGateSpare: Math.min(...near), finishGap: Math.min(...fin) });
  }
  console.log(JSON.stringify({ strips: out, stations: stations.map((s) => [s.name, round(s.x), round(s.z), round(s.y)]) }, null, 1));
} else {
  const chosen = [];
  for (const def of ISLANDS) {
    if (ONLY && def.id !== ONLY) continue;
    const isl = world.islandById(def.id);
    const base = baseGrid(isl);
    const clear = obstacleGrid(isl);
    const roadOnly = obstacleGrid(isl, { withStations: false });
    const found = [];
    const half = def.half - 60;
    const tally = { centres: 0, footprints: 0, links: 0 };
    for (let cz = def.cz - half; cz <= def.cz + half; cz += 20) {
      for (let cx = def.cx - half; cx <= def.cx + half; cx += 20) {
        if (base(cx, cz) < SHORE || clear(cx, cz) < MIN_CLEAR) continue;
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
            // The junction keeps clear of street race finishes.
            if (finishes(def.id).some(([x, z]) => Math.hypot(x - ln.ctrl[0][0], z - ln.ctrl[0][1]) < FINISH_GAP)) break;
            tally.links++;
            // Flat and well clear (of busy roads above all) is best; a long
            // link road or a short run-off counts against it a little.
            const score = Math.max(0, fp.rough - ROUGH) * 1.5 + fp.rough * 0.5 + fp.apronRough * 0.3 + Math.max(0, CLEAR - fp.minClear) / 10 + ln.len / 60 + (DRAG_STRIP.runoff - runoff) / 25;
            found.push({ cx, cz, sx, sz, h, length, ...fp, ln, score });
            break;
          }
        }
      }
    }
    log(`${def.name}: ${found.length} possible sites`, tally);
    found.sort((p, q) => p.score - q.score);
    // The best, and a second one where there is room: well away from the
    // first (at least 60 % of the furthest any two could be, 400 m from it at
    // the nearest, with its own junction) and scoring nearly as well.
    const list = found.length ? [found[0]] : [];
    let far = 0;
    for (const f of found) far = Math.max(far, Math.hypot(f.cx - found[0].cx, f.cz - found[0].cz));
    const second = found.find((f) => Math.hypot(f.cx - found[0].cx, f.cz - found[0].cz) > Math.max(LENGTH * 0.75, far * 0.6) && apart(f, found[0]) > 400 && Math.hypot(f.ln.ctrl[0][0] - found[0].ln.ctrl[0][0], f.ln.ctrl[0][1] - found[0].ln.ctrl[0][1]) > 300 && f.score < found[0].score * 1.6 + 4);
    if (second && !ONLY) list.push(second);
    if (ONLY) for (const f of found.slice(0, 8)) log(`  score ${round(f.score)} centre ${Math.round(f.cx)},${Math.round(f.cz)} heading ${round(f.h, 1e3)} rough ${round(f.rough)} minClear ${Math.round(f.minClear)} link ${f.ln.len}`);
    for (const f of list) {
      let dir = DIRS[Math.round(Math.atan2(f.cz - def.cz, f.cx - def.cx) / (Math.PI / 4) + 8) % 8];
      if (chosen.some((c) => c.id === `${def.id}-${dir}-half`)) dir += "-2";
      const s = {
        id: `${def.id}-${dir}-half`,
        name: `Drag strip · ${def.name} ${dir.replace("-2", " 2")}`,
        island: def.id,
        x: round(f.sx),
        z: round(f.sz),
        heading: round(f.h, 1e4),
        length: f.length,
        entry: f.ln.entry,
        link: f.ln.ctrl.map(([x, z]) => [round(x), round(z)]),
      };
      s._info = { H: round(f.H), rough: round(f.rough), apronRough: round(f.apronRough), minClear: Math.round(f.minClear), link: f.ln.len, grade: round(f.ln.grade, 1000), joins: f.ln.joins, score: round(f.score), trapGateSpare: Math.min(...spots(def.id).map((p) => Math.round(stripGap(s, p.x, p.z) - p.gap))) };
      chosen.push(s);
    }
    if (!list.length) log(`${def.name}: no site found`);
  }
  console.log(JSON.stringify(chosen, null, 1));
  log(`done in ${Date.now() - t0} ms`);
}
