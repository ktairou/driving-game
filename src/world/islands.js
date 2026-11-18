import { createNoise2D, fbm, smoothstep, lerp, clamp } from "../noise.js";
import { ISLANDS, EXTRA_ROADS, CONNECTORS, COUNTRY_ROADS, DRAG_STRIPS, DRAG_STRIP, ROAD_HALF_WIDTH } from "./layout.js";
import { buildCurve } from "./network.js";

const CELL = 2; // physics height grid spacing in metres
const ROAD_BLEND = 34; // width of the cut / fill slope beside the road
const SEA_FLOOR = -24;

// Crags and sea cliffs change the land shape, so they are kept away from
// everything placed against it. KEEP is how close they may come (metres) to a
// town, landmark (and the hill it stands on) or drag strip; roads get
// ROAD_PAD more, because fuel stations and their levelled ground reach that far
// back from the road and are planned only after the land exists.
const KEEP = 150;
const ROAD_PAD = 45;
// The country roads have no fuel stations, so the crags may come nearer to
// them (from about 140 m away rather than 240 m): they keep their hills.
const COUNTRY_PAD = -60;
const KEEP_CELL = 10; // the distance grid behind that test
// The grid's distances run slightly long (up to 8.3 % across diagonals, plus
// a cell or so from sampling it), so changes start a safe margin further
// out, and fade in over the next FADE metres.
const KEEP_START = KEEP * 1.083 + 3.5 * KEEP_CELL;
const FADE = 110;

// Points every 4 m along every road in the layout (shared by all the
// islands), and along the country roads.
let roadPoints = null;
let countryPoints = null;
function roadSamples() {
  roadPoints ??= [
    ...ISLANDS.map((isl) => buildCurve(isl.road, 4, true)),
    ...EXTRA_ROADS.map((r) => buildCurve(r.points, 4, false)),
    ...CONNECTORS.map((c) => buildCurve(c.points, 4, false)),
  ].flat();
  return roadPoints;
}
function countrySamples() {
  countryPoints ??= COUNTRY_ROADS.flatMap((r) => buildCurve(r.points, 4, false));
  return countryPoints;
}

// One country: its natural ground shape, plus a height grid with the roads
// carved in, used for both drawing and driving.
export class Island {
  constructor(def) {
    this.def = def;
    this.noiseA = createNoise2D(def.seed);
    this.noiseB = createNoise2D(def.seed + 11);
    this.noiseC = createNoise2D(def.seed + 23);
    this.minX = def.cx - def.half;
    this.minZ = def.cz - def.half;
    this.size = Math.round((2 * def.half) / CELL) + 1;
    this.cell = CELL;
    this.noiseD = createNoise2D(def.seed + 37);
    // (Before anything below asks for the natural height.)
    this._buildKeepOut();
    // Flat ground under landmarks, at whatever height the land is there.
    this.plateaus = def.landmarks.filter((lm) => lm.plateau !== false).map((lm) => ({
      x: lm.x,
      z: lm.z,
      r: (lm.base ?? 40) * 0.75 + 25,
      h: Math.max(4, this._natural(lm.x, lm.z)),
    }));
    // Extra hills some landmarks stand on (the Hollywood sign), centred dz metres south of them.
    this.hills = def.landmarks.filter((lm) => lm.hill).map((lm) => ({ x: lm.x, z: lm.z + (lm.hill.dz ?? 0), r: lm.hill.r, h: lm.hill.h }));
    // Each town sits on flat ground at about the height the land has there.
    for (const t of def.towns) {
      if (t.height !== undefined) continue;
      let sum = 0;
      let n = 0;
      for (let i = 0; i <= 6; i++) {
        for (let j = 0; j <= 4; j++) {
          sum += this._natural(t.cx + (i / 6 - 0.5) * 2 * t.hx, t.cz + (j / 4 - 0.5) * 2 * t.hz);
          n++;
        }
      }
      t.height = Math.max(4, sum / n);
    }
  }

  contains(x, z) {
    return x >= this.minX && z >= this.minZ && x <= this.minX + 2 * this.def.half && z <= this.minZ + 2 * this.def.half;
  }

  // How much (0..1) a point belongs to a town's flat ground, and that town's height.
  townBlend(x, z, margin) {
    let w = 0;
    let h = 0;
    for (const t of this.def.towns) {
      const dx = Math.max(Math.abs(x - t.cx) - t.hx, 0);
      const dz = Math.max(Math.abs(z - t.cz) - t.hz, 0);
      const tw = 1 - smoothstep(0, margin, Math.hypot(dx, dz));
      if (tw > w) {
        w = tw;
        h = t.height;
      }
    }
    return { w, h };
  }

  townWeight(x, z, margin) {
    return this.townBlend(x, z, margin).w;
  }

  // A coarse grid of the distance to the nearest thing the land must not move
  // under (see KEEP above), from the layout alone: the roads aren't built yet.
  // Distances are filled in exactly near each thing, then spread outwards
  // (a two-pass chamfer sweep).
  _buildKeepOut() {
    const n = Math.ceil((2 * this.def.half) / KEEP_CELL) + 1;
    const dist = new Float32Array(n * n).fill(1e6);
    const { minX, minZ } = this;
    // Every cell within `reach` of (x, z) gets `f(cellX, cellZ)` if that's nearer.
    const near = (x, z, reach, f) => {
      const i0 = Math.max(0, Math.floor((x - reach - minX) / KEEP_CELL));
      const i1 = Math.min(n - 1, Math.ceil((x + reach - minX) / KEEP_CELL));
      const j0 = Math.max(0, Math.floor((z - reach - minZ) / KEEP_CELL));
      const j1 = Math.min(n - 1, Math.ceil((z + reach - minZ) / KEEP_CELL));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const k = j * n + i;
          const v = f(minX + i * KEEP_CELL, minZ + j * KEEP_CELL);
          if (v < dist[k]) dist[k] = v;
        }
      }
    };
    const point = (px, pz, pad, reach = 3 * KEEP_CELL) => near(px, pz, reach, (x, z) => Math.hypot(x - px, z - pz) - pad);
    // Roads (every country's: the bridges reach across), padded for fuel stations.
    for (const [x, z] of roadSamples()) if (this._nearGrid(x, z, 3 * KEEP_CELL)) point(x, z, ROAD_PAD);
    for (const [x, z] of countrySamples()) if (this._nearGrid(x, z, 3 * KEEP_CELL)) point(x, z, COUNTRY_PAD);
    // Towns (their parks reach a little beyond, but stay well inside the main street's padding).
    for (const t of this.def.towns) {
      near(t.cx, t.cz, Math.max(t.hx, t.hz) + 3 * KEEP_CELL, (x, z) => Math.hypot(Math.max(Math.abs(x - t.cx) - t.hx, 0), Math.max(Math.abs(z - t.cz) - t.hz, 0)));
    }
    // Landmarks (sea ones included) and the hills some stand on.
    for (const lm of this.def.landmarks) {
      const r = (lm.base ?? 30) / 2;
      point(lm.x, lm.z, r, r + 3 * KEEP_CELL);
      if (lm.hill) point(lm.x, lm.z + (lm.hill.dz ?? 0), lm.hill.r, lm.hill.r + 3 * KEEP_CELL);
    }
    // Drag strips: their whole length and levelled apron (barriers, grandstand,
    // flags), and their link roads, padded like the other roads.
    for (const s of DRAG_STRIPS) {
      const pad = DRAG_STRIP.apron + 8;
      for (let u = -10; u <= (s.length ?? 702) + 10; u += 4) point(s.x + Math.sin(s.heading) * u, s.z + Math.cos(s.heading) * u, pad, pad + 3 * KEEP_CELL);
      if (s.link) for (const [x, z] of buildCurve(s.link, 4, false)) if (this._nearGrid(x, z, 3 * KEEP_CELL)) point(x, z, ROAD_PAD);
    }
    // Spread outwards: forward then backward over the grid.
    const D = KEEP_CELL * Math.SQRT2;
    const relax = (k, k2, w) => {
      if (dist[k2] + w < dist[k]) dist[k] = dist[k2] + w;
    };
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        if (i > 0) relax(k, k - 1, KEEP_CELL);
        if (j > 0) {
          relax(k, k - n, KEEP_CELL);
          if (i > 0) relax(k, k - n - 1, D);
          if (i < n - 1) relax(k, k - n + 1, D);
        }
      }
    }
    for (let j = n - 1; j >= 0; j--) {
      for (let i = n - 1; i >= 0; i--) {
        const k = j * n + i;
        if (i < n - 1) relax(k, k + 1, KEEP_CELL);
        if (j < n - 1) {
          relax(k, k + n, KEEP_CELL);
          if (i < n - 1) relax(k, k + n + 1, D);
          if (i > 0) relax(k, k + n - 1, D);
        }
      }
    }
    // Turned into how freely (0..1) the land may be reshaped, and how much of
    // a sea cliff each spot gets (a slow noise, so a coarse grid is plenty).
    const free = new Float32Array(n * n);
    const cliff = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        if (dist[k] <= KEEP_START) continue;
        free[k] = smoothstep(KEEP_START, KEEP_START + FADE, dist[k]);
        const x = minX + i * KEEP_CELL;
        const z = minZ + j * KEEP_CELL;
        cliff[k] = free[k] * smoothstep(0.12, 0.36, fbm(this.noiseD, x / 700 + 3.7, z / 700 - 1.9, 2));
      }
    }
    this.keepOut = { n, free, cliff };
  }

  _nearGrid(x, z, margin) {
    return x >= this.minX - margin && z >= this.minZ - margin && x <= this.minX + 2 * this.def.half + margin && z <= this.minZ + 2 * this.def.half + margin;
  }

  // One of the keep-out grids at (x, z), blended between its cells.
  _keepAt(grid, x, z) {
    const n = this.keepOut.n;
    const fx = clamp((x - this.minX) / KEEP_CELL, 0, n - 1.001);
    const fz = clamp((z - this.minZ) / KEEP_CELL, 0, n - 1.001);
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const k = j * n + i;
    return (grid[k] * (1 - tx) + grid[k + 1] * tx) * (1 - tz) + (grid[k + n] * (1 - tx) + grid[k + n + 1] * tx) * tz;
  }

  // How freely (0..1) the land may be reshaped here: 0 near anything built.
  _freedom(x, z) {
    return this._keepAt(this.keepOut.free, x, z);
  }

  // Desert dunes: 0 in the hollows, 1 on the crests (terrain.js shades by it too).
  dune(x, z) {
    const d = 1 - Math.abs(this.noiseB((x + z * 0.4) / 110, (z - x * 0.2) / 260));
    return d * d;
  }

  // Land shape before towns, landmarks and roads.
  _natural(x, z) {
    const d = this.def;
    const lx = x - d.cx;
    const lz = z - d.cz;
    let land;
    if (d.climate === "desert") {
      // Long sand dunes on a gently rolling plain.
      land = 7 + fbm(this.noiseA, x / 700, z / 700, 4) * 14 * d.relief + this.dune(x, z) * 9;
    } else {
      land = 10 + fbm(this.noiseA, x / 650, z / 650, 5) * 42 * d.relief;
      const r = 1 - Math.abs(this.noiseB(x / 380, z / 380));
      land += r * r * 22 * d.relief;
      land += fbm(this.noiseC, x / 120 + 31.7, z / 120 - 11.3, 3) * 5;
    }
    // How far out towards the sea this is (the coast is at about d.coast).
    const reach = Math.max(Math.abs(lx), Math.abs(lz)) * 0.55 + Math.hypot(lx, lz) * 0.45 + fbm(this.noiseB, x / 320, z / 320, 3) * 70;
    const coastal = reach > d.coast - 330 && reach < d.coast + 40;
    // (Only high ground and the coast get reshaped, so only they need asking.)
    const free = land > 24 || coastal ? this._freedom(x, z) : 0;
    // Craggy tops: ridged noise (sharp crests where the noise crosses zero)
    // on the high ground, away from anything built.
    if (free > 0 && land > 24) {
      const r1 = 1 - Math.abs(this.noiseD(x / 150, z / 150));
      const r2 = 1 - Math.abs(this.noiseD(x / 55 + 17.3, z / 55 - 8.1));
      land += (r1 * r1 * r1 * 15 + r2 * r2 * 5 - 5) * smoothstep(24, 40, land) * free;
    }
    // No inland lakes: keep land above the water away from the shore.
    land = Math.max(land, 3.5 + fbm(this.noiseC, x / 90, z / 90, 2) * 1.5);
    // Shoreline: land eases down to a beach, then drops to the sea floor.
    let shore = lerp(land, 2.5, smoothstep(d.coast - 320, d.coast - 120, reach));
    // Low sea cliffs on some stretches of coast: the land stays up almost to
    // the water, then drops straight in. The beach stays everywhere else.
    if (free > 0 && coastal) {
      const cliff = this._keepAt(this.keepOut.cliff, x, z);
      if (cliff > 0) {
        const top = Math.max(lerp(land, 9, smoothstep(d.coast - 330, d.coast - 150, reach) * 0.8), 7 + fbm(this.noiseC, x / 60, z / 60, 2) * 3);
        shore = lerp(shore, lerp(top, -4, smoothstep(d.coast - 142, d.coast - 122, reach)), cliff);
      }
    }
    return lerp(shore, SEA_FLOOR, smoothstep(d.coast - 120, d.coast + 40, reach));
  }

  baseHeight(x, z) {
    let h = this._natural(x, z);
    for (const k of this.hills) h += k.h * (1 - smoothstep(0, k.r, Math.hypot(x - k.x, z - k.z)));
    for (const p of this.plateaus) h = lerp(p.h, h, smoothstep(p.r, p.r + 50, Math.hypot(x - p.x, z - p.z)));
    const town = this.townBlend(x, z, 90);
    return lerp(h, town.h, town.w);
  }

  // Build the height grid, carving in every road (or road piece) on this island.
  buildGrid(network) {
    const { size, cell, minX, minZ } = this;
    const count = size * size;
    const heights = new Float32Array(count);
    const roadDist = new Float32Array(count).fill(1e6);
    const roadH = new Float32Array(count);
    const reach = ROAD_HALF_WIDTH + ROAD_BLEND + 4;
    const maxX = minX + (size - 1) * cell;
    const maxZ = minZ + (size - 1) * cell;

    for (const road of network.roads) {
      const { points, heights: rh, count: n, closed, bridge } = road;
      const segs = closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const j = (i + 1) % n;
        // Over water it is a bridge: it counts for distance (so trees keep
        // clear) but doesn't carve the ground.
        const deck = bridge[i] && bridge[j];
        const a = points[i];
        const b = points[j];
        const loX = Math.min(a[0], b[0]) - reach;
        const hiX = Math.max(a[0], b[0]) + reach;
        const loZ = Math.min(a[1], b[1]) - reach;
        const hiZ = Math.max(a[1], b[1]) + reach;
        if (hiX < minX || loX > maxX || hiZ < minZ || loZ > maxZ) continue;
        const gx0 = Math.max(0, Math.floor((loX - minX) / cell));
        const gx1 = Math.min(size - 1, Math.ceil((hiX - minX) / cell));
        const gz0 = Math.max(0, Math.floor((loZ - minZ) / cell));
        const gz1 = Math.min(size - 1, Math.ceil((hiZ - minZ) / cell));
        const abx = b[0] - a[0];
        const abz = b[1] - a[1];
        const abLen2 = abx * abx + abz * abz || 1e-6;
        const ha = rh[i];
        const hb = rh[j];
        for (let gz = gz0; gz <= gz1; gz++) {
          const z = minZ + gz * cell;
          for (let gx = gx0; gx <= gx1; gx++) {
            const x = minX + gx * cell;
            const t = clamp(((x - a[0]) * abx + (z - a[1]) * abz) / abLen2, 0, 1);
            const d = Math.hypot(x - (a[0] + abx * t), z - (a[1] + abz * t));
            const idx = gz * size + gx;
            if (d < roadDist[idx]) {
              roadDist[idx] = d;
              roadH[idx] = deck ? NaN : ha + (hb - ha) * t;
            }
          }
        }
      }
    }

    for (let gz = 0; gz < size; gz++) {
      const z = minZ + gz * cell;
      for (let gx = 0; gx < size; gx++) {
        const x = minX + gx * cell;
        const idx = gz * size + gx;
        const base = this.baseHeight(x, z);
        const d = roadDist[idx];
        heights[idx] = d < reach && !Number.isNaN(roadH[idx]) ? lerp(roadH[idx], base, smoothstep(ROAD_HALF_WIDTH + 1, ROAD_HALF_WIDTH + 1 + ROAD_BLEND, d)) : base;
      }
    }
    this.heights = heights;
    this.roadDist = roadDist;
  }

  _index(x, z) {
    const fx = clamp((x - this.minX) / this.cell, 0, this.size - 1.001);
    const fz = clamp((z - this.minZ) / this.cell, 0, this.size - 1.001);
    return [fx, fz];
  }

  getHeight(x, z) {
    const [fx, fz] = this._index(x, z);
    const gx = Math.floor(fx);
    const gz = Math.floor(fz);
    const tx = fx - gx;
    const tz = fz - gz;
    const s = this.size;
    const H = this.heights;
    const h00 = H[gz * s + gx];
    const h10 = H[gz * s + gx + 1];
    const h01 = H[(gz + 1) * s + gx];
    const h11 = H[(gz + 1) * s + gx + 1];
    return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz;
  }

  getRoadDistance(x, z) {
    const [fx, fz] = this._index(x, z);
    return this.roadDist[Math.round(fz) * this.size + Math.round(fx)];
  }
}

export { SEA_FLOOR };
