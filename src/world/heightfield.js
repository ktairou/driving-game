import { createNoise2D, fbm, smoothstep, lerp, clamp } from "../noise.js";
import { WORLD_HALF, ROAD_POINTS, ROAD_HALF_WIDTH, ROAD_SAMPLE_STEP, TOWN } from "./layout.js";

const CELL = 2; // physics height grid spacing in metres
const ROAD_BLEND = 34; // width of the cut / fill slope beside the road

// Centripetal Catmull-Rom through a closed list of 2D points, resampled so
// consecutive samples are `step` metres apart.
function buildRoadCurve(points, step) {
  const n = points.length;
  const dense = [];
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];
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
  // Resample by arc length.
  const samples = [];
  let carry = 0;
  samples.push(dense[0]);
  for (let i = 0; i < dense.length; i++) {
    const a = dense[i];
    const b = dense[(i + 1) % dense.length];
    let segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let along = step - carry;
    while (along <= segLen) {
      const t = along / segLen;
      samples.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      along += step;
    }
    carry = segLen - (along - step);
  }
  // Drop a final sample that lands on top of the first one.
  const last = samples[samples.length - 1];
  if (Math.hypot(last[0] - samples[0][0], last[1] - samples[0][1]) < step * 0.5) samples.pop();
  return samples;
}

function townWeight(x, z, margin) {
  const dx = Math.max(Math.abs(x - TOWN.cx) - TOWN.hx, 0);
  const dz = Math.max(Math.abs(z - TOWN.cz) - TOWN.hz, 0);
  return 1 - smoothstep(0, margin, Math.hypot(dx, dz));
}

export class Heightfield {
  constructor(seed = 7) {
    this.noiseA = createNoise2D(seed);
    this.noiseB = createNoise2D(seed + 11);
    this.noiseC = createNoise2D(seed + 23);
    this.half = WORLD_HALF;
    this.cell = CELL;
    this.size = Math.round((2 * WORLD_HALF) / CELL) + 1;

    this._buildRoad();
    this._buildGrid();
  }

  // Natural ground before the road is carved in.
  baseHeight(x, z) {
    let h = fbm(this.noiseA, x / 650, z / 650, 5) * 50;
    const r = 1 - Math.abs(this.noiseB(x / 380, z / 380));
    h += r * r * 22;
    h += fbm(this.noiseC, x / 120 + 31.7, z / 120 - 11.3, 3) * 5;
    const edge = smoothstep(590, 790, Math.max(Math.abs(x), Math.abs(z)));
    h += edge * edge * 190;
    return lerp(h, TOWN.height, townWeight(x, z, 90));
  }

  _buildRoad() {
    const pts = buildRoadCurve(ROAD_POINTS, ROAD_SAMPLE_STEP);
    const n = pts.length;
    const raw = pts.map(([x, z]) => this.baseHeight(x, z));

    // Smooth the road's height so it rolls instead of following every bump.
    let h = raw.slice();
    const radius = 22;
    for (let pass = 0; pass < 4; pass++) {
      const next = new Array(n);
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += h[(k + n) % n];
      for (let i = 0; i < n; i++) {
        next[i] = sum / (2 * radius + 1);
        sum += h[(i + radius + 1) % n] - h[(i - radius + n) % n];
      }
      h = next;
    }
    // Flat through town.
    for (let i = 0; i < n; i++) h[i] = lerp(h[i], TOWN.height, townWeight(pts[i][0], pts[i][1], 70));
    // Keep slopes drivable: at most 9 % grade.
    const maxRise = 0.09 * ROAD_SAMPLE_STEP;
    for (let pass = 0; pass < 6; pass++) {
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        h[j] = clamp(h[j], h[i] - maxRise, h[i] + maxRise);
      }
      for (let i = n - 1; i >= 0; i--) {
        const j = (i - 1 + n) % n;
        h[j] = clamp(h[j], h[i] - maxRise, h[i] + maxRise);
      }
    }

    const tangents = pts.map((p, i) => {
      const a = pts[(i - 1 + n) % n];
      const b = pts[(i + 1) % n];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const l = Math.hypot(dx, dz) || 1;
      return [dx / l, dz / l];
    });

    this.road = { points: pts, heights: h, tangents, count: n, length: n * ROAD_SAMPLE_STEP };
  }

  _buildGrid() {
    const { size, cell, half } = this;
    const count = size * size;
    const heights = new Float32Array(count);
    const roadDist = new Float32Array(count).fill(1e6);
    const roadH = new Float32Array(count);

    // Splat each road segment into the cells near it.
    const { points, heights: rh, count: n } = this.road;
    const reach = ROAD_HALF_WIDTH + ROAD_BLEND + 4;
    for (let i = 0; i < n; i++) {
      const a = points[i];
      const b = points[(i + 1) % n];
      const ha = rh[i];
      const hb = rh[(i + 1) % n];
      const minX = Math.min(a[0], b[0]) - reach;
      const maxX = Math.max(a[0], b[0]) + reach;
      const minZ = Math.min(a[1], b[1]) - reach;
      const maxZ = Math.max(a[1], b[1]) + reach;
      const gx0 = Math.max(0, Math.floor((minX + half) / cell));
      const gx1 = Math.min(size - 1, Math.ceil((maxX + half) / cell));
      const gz0 = Math.max(0, Math.floor((minZ + half) / cell));
      const gz1 = Math.min(size - 1, Math.ceil((maxZ + half) / cell));
      const abx = b[0] - a[0];
      const abz = b[1] - a[1];
      const abLen2 = abx * abx + abz * abz || 1e-6;
      for (let gz = gz0; gz <= gz1; gz++) {
        const z = gz * cell - half;
        for (let gx = gx0; gx <= gx1; gx++) {
          const x = gx * cell - half;
          const t = clamp(((x - a[0]) * abx + (z - a[1]) * abz) / abLen2, 0, 1);
          const px = a[0] + abx * t;
          const pz = a[1] + abz * t;
          const d = Math.hypot(x - px, z - pz);
          const idx = gz * size + gx;
          if (d < roadDist[idx]) {
            roadDist[idx] = d;
            roadH[idx] = ha + (hb - ha) * t;
          }
        }
      }
    }

    for (let gz = 0; gz < size; gz++) {
      const z = gz * cell - half;
      for (let gx = 0; gx < size; gx++) {
        const x = gx * cell - half;
        const idx = gz * size + gx;
        const base = this.baseHeight(x, z);
        const d = roadDist[idx];
        if (d < reach) {
          const w = smoothstep(ROAD_HALF_WIDTH + 1, ROAD_HALF_WIDTH + 1 + ROAD_BLEND, d);
          heights[idx] = lerp(roadH[idx], base, w);
        } else {
          heights[idx] = base;
        }
      }
    }

    this.heights = heights;
    this.roadDist = roadDist;
  }

  _index(x, z) {
    const fx = clamp((x + this.half) / this.cell, 0, this.size - 1.001);
    const fz = clamp((z + this.half) / this.cell, 0, this.size - 1.001);
    return [fx, fz];
  }

  // Ground height (road included) at any point.
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

  getNormal(x, z, e = 1.5) {
    const hl = this.getHeight(x - e, z);
    const hr = this.getHeight(x + e, z);
    const hd = this.getHeight(x, z - e);
    const hu = this.getHeight(x, z + e);
    const nx = hl - hr;
    const nz = hd - hu;
    const ny = 2 * e;
    const l = Math.hypot(nx, ny, nz);
    return [nx / l, ny / l, nz / l];
  }

  // Approximate distance to the road centre line (nearest grid cell).
  getRoadDistance(x, z) {
    const [fx, fz] = this._index(x, z);
    return this.roadDist[Math.round(fz) * this.size + Math.round(fx)];
  }

  nearestRoadSample(x, z) {
    const { points } = this.road;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = (points[i][0] - x) ** 2 + (points[i][1] - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }
}
