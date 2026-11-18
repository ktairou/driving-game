// Checks the country roads (COUNTRY_ROADS in src/world/layout.js) the way
// the game will build them, so new points (drawn by hand, or traced along
// gentle ground by a route finder) can be tested here before the game is
// loaded:
//
//   node tools/plan-roads.mjs [--roads roads.json] [--reserve strips.json]
//
// --roads tries other points instead of the ones in layout.js (a JSON list
// shaped like COUNTRY_ROADS); --reserve keeps them clear of drag strips that
// are not frozen yet (a list shaped like DRAG_STRIPS, as plan-dragstrips.mjs
// prints it).
//
// For each road it prints its length, how its ends join (which road, how far
// off its centre line, at what angle), the steepest grade, the deepest cut
// or bank, the tightest bend, and how near it comes to towns, landmarks (and
// their hills), fuel stations, speed traps, street race gates and finishes,
// drag strips, other roads and the road to France; then whether the frozen
// fuel stations, speed traps and street races still work, and a fingerprint
// of every other road (it must not change when country roads are added).
// Anything out of bounds is listed under "problems".
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as L from "../src/world/layout.js";

const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};
if (opt("roads")) L.COUNTRY_ROADS.splice(0, L.COUNTRY_ROADS.length, ...JSON.parse(readFileSync(opt("roads"), "utf8")));
const RESERVE = opt("reserve") ? JSON.parse(readFileSync(opt("reserve"), "utf8")) : [];

// (Imported only now, so the world is built with the roads above.)
const { World } = await import("../src/world/world.js");
const { planStations } = await import("../src/world/stations.js");
const { inTown } = await import("../src/world/road.js");
const { Navigator } = await import("../src/navigation.js");
const { ISLANDS, COUNTRY_ROADS, DRAG_STRIPS, DRAG_STRIP, SPEED_TRAPS, STREET_RACES, ROAD_SAMPLE_STEP } = L;

const world = new World();
const stations = planStations(world);
const net = world.network;
const nav = new Navigator(world);
const round = (v, k = 10) => Math.round(v * k) / k;
const problems = [];

// Limits.
const GRADE = 0.086; // steepest a country road may climb (network.js keeps it to 8.5 %)
const CUT = 15; // deepest cut or highest bank (m) away from the junctions (the old roads have up to 26 m)
const RADIUS = 80; // tightest bend (m), so they can be driven at speed
const END_RADIUS = 35; // ...and within 120 m of a junction, where cars slow to turn anyway
const TOWN_GAP = 48; // from a town's box (town.js clears buildings within 40 m of any road)
const LANDMARK_GAP = 40; // from a landmark's base
const STATION_GAP = 55; // from a fuel station's forecourt (its middle)
const JUNCTION_STATION = 80; // from a junction to a station's spot on the road
const TRAP_GAP = 75; // from a junction to a speed trap
const GATE_GAP = 75; // ...to a street race's start gate (and the start of its grid)
const FINISH_GAP = 45; // ...to a street race's finish line
const ROAD_GAP = 45; // between a country road and any other road, away from where they join
const STRIP_GAP = 60; // from a drag strip's lanes (its apron and barriers are 22 m out)
const FRANCE_GAP = 100; // from the road to France (Tower Bridge's approach)

const TOWER_ROAD = net.roads.find((r) => r.id === "toFrance");
const country = new Set(COUNTRY_ROADS.map((r) => r.id));
const LANDMARKS = ISLANDS.flatMap((d) => d.landmarks);

// The strips (frozen ones and reserved ones) as segments, and their link roads.
const strips = [...DRAG_STRIPS, ...RESERVE].map((s) => ({ id: s.id, x: s.x, z: s.z, fx: Math.sin(s.heading), fz: Math.cos(s.heading), length: s.length, link: s.link }));
const stripGap = (x, z) => {
  let best = Infinity;
  for (const s of strips) {
    const u = Math.max(0, Math.min(s.length, (x - s.x) * s.fx + (z - s.z) * s.fz));
    best = Math.min(best, Math.hypot(x - (s.x + s.fx * u), z - (s.z + s.fz * u)));
  }
  return best;
};
const linkGap = (x, z) => Math.min(Infinity, ...RESERVE.flatMap((s) => s.link.map(([lx, lz]) => Math.hypot(lx - x, lz - z))));

function townGap(x, z) {
  let best = Infinity;
  for (const t of L.TOWNS) best = Math.min(best, Math.max(Math.abs(x - t.cx) - t.hx, Math.abs(z - t.cz) - t.hz));
  return best;
}

// Tightest bend: the turn over 30 m either side of each sample (away from
// the ends, or near them).
function tightest(road, nearEnds) {
  let best = Infinity;
  let at = 0;
  const k = 15;
  for (let i = k; i < road.count - k; i++) {
    if ((Math.min(i, road.count - 1 - i) * ROAD_SAMPLE_STEP < 120) !== nearEnds) continue;
    const [ax, az] = road.tangents[i - k];
    const [bx, bz] = road.tangents[i + k];
    const turn = Math.acos(Math.max(-1, Math.min(1, ax * bx + az * bz)));
    const r = turn > 1e-6 ? (2 * k * ROAD_SAMPLE_STEP) / turn : Infinity;
    if (r < best) {
      best = r;
      at = i;
    }
  }
  return { r: best, at: road.points[at] };
}

const report = [];
for (const road of net.roads.filter((r) => country.has(r.id))) {
  const isl = world.islandById(road.island);
  const n = road.count;
  const out = { id: road.id, island: road.island, length: n * ROAD_SAMPLE_STEP };
  const bad = (what) => problems.push(`${road.id}: ${what}`);
  // How each end joins.
  const ends = net.junctions.filter((j) => j.road === road);
  out.joins = ends.map((j) => {
    const [x, z] = road.points[j.end];
    const [ox, oz] = j.other.points[j.at];
    const off = Math.hypot(x - ox, z - oz);
    const [tx, tz] = road.tangents[j.end];
    const [ux, uz] = j.other.tangents[j.at];
    const angle = Math.round((Math.asin(Math.min(1, Math.abs(tx * uz - tz * ux))) * 180) / Math.PI);
    if (off > 1) bad(`end ${j.end} is ${round(off)} m off ${j.other.id}'s centre line`);
    if (angle < 50) bad(`end ${j.end} meets ${j.other.id} at only ${angle} degrees`);
    const near = (list, gap, what) => {
      for (const [px, pz, name] of list) if (Math.hypot(px - x, pz - z) < gap) bad(`junction at ${round(x)},${round(z)} is ${round(Math.hypot(px - x, pz - z))} m from ${what} ${name}`);
    };
    near(stations.map((s) => [s.ox, s.oz, s.name]), JUNCTION_STATION, "station");
    near(SPEED_TRAPS.map((t) => [t.x, t.z, t.id]), TRAP_GAP, "trap");
    near(STREET_RACES.flatMap((r) => [[r.x, r.z, r.id], [r.start[0], r.start[1], `${r.id} grid`]]), GATE_GAP, "gate");
    near(STREET_RACES.map((r) => [r.finish[0], r.finish[1], `${r.id} finish`]), FINISH_GAP, "finish");
    near(net.meetingPoints.filter((m) => Math.hypot(m.x - x, m.z - z) > 3).map((m) => [m.x, m.z, "junction"]), 60, "another");
    return { to: j.other.id, at: j.at, x: round(x), z: round(z), off: round(off, 100), angle };
  });
  if (ends.length !== 2) bad(`joins ${ends.length} roads (should be 2)`);
  // Grades, cuts and banks.
  let grade = 0;
  let cut = 0;
  let cutAt = null;
  for (let i = 1; i < n; i++) grade = Math.max(grade, Math.abs(road.heights[i] - road.heights[i - 1]) / ROAD_SAMPLE_STEP);
  for (let i = 15; i < n - 15; i++) {
    const d = road.heights[i] - world.baseHeight(...road.points[i]);
    if (Math.abs(d) > Math.abs(cut)) {
      cut = d;
      cutAt = road.points[i].map((v) => round(v));
    }
  }
  out.grade = round(grade * 100, 10);
  out.cut = round(cut);
  out.cutAt = cutAt;
  if (grade > GRADE) bad(`grade ${out.grade} %`);
  if (Math.abs(cut) > CUT) bad(`${cut > 0 ? "bank" : "cut"} of ${round(Math.abs(cut))} m at ${cutAt}`);
  const bend = tightest(road, false);
  const endBend = tightest(road, true);
  out.bend = [Math.round(bend.r), Math.round(endBend.r)];
  if (bend.r < RADIUS) bad(`bend of ${Math.round(bend.r)} m radius at ${bend.at.map((v) => round(v))}`);
  if (endBend.r < END_RADIUS) bad(`bend of ${Math.round(endBend.r)} m radius by a junction at ${endBend.at.map((v) => round(v))}`);
  out.climb = [round(Math.min(...road.heights)), round(Math.max(...road.heights))];
  if (road.bridge.some(Boolean)) bad(`${road.bridge.filter(Boolean).length} samples over water (would be a bridge)`);
  // Clearances along the road (the ends excepted, where it joins another).
  const gaps = { town: Infinity, landmark: Infinity, station: Infinity, road: Infinity, strip: Infinity, link: Infinity, france: Infinity };
  const others = net.roads.filter((r) => r !== road && r.style !== "drag");
  const mine = net.junctions.filter((j) => j.road === road || j.other === road).map((j) => ({ x: j.road.points[j.end][0], z: j.road.points[j.end][1] }));
  for (let i = 0; i < n; i += 2) {
    const [x, z] = road.points[i];
    gaps.town = Math.min(gaps.town, townGap(x, z));
    for (const lm of LANDMARKS) {
      gaps.landmark = Math.min(gaps.landmark, Math.hypot(x - lm.x, z - lm.z) - (lm.base ?? 30) / 2);
      if (lm.hill) gaps.landmark = Math.min(gaps.landmark, Math.hypot(x - lm.x, z - lm.z - (lm.hill.dz ?? 0)) - lm.hill.r + LANDMARK_GAP);
    }
    for (const s of stations) gaps.station = Math.min(gaps.station, Math.hypot(x - s.x, z - s.z));
    gaps.strip = Math.min(gaps.strip, stripGap(x, z));
    gaps.link = Math.min(gaps.link, linkGap(x, z));
    if (TOWER_ROAD) for (let k = 0; k < TOWER_ROAD.count; k += 4) gaps.france = Math.min(gaps.france, Math.hypot(x - TOWER_ROAD.points[k][0], z - TOWER_ROAD.points[k][1]));
    // Other roads: not near where this road meets another on purpose.
    if (!mine.some((m) => Math.hypot(m.x - x, m.z - z) < 70)) {
      for (const r of others) {
        const k = net._nearestOn(r, [x, z], ROAD_GAP + 5);
        if (k < 0) continue;
        gaps.road = Math.min(gaps.road, Math.hypot(r.points[k][0] - x, r.points[k][1] - z));
      }
    }
  }
  for (const k in gaps) gaps[k] = Math.round(gaps[k]);
  out.gaps = gaps;
  if (gaps.town < TOWN_GAP) bad(`${gaps.town} m from a town`);
  if (gaps.landmark < LANDMARK_GAP) bad(`${gaps.landmark} m from a landmark`);
  if (gaps.station < STATION_GAP) bad(`${gaps.station} m from a fuel station`);
  if (gaps.road < ROAD_GAP) bad(`${gaps.road} m from another road`);
  if (gaps.strip < STRIP_GAP) bad(`${gaps.strip} m from a drag strip`);
  if (gaps.france < FRANCE_GAP) bad(`${gaps.france} m from the road to France`);
  const crossings = net.crossings.filter((c) => c.a === road || c.b === road);
  out.crossings = crossings.length;
  if (crossings.length) bad(`crosses ${crossings.map((c) => (c.a === road ? c.b : c.a).id).join(", ")}`);
  report.push(out);
}

// --- The things that must not move -------------------------------------------------

// Fuel stations: where they stand (compare with an earlier run).
const stationList = stations.map((s) => [s.name.replace("Fuel station · ", ""), round(s.x, 100), round(s.z, 100), round(s.y, 100)]);

// Speed traps: still on the road they were picked on, with no junction near.
const traps = SPEED_TRAPS.map((t) => {
  const { road, dist } = net.nearest(t.x, t.z);
  const meet = net.isNearMeeting(t.x, t.z, 75);
  if (meet) problems.push(`${t.id}: a junction within 75 m`);
  if (country.has(road.id) || dist > 2.5) problems.push(`${t.id}: now nearest to ${road.id} (${round(dist)} m)`);
  return { id: t.id, road: road.id, dist: round(dist, 100), meeting: meet };
});

// Street races: their routes (as the game finds them), how long, and whether
// they double back.
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
function overlap(pts) {
  let n = 0;
  for (let i = 0; i < pts.length; i += 2) {
    for (let j = i + 70; j < pts.length; j += 2) {
      if (Math.abs(pts[i][0] - pts[j][0]) < 12 && Math.abs(pts[i][1] - pts[j][1]) < 12) n++;
    }
  }
  return n;
}
const races = STREET_RACES.map((r) => {
  const pts = routeVia([r.start, ...r.via, r.finish]);
  // The other cars carry on past the finish to the run-out: it must lie ahead,
  // not back the way they came.
  const on = pts && routeVia([r.finish, r.runout]);
  if (on && pts.length > 8 && on.length > 8) {
    const a = [pts[pts.length - 1][0] - pts[pts.length - 8][0], pts[pts.length - 1][1] - pts[pts.length - 8][1]];
    const b = [on[7][0] - on[0][0], on[7][1] - on[0][1]];
    if (a[0] * b[0] + a[1] * b[1] < 0) problems.push(`${r.id}: the run-out is back the way the race came`);
  }
  const length = pts ? (pts.length - 1) * ROAD_SAMPLE_STEP : null;
  // Which country roads it uses.
  const used = new Set();
  for (const [x, z] of pts ?? []) {
    const { road, index, dist } = net.nearest(x, z);
    if (dist < 3 && country.has(road.id) && Math.min(index, road.count - 1 - index) > 10) used.add(road.id);
  }
  const over = pts ? overlap(pts) : null;
  if (!pts) problems.push(`${r.id}: no route`);
  else if (over > 6 || length < 2000 || length > 4500) problems.push(`${r.id}: ${length} m, overlap ${over}`);
  if (net.isNearMeeting(r.x, r.z, 75)) problems.push(`${r.id}: a junction within 75 m of the gate`);
  if (net.isNearMeeting(r.finish[0], r.finish[1], 45)) problems.push(`${r.id}: a junction within 45 m of the finish`);
  return { id: r.id, length, frozen: r.length, overlap: over, uses: [...used] };
});

// Every road but the country roads and the strips, which must stay as they
// were, and how they join (each other, not counting the country roads).
const hash = createHash("sha1");
for (const j of net.junctions) if (!country.has(j.road.id) && j.road.style !== "drag") hash.update(`${j.road.id}:${j.end}>${j.other.id}@${j.at};`);
for (const r of net.roads) {
  if (country.has(r.id) || r.style === "drag") continue;
  hash.update(r.id);
  for (let i = 0; i < r.count; i++) hash.update(`${r.points[i][0].toFixed(3)},${r.points[i][1].toFixed(3)},${r.heights[i].toFixed(3)};`);
}

const total = {};
for (const r of report) total[r.island] = (total[r.island] ?? 0) + r.length;
console.log(JSON.stringify({ roads: report, total, problems, traps, races, stations: stationList, fingerprint: hash.digest("hex").slice(0, 16) }, null, 1));
