import { createNoise2D, fbm, smoothstep, lerp, clamp } from "../noise.js";
import { ROAD_HALF_WIDTH } from "./layout.js";

const CELL = 2; // physics height grid spacing in metres
const ROAD_BLEND = 34; // width of the cut / fill slope beside the road
const SEA_FLOOR = -24;

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
    // Flat ground under landmarks, at whatever height the land is there.
    this.plateaus = def.landmarks.map((lm) => ({
      x: lm.x,
      z: lm.z,
      r: (lm.base ?? 40) * 0.75 + 25,
      h: Math.max(4, this._natural(lm.x, lm.z)),
    }));
  }

  contains(x, z) {
    return x >= this.minX && z >= this.minZ && x <= this.minX + 2 * this.def.half && z <= this.minZ + 2 * this.def.half;
  }

  townWeight(x, z, margin) {
    const t = this.def.town;
    const dx = Math.max(Math.abs(x - t.cx) - t.hx, 0);
    const dz = Math.max(Math.abs(z - t.cz) - t.hz, 0);
    return 1 - smoothstep(0, margin, Math.hypot(dx, dz));
  }

  // Land shape before towns, landmarks and roads.
  _natural(x, z) {
    const d = this.def;
    const lx = x - d.cx;
    const lz = z - d.cz;
    let land;
    if (d.climate === "desert") {
      // Long sand dunes on a gently rolling plain.
      const dune = 1 - Math.abs(this.noiseB((x + z * 0.4) / 110, (z - x * 0.2) / 260));
      land = 7 + fbm(this.noiseA, x / 700, z / 700, 4) * 14 * d.relief + dune * dune * 9;
    } else {
      land = 10 + fbm(this.noiseA, x / 650, z / 650, 5) * 42 * d.relief;
      const r = 1 - Math.abs(this.noiseB(x / 380, z / 380));
      land += r * r * 22 * d.relief;
      land += fbm(this.noiseC, x / 120 + 31.7, z / 120 - 11.3, 3) * 5;
    }
    // No inland lakes: keep land above the water away from the shore.
    land = Math.max(land, 3.5 + fbm(this.noiseC, x / 90, z / 90, 2) * 1.5);
    // Shoreline: land eases down to a beach, then drops to the sea floor.
    const reach = Math.max(Math.abs(lx), Math.abs(lz)) * 0.55 + Math.hypot(lx, lz) * 0.45 + fbm(this.noiseB, x / 320, z / 320, 3) * 70;
    land = lerp(land, 2.5, smoothstep(d.coast - 320, d.coast - 120, reach));
    return lerp(land, SEA_FLOOR, smoothstep(d.coast - 120, d.coast + 40, reach));
  }

  baseHeight(x, z) {
    let h = this._natural(x, z);
    for (const p of this.plateaus) h = lerp(p.h, h, smoothstep(p.r, p.r + 50, Math.hypot(x - p.x, z - p.z)));
    return lerp(h, this.def.town.height, this.townWeight(x, z, 90));
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
