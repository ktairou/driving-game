import { ISLANDS, ROAD_HALF_WIDTH, SEA_LEVEL } from "./layout.js";
import { Island, SEA_FLOOR } from "./islands.js";
import { RoadNetwork } from "./network.js";

const DECK_CELL = 24;
const deckKey = (gx, gz) => (gx + 1000) * 4000 + (gz + 1000);

// The whole world: the islands, the sea between them, the roads and bridges.
// Everything that needs "how high is the ground here?" asks this.
export class World {
  constructor() {
    this.islands = ISLANDS.map((d) => new Island(d));
    this.network = new RoadNetwork(this);
    for (const isl of this.islands) isl.buildGrid(this.network);
    this._indexBridges();
    this.slabs = []; // raised flat areas such as pavements, added by the towns
  }

  // Places kept free of trees and rocks (fuel stations).
  isClear(x, z) {
    return !this.clearAreas?.some((a) => Math.abs(x - a.x) < a.r && Math.abs(z - a.z) < a.r && Math.hypot(x - a.x, z - a.z) < a.r);
  }

  // A raised flat area (a pavement): its top counts as the ground.
  addSlab(x0, x1, z0, z1, top) {
    this.slabs.push({ x0, x1, z0, z1, top });
  }

  islandById(id) {
    return this.islands.find((i) => i.def.id === id);
  }

  islandAt(x, z) {
    for (const i of this.islands) if (i.contains(x, z)) return i;
    return null;
  }

  // Natural ground, before roads (used while planning the roads).
  baseHeight(x, z) {
    const i = this.islandAt(x, z);
    return i ? i.baseHeight(x, z) : SEA_FLOOR;
  }

  // Bridge decks, in a coarse grid for quick lookups.
  _indexBridges() {
    this.decks = new Map();
    for (const r of this.network.roads) {
      for (let i = 0; i + 1 < r.count; i++) {
        if (!r.bridge[i] && !r.bridge[i + 1]) continue;
        const a = r.points[i];
        const seg = { a, b: r.points[i + 1], ha: r.heights[i], hb: r.heights[i + 1] };
        const k = deckKey(Math.floor(a[0] / DECK_CELL), Math.floor(a[1] / DECK_CELL));
        if (!this.decks.has(k)) this.decks.set(k, []);
        this.decks.get(k).push(seg);
      }
    }
  }

  // Height of a bridge deck under (x, z), or null when not on one.
  deckHeight(x, z) {
    const gx = Math.floor(x / DECK_CELL);
    const gz = Math.floor(z / DECK_CELL);
    let best = null;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = this.decks.get(deckKey(gx + dx, gz + dz));
        if (!list) continue;
        for (const s of list) {
          const abx = s.b[0] - s.a[0];
          const abz = s.b[1] - s.a[1];
          const len2 = abx * abx + abz * abz || 1e-6;
          let t = ((x - s.a[0]) * abx + (z - s.a[1]) * abz) / len2;
          if (t < -0.05 || t > 1.05) continue;
          t = Math.min(1, Math.max(0, t));
          const d = Math.hypot(x - (s.a[0] + abx * t), z - (s.a[1] + abz * t));
          if (d <= ROAD_HALF_WIDTH + 0.6) {
            const h = s.ha + (s.hb - s.ha) * t;
            if (best === null || h > best) best = h;
          }
        }
      }
    }
    return best;
  }

  // Ground height (roads and bridges included) at any point.
  getHeight(x, z) {
    const i = this.islandAt(x, z);
    const h = i ? i.getHeight(x, z) : SEA_FLOOR;
    const deck = this.deckHeight(x, z);
    let top = deck !== null && deck > h ? deck : h;
    for (const s of this.slabs) {
      if (x >= s.x0 && x <= s.x1 && z >= s.z0 && z <= s.z1 && s.top > top) top = s.top;
    }
    return top;
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

  getRoadDistance(x, z) {
    const i = this.islandAt(x, z);
    return i ? i.getRoadDistance(x, z) : 1e6;
  }

  isWater(x, z, y) {
    return y < SEA_LEVEL - 0.4 && this.getHeight(x, z) < SEA_LEVEL;
  }
}
