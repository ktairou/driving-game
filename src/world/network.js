import { clamp, lerp, smoothstep } from "../noise.js";
import { ISLANDS, CONNECTORS, EXTRA_ROADS, ROAD_SAMPLE_STEP, BRIDGE_DECK } from "./layout.js";

// Centripetal Catmull-Rom through a list of 2D points, resampled so
// consecutive samples are `step` metres apart. `closed` joins the ends.
export function buildCurve(points, step, closed) {
  const n = points.length;
  const dense = [];
  const get = (i) => (closed ? points[(i + n) % n] : points[clamp(i, 0, n - 1)]);
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    let p0 = get(i - 1);
    const p1 = get(i);
    const p2 = get(i + 1);
    let p3 = get(i + 2);
    // Open ends: mirror so the curve leaves the end point straight.
    if (!closed && i === 0) p0 = [2 * p1[0] - p2[0], 2 * p1[1] - p2[1]];
    if (!closed && i === segs - 1) p3 = [2 * p2[0] - p1[0], 2 * p2[1] - p1[1]];
    const d = (a, b) => Math.pow(Math.hypot(b[0] - a[0], b[1] - a[1]), 0.5) || 1e-4;
    const t0 = 0;
    const t1 = t0 + d(p0, p1);
    const t2 = t1 + d(p1, p2);
    const t3 = t2 + d(p2, p3);
    const steps = 120;
    for (let s = 0; s < steps; s++) {
      const t = t1 + ((t2 - t1) * s) / steps;
      const out = [0, 0];
      for (let k = 0; k < 2; k++) {
        const a1 = ((t1 - t) / (t1 - t0)) * p0[k] + ((t - t0) / (t1 - t0)) * p1[k];
        const a2 = ((t2 - t) / (t2 - t1)) * p1[k] + ((t - t1) / (t2 - t1)) * p2[k];
        const a3 = ((t3 - t) / (t3 - t2)) * p2[k] + ((t - t2) / (t3 - t2)) * p3[k];
        const b1 = ((t2 - t) / (t2 - t0)) * a1 + ((t - t0) / (t2 - t0)) * a2;
        const b2 = ((t3 - t) / (t3 - t1)) * a2 + ((t - t1) / (t3 - t1)) * a3;
        out[k] = ((t2 - t) / (t2 - t1)) * b1 + ((t - t1) / (t2 - t1)) * b2;
      }
      dense.push(out);
    }
  }
  if (!closed) dense.push(points[n - 1]);
  // Resample by arc length.
  const samples = [dense[0]];
  let carry = 0;
  const last = closed ? dense.length : dense.length - 1;
  for (let i = 0; i < last; i++) {
    const a = dense[i];
    const b = dense[(i + 1) % dense.length];
    const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let along = step - carry;
    while (along <= segLen) {
      const t = along / segLen;
      samples.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      along += step;
    }
    carry = segLen - (along - step);
  }
  if (closed) {
    const end = samples[samples.length - 1];
    if (Math.hypot(end[0] - samples[0][0], end[1] - samples[0][1]) < step * 0.5) samples.pop();
  } else {
    samples.push(points[n - 1]);
  }
  return samples;
}

function smoothHeights(h, closed, radius, passes) {
  const n = h.length;
  const at = (i) => (closed ? h[(i + n) % n] : h[clamp(i, 0, n - 1)]);
  for (let pass = 0; pass < passes; pass++) {
    const next = new Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += at(i + k);
      next[i] = sum / (2 * radius + 1);
    }
    for (let i = 0; i < n; i++) h[i] = next[i];
  }
}

// Keep slopes drivable: at most `grade` rise per metre.
function limitGrade(h, closed, grade, pinned) {
  const n = h.length;
  const maxRise = grade * ROAD_SAMPLE_STEP;
  for (let pass = 0; pass < 8; pass++) {
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const j = (i + 1) % n;
      if (!pinned?.has(j)) h[j] = clamp(h[j], h[i] - maxRise, h[i] + maxRise);
    }
    for (let i = n - 1; i >= (closed ? 0 : 1); i--) {
      const j = (i - 1 + n) % n;
      if (!pinned?.has(j)) h[j] = clamp(h[j], h[i] - maxRise, h[i] + maxRise);
    }
  }
}

function tangentsOf(points, closed) {
  const n = points.length;
  return points.map((p, i) => {
    const a = closed ? points[(i - 1 + n) % n] : points[Math.max(0, i - 1)];
    const b = closed ? points[(i + 1) % n] : points[Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l = Math.hypot(dx, dz) || 1;
    return [dx / l, dz / l];
  });
}

// All roads in the world, with heights, bridge sections and how they join.
export class RoadNetwork {
  constructor(world) {
    this.world = world;
    this.roads = [];

    for (const isl of ISLANDS) {
      const points = buildCurve(isl.road, ROAD_SAMPLE_STEP, true);
      const island = world.islandById(isl.id);
      const raw = points.map(([x, z]) => Math.max(world.baseHeight(x, z), 2.5));
      const bridge = points.map(([x, z]) => world.baseHeight(x, z) < 1.5);
      raw.forEach((v, i) => bridge[i] && (raw[i] = BRIDGE_DECK.beam));
      smoothHeights(raw, true, 22, 4);
      for (let i = 0; i < points.length; i++) {
        const town = island.townBlend(points[i][0], points[i][1], 70);
        raw[i] = lerp(raw[i], town.h, town.w);
      }
      limitGrade(raw, true, 0.09);
      this._add({ id: isl.id, island: isl.id, closed: true, points, heights: raw, bridge, drive: isl.drive, style: null });
    }

    // Open roads: country roads first, then the bridges between countries.
    // Each end joins the nearest road already built, at that road's height.
    this.junctions = [];
    const open = [
      ...EXTRA_ROADS.map((r) => ({ ...r, bridgeStyle: "beam", drive: world.islandById(r.island).def.drive })),
      ...CONNECTORS.map((c) => ({ ...c, bridgeStyle: c.bridge, drive: world.islandById(c.from).def.drive })),
    ];
    for (const c of open) {
      const points = buildCurve(c.points, ROAD_SAMPLE_STEP, false);
      const deck = BRIDGE_DECK[c.bridgeStyle];
      const base = points.map(([x, z]) => world.baseHeight(x, z));
      const bridge = base.map((b) => b < 1.5);
      const h = base.map((b, i) => (bridge[i] ? deck : Math.max(b, 2.5)));
      smoothHeights(h, false, 22, 4);
      const n = points.length;
      // Flat through towns, like the main streets they cross.
      for (const isl of world.islands) {
        for (let i = 0; i < n; i++) {
          const town = isl.townBlend(points[i][0], points[i][1], 70);
          h[i] = lerp(h[i], town.h, town.w);
        }
      }
      const startJ = this._snap(points[0]);
      const endJ = this._snap(points[n - 1]);
      for (let i = 0; i < n; i++) {
        if (startJ) h[i] = lerp(startJ.road.heights[startJ.at], h[i], smoothstep(0, 25, i));
        if (endJ) h[i] = lerp(endJ.road.heights[endJ.at], h[i], smoothstep(0, 25, n - 1 - i));
      }
      limitGrade(h, false, 0.085, new Set([0, n - 1]));
      // Bridges keep their deck height over the water itself.
      for (let i = 0; i < n; i++) if (bridge[i]) h[i] = Math.max(h[i], deck * 0.6);
      const road = this._add({ id: c.id, island: c.island ?? null, closed: false, points, heights: h, bridge, drive: c.drive, style: c.bridge ?? null, from: c.from, to: c.to });
      if (startJ) this.junctions.push({ road, end: 0, other: startJ.road, at: startJ.at });
      if (endJ) this.junctions.push({ road, end: n - 1, other: endJ.road, at: endJ.at });
    }

    // Places where two roads cross (e.g. an avenue across a main street).
    // Samples go in a coarse grid so only nearby pairs are compared.
    const CELL = 8;
    const grid = new Map();
    const key = (gx, gz) => (gx + 2000) * 5000 + (gz + 2000);
    for (const r of this.roads) {
      r.points.forEach(([x, z], i) => {
        const k = key(Math.floor(x / CELL), Math.floor(z / CELL));
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push([r, i]);
      });
    }
    this.crossings = [];
    const endsNear = (x, z) => this.junctions.some((jn) => Math.hypot(jn.road.points[jn.end][0] - x, jn.road.points[jn.end][1] - z) < 20);
    for (const A of this.roads) {
      for (let i = 0; i < A.count; i++) {
        const [x, z] = A.points[i];
        const gx = Math.floor(x / CELL);
        const gz = Math.floor(z / CELL);
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            for (const [B, j] of grid.get(key(gx + dx, gz + dz)) ?? []) {
              if (B.index <= A.index) continue;
              const d = Math.hypot(B.points[j][0] - x, B.points[j][1] - z);
              if (d > 2.2 || Math.abs(A.heights[i] - B.heights[j]) > 1.5) continue;
              if (this.crossings.some((c) => Math.hypot(c.x - x, c.z - z) < 30) || endsNear(x, z)) continue;
              this.crossings.push({ a: A, i, b: B, j, x, z });
            }
          }
        }
      }
    }
    // Every spot where roads meet, for leaving gaps in barriers and paint.
    this.meetingPoints = [
      ...this.junctions.map((j) => ({ x: j.road.points[j.end][0], z: j.road.points[j.end][1] })),
      ...this.crossings.map((c) => ({ x: c.x, z: c.z })),
    ];
  }

  // Nearest sample on any road built so far, if one is within 30 m.
  _snap(p) {
    let best = null;
    for (const road of this.roads) {
      const at = this._nearestOn(road, p);
      const d = Math.hypot(road.points[at][0] - p[0], road.points[at][1] - p[1]);
      if (d < 30 && (!best || d < best.d)) best = { road, at, d };
    }
    return best;
  }

  isNearMeeting(x, z, r) {
    return this.meetingPoints.some((m) => Math.abs(m.x - x) < r && Math.abs(m.z - z) < r && Math.hypot(m.x - x, m.z - z) < r);
  }

  _add(r) {
    r.count = r.points.length;
    r.tangents = tangentsOf(r.points, r.closed);
    r.length = r.count * ROAD_SAMPLE_STEP;
    r.index = this.roads.length;
    this.roads.push(r);
    return r;
  }

  // Index of the nearest sample of `road` to a point. With `within`, returns
  // -1 unless the road's bounding box comes within that distance.
  _nearestOn(road, [x, z], within) {
    if (within !== undefined) {
      if (!road.box) {
        road.box = [Infinity, Infinity, -Infinity, -Infinity];
        for (const [px, pz] of road.points) {
          road.box[0] = Math.min(road.box[0], px);
          road.box[1] = Math.min(road.box[1], pz);
          road.box[2] = Math.max(road.box[2], px);
          road.box[3] = Math.max(road.box[3], pz);
        }
      }
      const b = road.box;
      if (x < b[0] - within || x > b[2] + within || z < b[1] - within || z > b[3] + within) return -1;
    }
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < road.count; i++) {
      const d = (road.points[i][0] - x) ** 2 + (road.points[i][1] - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  // Nearest road sample to a point: { road, index, dist }.
  nearest(x, z) {
    let best = null;
    for (const r of this.roads) {
      for (let i = 0; i < r.count; i += 4) {
        const d = (r.points[i][0] - x) ** 2 + (r.points[i][1] - z) ** 2;
        if (!best || d < best.d) best = { road: r, index: i, d };
      }
    }
    // Refine around the coarse hit.
    const r = best.road;
    for (let k = -4; k <= 4; k++) {
      const i = r.closed ? (best.index + k + r.count) % r.count : clamp(best.index + k, 0, r.count - 1);
      const d = (r.points[i][0] - x) ** 2 + (r.points[i][1] - z) ** 2;
      if (d < best.d) best = { road: r, index: i, d };
    }
    return { road: best.road, index: best.index, dist: Math.sqrt(best.d) };
  }
}
