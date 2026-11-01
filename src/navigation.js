import { clamp } from "./noise.js";
import { inTown } from "./world/road.js";
import { LANE_OFFSET, ROAD_SAMPLE_STEP } from "./world/layout.js";

// Route finding over the road network (every road sample is a node) and a
// simple "chauffeur" that drives the player's car along a route.

class MinHeap {
  constructor() {
    this.items = [];
  }
  push(node, cost) {
    const a = this.items;
    a.push([cost, node]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  get size() {
    return this.items.length;
  }
}

export class Navigator {
  constructor(world) {
    this.world = world;
    const roads = world.network.roads;
    this.offset = [];
    let total = 0;
    for (const r of roads) {
      this.offset.push(total);
      total += r.count;
    }
    this.total = total;
    this.adj = Array.from({ length: total }, () => []);
    const link = (a, b, cost) => {
      this.adj[a].push([b, cost]);
      this.adj[b].push([a, cost]);
    };
    for (const r of roads) {
      const o = this.offset[r.index];
      for (let i = 0; i + 1 < r.count; i++) link(o + i, o + i + 1, ROAD_SAMPLE_STEP);
      if (r.closed) link(o + r.count - 1, o, ROAD_SAMPLE_STEP);
    }
    for (const j of world.network.junctions) link(this.offset[j.road.index] + j.end, this.offset[j.other.index] + j.at, 1);
    for (const c of world.network.crossings) link(this.offset[c.a.index] + c.i, this.offset[c.b.index] + c.j, 1);
  }

  _node(x, z) {
    const { road, index } = this.world.network.nearest(x, z);
    return this.offset[road.index] + index;
  }

  _point(node) {
    let ri = 0;
    while (ri + 1 < this.offset.length && this.offset[ri + 1] <= node) ri++;
    const road = this.world.network.roads[ri];
    const i = node - this.offset[ri];
    return { x: road.points[i][0], z: road.points[i][1], y: road.heights[i] };
  }

  // Shortest drive between two points, as a list of road points.
  route(fx, fz, tx, tz) {
    const start = this._node(fx, fz);
    const goal = this._node(tx, tz);
    const dist = new Float64Array(this.total).fill(Infinity);
    const prev = new Int32Array(this.total).fill(-1);
    const heap = new MinHeap();
    dist[start] = 0;
    heap.push(start, 0);
    while (heap.size) {
      const [d, u] = heap.pop();
      if (u === goal) break;
      if (d > dist[u]) continue;
      for (const [v, w] of this.adj[u]) {
        const nd = d + w;
        if (nd < dist[v]) {
          dist[v] = nd;
          prev[v] = u;
          heap.push(v, nd);
        }
      }
    }
    if (!isFinite(dist[goal])) return null;
    const nodes = [];
    for (let u = goal; u !== -1; u = prev[u]) nodes.push(u);
    nodes.reverse();
    const points = nodes.map((n) => this._point(n));
    // Round off sharp corners (e.g. turning onto a bridge road) so the
    // car follows a curve instead of a right angle.
    for (let pass = 0; pass < 3; pass++) {
      const src = points.map((p) => ({ ...p }));
      for (let i = 3; i < points.length - 3; i++) {
        let sx = 0;
        let sz = 0;
        for (let k = -3; k <= 3; k++) {
          sx += src[i + k].x;
          sz += src[i + k].z;
        }
        points[i].x = sx / 7;
        points[i].z = sz / 7;
      }
    }
    return { points, length: dist[goal] };
  }
}

// Drives along a route: steers toward a point a little way ahead (in the
// correct lane for the country), keeps to a sensible speed, and stops at the end.
export class AutoDriver {
  constructor(world, navigator) {
    this.world = world;
    this.navigator = navigator;
    this.route = null;
    this.progress = 0;
    this.arrived = false;
  }

  start(route) {
    this.route = route;
    this.progress = 0;
    this.arrived = false;
  }

  stop() {
    this.route = null;
  }

  get active() {
    return !!this.route;
  }

  remaining(v) {
    if (!this.route) return 0;
    const pts = this.route.points;
    const end = pts[pts.length - 1];
    return Math.max(Math.hypot(end.x - v.x, end.z - v.z), (pts.length - 1 - this.progress) * ROAD_SAMPLE_STEP);
  }

  // Returns the controls to apply this frame.
  drive(v, traffic) {
    const pts = this.route.points;
    const n = pts.length;
    // Move the progress marker forward to the closest point.
    let best = this.progress;
    let bestD = Infinity;
    for (let i = this.progress; i < Math.min(n, this.progress + 40); i++) {
      const d = (pts[i].x - v.x) ** 2 + (pts[i].z - v.z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    this.progress = best;
    // Knocked well off the route (a crash, say): work out a new one from here.
    if (bestD > 25 * 25 && this.navigator) {
      const end = pts[n - 1];
      const fresh = this.navigator.route(v.x, v.z, end.x, end.z);
      if (fresh) {
        this.start(fresh);
        return this.drive(v, traffic);
      }
    }

    const speed = v.speed;
    const look = Math.round((7 + speed * 0.8) / ROAD_SAMPLE_STEP);
    const ti = Math.min(n - 1, best + look);
    const a = pts[Math.max(0, ti - 1)];
    const b = pts[ti];
    let dx = b.x - a.x;
    let dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    const island = this.world.islandAt(b.x, b.z);
    const lane = island && island.def.drive === "left" ? -LANE_OFFSET : LANE_OFFSET;
    const tx = b.x + dz * lane;
    const tz = b.z - dx * lane;
    let err = Math.atan2(tx - v.x, tz - v.z) - v.heading;
    while (err > Math.PI) err -= 2 * Math.PI;
    while (err < -Math.PI) err += 2 * Math.PI;

    // Speed: slower in towns, and slow enough for every bend coming up
    // (each bend's safe speed, plus room to brake down to it).
    let target = inTown(v.x, v.z, 15) ? 11 : 24;
    const heading = (i) => Math.atan2(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
    for (let k = best + 1; k < Math.min(n - 2, best + 40); k++) {
      let turn = Math.abs(heading(k) - heading(k - 1));
      if (turn > Math.PI) turn = 2 * Math.PI - turn;
      if (turn < 0.01) continue;
      const radius = ROAD_SAMPLE_STEP / turn;
      const safe = Math.sqrt(4.5 * radius);
      const dist = (k - best) * ROAD_SAMPLE_STEP;
      target = Math.min(target, Math.sqrt(safe * safe + 2 * 4 * dist));
    }
    const left = (n - 1 - best) * ROAD_SAMPLE_STEP;
    target = Math.min(target, Math.sqrt(2 * 3.2 * Math.max(0, left - 6)));
    // Don't run into a car going the same way in front. (Cars crossing or
    // coming the other way are ignored, or two drivers could wait for each other.)
    if (traffic) {
      const fx = Math.sin(v.heading);
      const fz = Math.cos(v.heading);
      for (const c of traffic.cars) {
        const rx = c.x - v.x;
        const rz = c.z - v.z;
        const along = rx * fx + rz * fz;
        const sameWay = !c.moving || Math.sin(c.yaw) * fx + Math.cos(c.yaw) * fz > 0.5;
        if (sameWay && along > 0 && along < 30 && Math.abs(rx * fz - rz * fx) < 1.5) target = Math.min(target, Math.max(0, (along - 8) * 0.7));
      }
    }

    if (left < 8 && speed < 1) {
      this.arrived = true;
      this.route = null;
      // Handbrake, not the brake pedal: the pedal would start reversing.
      return { steer: 0, throttle: 0, brake: 0, handbrake: true, steerAnalog: true };
    }
    const throttle = speed < target - 0.4 ? clamp((target - speed) / 4, 0.25, 1) : 0;
    const brake = speed > target + 1.2 ? clamp((speed - target) / 5, 0.15, 1) : 0;
    return { steer: clamp(err * 2.2, -1, 1), throttle, brake, handbrake: false, steerAnalog: true };
  }
}
