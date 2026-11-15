// Picks the spots for the speed traps and the street races by searching the
// roads, the way plan-dragstrips.mjs picks the drag strips. Run it once; the
// spots it prints are then frozen into SPEED_TRAPS and STREET_RACES in
// src/world/layout.js, so they never move between versions.
//
//   node tools/plan-extras.mjs           search and print new spots
//   node tools/plan-extras.mjs --check   report on the spots in layout.js
//
// Speed traps: up to four per country on long, straight or gently curving
// country roads, well away from towns, junctions, fuel stations, drag strips,
// landmarks and Tower Bridge, with level ground beside the road for the
// camera pole. (France has room for only two.)
//
// Street races: one start gate near each of six landmarks, on a straight bit
// of country road (so the start grid stays clear of parked cars, traffic
// lights and junctions), racing to a finish near another landmark in the same
// country. Short routes go round by a point on the way, so every race is
// about 2 to 4.5 km and never drives back down a road it has just used.
import { World } from "../src/world/world.js";
import { planStations } from "../src/world/stations.js";
import { inTown } from "../src/world/road.js";
import { Navigator } from "../src/navigation.js";
import { ISLANDS, DRAG_STRIPS, ROAD_HALF_WIDTH, ROAD_SAMPLE_STEP, SPEED_TRAPS, STREET_RACES } from "../src/world/layout.js";

const CHECK = process.argv.includes("--check");
const log = (...a) => console.error(...a);
const t0 = Date.now();
const world = new World();
const stations = planStations(world);
const nav = new Navigator(world);
log(`world + stations + routes: ${Date.now() - t0} ms`);

const round = (v, k = 100) => Math.round(v * k) / k;
const LANDMARKS = ISLANDS.flatMap((d) => d.landmarks.map((lm) => ({ ...lm, island: d.id })));
const TOWER = LANDMARKS.find((lm) => lm.type === "towerBridge");
const DIRS = ["east", "north-east", "north", "north-west", "west", "south-west", "south", "south-east"];
const compass = (x, z, def) => DIRS[Math.round(Math.atan2(z - def.cz, x - def.cx) / (Math.PI / 4) + 8) % 8];

// Distance from a point to a drag strip (its lanes) or the start of its link road.
function stripDist(x, z) {
  let best = Infinity;
  for (const s of DRAG_STRIPS) {
    const fx = Math.sin(s.heading);
    const fz = Math.cos(s.heading);
    const u = Math.max(0, Math.min(s.length, (x - s.x) * fx + (z - s.z) * fz));
    best = Math.min(best, Math.hypot(x - (s.x + fx * u), z - (s.z + fz * u)), Math.hypot(x - s.link[0][0], z - s.link[0][1]));
  }
  return best;
}
const stationDist = (x, z) => Math.min(...stations.map((s) => Math.min(Math.hypot(s.x - x, s.z - z), Math.hypot(s.ox - x, s.oz - z))));
const landmarkDist = (x, z) => Math.min(...LANDMARKS.map((lm) => Math.hypot(lm.x - x, lm.z - z) - (lm.base ?? 30) / 2));

// Index i of a road, wrapped round a loop (or null past the end of an open road).
const wrap = (road, i) => (road.closed ? ((i % road.count) + road.count) % road.count : i >= 0 && i < road.count ? i : null);

// How far the road runs straight from sample i (within `tol` radians of its
// direction there), forwards (dir 1) or backwards (dir -1), up to `max` metres.
function straightRun(road, i, dir, tol, max) {
  const [tx, tz] = road.tangents[i];
  const c = Math.cos(tol);
  let k = 1;
  for (; k * ROAD_SAMPLE_STEP < max; k++) {
    const j = wrap(road, i + dir * k);
    if (j === null) break;
    const [ax, az] = road.tangents[j];
    if (ax * tx + az * tz < c) break;
  }
  return (k - 1) * ROAD_SAMPLE_STEP;
}

// No bridge within `r` samples either way.
function offBridge(road, i, r) {
  for (let k = -r; k <= r; k++) {
    const j = wrap(road, i + k);
    if (j !== null && road.bridge[j]) return false;
  }
  return true;
}

// Ground beside the road at side offset `w` (right of travel is +): on land,
// and near the road's own height.
function verge(road, i, w, within) {
  const [x, z] = road.points[i];
  const [tx, tz] = road.tangents[i];
  const px = x + tz * w;
  const pz = z - tx * w;
  const g = world.getHeight(px, pz);
  return g > 1.5 && Math.abs(g - road.heights[i]) < within ? { x: px, z: pz, g } : null;
}

// --- Speed traps ---------------------------------------------------------------

const POLE_W = ROAD_HALF_WIDTH + 2.4;
const FAST_RADIUS = 380; // bends gentler than this can be taken flat out

// Whether the road bends no tighter than FAST_RADIUS around sample i (over 32 m).
function gentle(road, i) {
  const a = wrap(road, i - 8);
  const b = wrap(road, i + 8);
  if (a === null || b === null) return false;
  const [ax, az] = road.tangents[a];
  const [bx, bz] = road.tangents[b];
  const turn = Math.acos(Math.min(1, ax * bx + az * bz));
  return turn < (16 * ROAD_SAMPLE_STEP) / FAST_RADIUS;
}

// How far the road stays gentle (and off bridges) from sample i, forwards
// (dir 1) or backwards (dir -1), up to `max` metres.
function fastRun(road, i, dir, max) {
  let k = 1;
  for (; k * ROAD_SAMPLE_STEP < max; k++) {
    const j = wrap(road, i + dir * k);
    if (j === null || road.bridge[j] || !gentle(road, j)) break;
  }
  return (k - 1) * ROAD_SAMPLE_STEP;
}

function trapCandidates(def) {
  const out = [];
  // (How many spots each rule turned away, printed to help when tuning.)
  const why = { bridge: 0, town: 0, meet: 0, station: 0, strip: 0, landmark: 0, tower: 0, bend: 0, short: 0, steep: 0, verge: 0 };
  const no = (k) => (why[k]++, true);
  for (const road of world.network.roads) {
    if (road.style || road.island !== def.id) continue;
    for (let i = 0; i < road.count; i += 2) {
      const [x, z] = road.points[i];
      if (!gentle(road, i) && no("bend")) continue;
      if ((!offBridge(road, i, 40) && no("bridge")) || (inTown(x, z, 70) && no("town")) || (world.network.isNearMeeting(x, z, 75) && no("meet"))) continue;
      if ((stationDist(x, z) < 130 && no("station")) || (stripDist(x, z) < 140 && no("strip")) || (landmarkDist(x, z) < 90 && no("landmark"))) continue;
      if (TOWER && Math.hypot(x - TOWER.x, z - TOWER.z) < 450 && no("tower")) continue;
      // Fast for a good way at least one way in, and a little the other.
      const fwd = fastRun(road, i, 1, 500);
      const back = fastRun(road, i, -1, 500);
      if ((Math.min(fwd, back) < 60 || Math.max(fwd, back) < 160) && no("short")) continue;
      // Level enough that a fast car doesn't take off over it.
      const a = wrap(road, i - 15) ?? i;
      const b = wrap(road, i + 15) ?? i;
      if (Math.abs(road.heights[b] - road.heights[a]) > 2.4 && no("steep")) continue;
      // The pole stands on whichever verge is level with the road.
      let side = 0;
      for (const sd of def.drive === "left" ? [-1, 1] : [1, -1]) {
        if (verge(road, i, sd * POLE_W, 0.7) && verge(road, i, sd * (POLE_W + 1.5), 1.2)) {
          side = sd;
          break;
        }
      }
      if (!side && no("verge")) continue;
      out.push({ road, i, x, z, side, fwd, back, score: Math.max(fwd, back) + 0.5 * Math.min(fwd, back) });
    }
  }
  log(def.name, why);
  return out;
}

function pickTraps() {
  const chosen = [];
  for (const def of ISLANDS) {
    const cands = trapCandidates(def);
    // Up to four, at least 280 m apart: starting from each good spot in turn,
    // add the one furthest from those already picked; keep the start that
    // fits the most in (then the straightest set).
    const good = cands.filter((c) => c.score >= 200);
    let mine = [];
    let mineScore = 0;
    for (const first of good) {
      const set = [first];
      while (set.length < 4) {
        let best = null;
        let bestD = 280;
        for (const c of good) {
          const d = Math.min(...set.map((m) => Math.hypot(m.x - c.x, m.z - c.z)));
          if (d > bestD) {
            bestD = d;
            best = c;
          }
        }
        if (!best) break;
        set.push(best);
      }
      const sc = set.reduce((t, c) => t + c.score, 0);
      if (set.length > mine.length || (set.length === mine.length && sc > mineScore)) {
        mine = set;
        mineScore = sc;
      }
    }
    log(`${def.name}: ${cands.length} trap spots, ${good.length} good, chose ${mine.length}`);
    for (const c of mine) {
      let dir = compass(c.x, c.z, def);
      let name = `${dir[0].toUpperCase()}${dir.slice(1)} speed trap`;
      if (chosen.some((o) => o.name === name && o.island === def.id)) name += " 2";
      const [tx, tz] = c.road.tangents[c.i];
      chosen.push({
        id: `trap-${def.id}-${dir}${chosen.some((o) => o.id === `trap-${def.id}-${dir}`) ? "-2" : ""}`,
        name,
        island: def.id,
        x: round(c.x),
        z: round(c.z),
        heading: round(Math.atan2(tx, tz), 1e4),
        side: c.side,
        _info: { road: c.road.id, i: c.i, straight: [c.back, c.fwd] },
      });
    }
  }
  return chosen;
}

// --- Street races ---------------------------------------------------------------

// From one landmark to another, in the same country.
const PAIRS = [
  ["Big Ben", "Stonehenge"],
  ["Stonehenge", "Tower Bridge"],
  ["Eiffel Tower", "Notre-Dame"],
  ["Pyramids", "Abu Simbel"],
  ["Statue of Liberty", "Mount Rushmore"],
  ["Empire State Building", "Hollywood sign"],
];
const MIN_LEN = 2000;
const MAX_LEN = 4500;
const BACK = 15; // the route starts this many samples behind the gate (the grid is in between)
const RUNOUT = 120; // ...and the rivals' route carries on this many samples past the finish

// Road samples a gate can stand at: straight for the grid behind it and a
// little way in front, out of town, away from junctions, stations, strips
// and traffic, with land beside the road for the gantry posts.
function gateCandidates(def, lm, traps) {
  const out = [];
  for (const road of world.network.roads) {
    if (road.style || road.island !== def.id) continue;
    for (let i = 0; i < road.count; i++) {
      const [x, z] = road.points[i];
      const d = Math.hypot(x - lm.x, z - lm.z);
      if (d > 650 || !offBridge(road, i, 30)) continue;
      if (inTown(x, z, 35) || world.network.isNearMeeting(x, z, 75)) continue;
      if (stationDist(x, z) < 160 || stripDist(x, z) < 160 || landmarkDist(x, z) < 25) continue;
      if (traps.some((t) => Math.hypot(t.x - x, t.z - z) < 250)) continue;
      if (![-1, 1].every((sd) => verge(road, i, sd * (ROAD_HALF_WIDTH + 1.3), 2.5))) continue;
      out.push({ road, i, x, z, d });
    }
  }
  return out;
}

// Route points as [x, z] pairs (the Navigator's own points, smoothed).
function routeVia(points) {
  const out = [];
  for (let k = 0; k + 1 < points.length; k++) {
    const r = nav.route(points[k][0], points[k][1], points[k + 1][0], points[k + 1][1]);
    if (!r) return null;
    const pts = r.points.map((p) => [p.x, p.z]);
    if (out.length) pts.shift();
    out.push(...pts);
  }
  return out;
}

// The Navigator's node for a point, and the driving distance from a point to every node.
const node = (x, z) => nav._node(x, z);
function distFrom(x, z) {
  const dist = new Float64Array(nav.total).fill(Infinity);
  const start = node(x, z);
  dist[start] = 0;
  // (A plain binary heap of [cost, node].)
  const heap = [[0, start]];
  const push = (c, n) => {
    heap.push([c, n]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (l + 1 < heap.length && heap[l + 1][0] < heap[m][0]) m = l + 1;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [d, u] = pop();
    if (d > dist[u]) continue;
    for (const [v, w] of nav.adj[u]) {
      if (d + w < dist[v]) {
        dist[v] = d + w;
        push(d + w, v);
      }
    }
  }
  return dist;
}

// How many route points come back within 12 m of a point well before them
// (driving back down the same road, or round the same bend twice).
function overlap(pts) {
  let n = 0;
  for (let i = 0; i < pts.length; i += 2) {
    for (let j = i + 70; j < pts.length; j += 2) {
      if (Math.abs(pts[i][0] - pts[j][0]) < 12 && Math.abs(pts[i][1] - pts[j][1]) < 12) n++;
    }
  }
  return n;
}

// Which way along the road the route leaves sample i of `road`.
function leaves(road, i, pts) {
  const [tx, tz] = road.tangents[i];
  const k = Math.min(pts.length - 1, BACK + 10);
  return (pts[k][0] - road.points[i][0]) * tx + (pts[k][1] - road.points[i][1]) * tz > 0 ? 1 : -1;
}

function planRace([fromName, toName], traps, taken) {
  const from = LANDMARKS.find((l) => l.name === fromName);
  const to = LANDMARKS.find((l) => l.name === toName);
  const def = ISLANDS.find((d) => d.id === from.island);
  // (Every 4th sample is plenty to choose from.)
  const all = gateCandidates(def, from, traps);
  const gates = all.filter((c) => c.i % 4 === 0 && taken.every((t) => Math.hypot(t.x - c.x, t.z - c.z) > 300));
  gates.sort((p, q) => p.d - q.d);
  const finishes = [];
  for (const road of world.network.roads) {
    if (road.style || road.island !== def.id) continue;
    for (let i = 0; i < road.count; i += 2) {
      const [x, z] = road.points[i];
      const d = Math.hypot(x - to.x, z - to.z);
      if (d > 620 || !offBridge(road, i, 10) || world.network.isNearMeeting(x, z, 45) || landmarkDist(x, z) < 20) continue;
      finishes.push({ road, i, x, z, d });
    }
  }
  finishes.sort((p, q) => p.d - q.d);
  log(`${fromName}: ${all.length} gate spots, ${finishes.length} finish spots`);
  // Points to go round by when the straight way is short: every 20th road sample.
  const vias = [];
  for (const road of world.network.roads) {
    if (road.style || road.island !== def.id) continue;
    for (let i = 0; i < road.count; i += 20) if (!road.bridge[i] && !world.network.isNearMeeting(...road.points[i], 40)) vias.push(road.points[i]);
  }
  const fromF = finishes.slice(0, 8).map((f) => ({ f, dist: distFrom(f.x, f.z) }));
  let best = null;
  // (Why routes were turned away, printed if none is found.)
  const why = { tries: 0, bend: 0, len: 0, runout: 0, overlap: 0 };
  for (const g of gates.slice(0, 30)) {
    const dg = distFrom(g.x, g.z);
    for (const { f, dist: df } of fromF) {
      // The straight way, or round by one point, whichever comes nearest 3.3 km.
      const tries = [];
      const direct = dg[node(f.x, f.z)];
      if (direct >= MIN_LEN && direct <= MAX_LEN) tries.push({ via: [], est: direct });
      for (const v of vias) {
        const n = node(v[0], v[1]);
        const est = dg[n] + df[n];
        if (est >= MIN_LEN && est <= MAX_LEN) tries.push({ via: [v], est });
      }
      tries.sort((p, q) => Math.abs(p.est - 3300) + p.via.length * 400 - (Math.abs(q.est - 3300) + q.via.length * 400));
      why.tries += Math.min(12, tries.length);
      for (const { via } of tries.slice(0, 12)) {
        const pts0 = routeVia([[g.x, g.z], ...via, [f.x, f.z]]);
        if (!pts0) continue;
        const dir = leaves(g.road, g.i, pts0);
        // Straight for the grid behind the gate and a bit in front of it.
        if (straightRun(g.road, g.i, -dir, 0.12, 60) < 44 || straightRun(g.road, g.i, dir, 0.12, 30) < 20) {
          why.bend++;
          continue;
        }
        const si = wrap(g.road, g.i - dir * BACK);
        if (si === null) continue;
        const start = g.road.points[si];
        const pts = routeVia([start, ...via, [f.x, f.z]]);
        if (!pts) continue;
        const len = (pts.length - 1) * ROAD_SAMPLE_STEP;
        if (len < MIN_LEN || len > MAX_LEN) {
          why.len++;
          continue;
        }
        // The run-out: on along the road the route arrives on, past the finish.
        const [ftx, ftz] = f.road.tangents[f.i];
        const fl = pts.length - 1;
        const fdir = (pts[fl][0] - pts[Math.max(0, fl - 6)][0]) * ftx + (pts[fl][1] - pts[Math.max(0, fl - 6)][1]) * ftz > 0 ? 1 : -1;
        const ri = wrap(f.road, f.i + fdir * RUNOUT);
        if (ri === null) continue;
        let runClear = true;
        for (let k = 1; k <= RUNOUT; k++) runClear &&= !f.road.bridge[wrap(f.road, f.i + fdir * k)];
        if (!runClear) {
          why.runout++;
          continue;
        }
        const over = overlap(pts);
        if (over > 6) {
          why.overlap++;
          continue;
        }
        const score = g.d / 60 + f.d / 60 + Math.abs(len - 3300) / 300 + over * 2 + via.length * 1.5;
        if (!best || score < best.score) best = { g, f, via, start, runout: f.road.points[ri], len, dir, over, score };
      }
    }
    if (best) break; // the nearest gate that works is good enough
  }
  if (!best) {
    log(`no race found for ${fromName} -> ${toName}`, why);
    return null;
  }
  const [tx, tz] = best.g.road.tangents[best.g.i];
  const id = `street-${fromName.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  log(`${fromName} -> ${toName}: ${best.len} m, gate ${round(best.g.d)} m from ${fromName}, finish ${round(best.f.d)} m from ${toName}, via ${best.via.length}, overlap ${best.over}`);
  return {
    id,
    name: `${fromName} to ${toName}`,
    island: def.id,
    x: round(best.g.x),
    z: round(best.g.z),
    heading: round(Math.atan2(tx * best.dir, tz * best.dir), 1e4),
    start: best.start.map((v) => round(v)),
    via: best.via.map((p) => p.map((v) => round(v))),
    finish: [round(best.f.x), round(best.f.z)],
    runout: best.runout.map((v) => round(v)),
    length: best.len,
  };
}

if (CHECK) {
  const out = { traps: [], races: [] };
  for (const t of SPEED_TRAPS) {
    const { road, index, dist } = world.network.nearest(t.x, t.z);
    out.traps.push({ id: t.id, road: road.id, index, dist: round(dist), fast: [fastRun(road, index, -1, 500), fastRun(road, index, 1, 500)], town: inTown(t.x, t.z, 70), meeting: world.network.isNearMeeting(t.x, t.z, 75), station: Math.round(stationDist(t.x, t.z)), strip: Math.round(stripDist(t.x, t.z)) });
  }
  for (const r of STREET_RACES) {
    const pts = routeVia([r.start, ...r.via, r.finish]);
    out.races.push({ id: r.id, length: (pts.length - 1) * ROAD_SAMPLE_STEP, frozen: r.length, overlap: overlap(pts), meeting: world.network.isNearMeeting(r.x, r.z, 75), town: inTown(r.x, r.z, 35) });
  }
  out.stations = stations.map((s) => [s.name, round(s.x), round(s.z), round(s.y)]);
  console.log(JSON.stringify(out, null, 1));
} else {
  const traps = pickTraps();
  const races = [];
  for (const p of PAIRS) {
    const r = planRace(p, traps, races);
    if (r) races.push(r);
  }
  console.log(JSON.stringify({ traps, races }, null, 1));
  log(`done in ${Date.now() - t0} ms`);
}
