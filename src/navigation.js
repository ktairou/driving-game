import { clamp } from "./noise.js";
import { inTown } from "./world/road.js";
import { speedLimitAt } from "./world/trafficLights.js";
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
    // (Which side to drive on, for bridges between countries.)
    return { x: road.points[i][0], z: road.points[i][1], y: road.heights[i], drive: road.drive };
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
const HOLD = { steer: 0, steerAngle: 0, throttle: 0, brake: 0, reverse: 0, handbrake: true, steerAnalog: true };
const FULL_LOCK = 0.6;

// Drives the car along a route by itself. Normally it just follows the road;
// when it has to, it can also turn round in the road (a three-point turn) and
// back out of trouble after bumping into something.
export class AutoDriver {
  constructor(world, navigator) {
    this.world = world;
    this.navigator = navigator;
    this.colliders = null; // walls and posts to look out for (set by the game)
    this.route = null;
    this.progress = 0;
    this.arrived = false;
    this.mode = "drive";
  }

  start(route) {
    this.route = route;
    this.progress = 0;
    this.arrived = false;
    this.mode = "drive";
    this.stuck = 0;
    this.lastImpact = 0;
    this.passCar = null;
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

  // How far the car could move forwards (dir 1) or backwards (dir -1) before
  // touching a wall, post or other car, looking up to `max` metres.
  clearance(v, dir, max, traffic) {
    const fx = Math.sin(v.heading) * dir;
    const fz = Math.cos(v.heading) * dir;
    // The same circle the car uses for its own bumps, at that end of the car.
    const r = v.halfTrack * 0.98;
    const end = dir > 0 ? v.a - 0.15 : v.b - 0.1;
    for (let d = 0.25; d <= max; d += 0.5) {
      const x = v.x + fx * (end + d);
      const z = v.z + fz * (end + d);
      if (this.colliders?.resolveCircle(x, z, r)) return d - 0.25;
      if (traffic) for (const c of traffic.cars) if (Math.abs(c.x - x) < 3 && Math.abs(c.z - z) < 3 && Math.hypot(c.x - x, c.z - z) < r + 1.0) return d - 0.25;
    }
    return Infinity;
  }

  // Is there a parked car in our lane just ahead that we should go round
  // (and nothing coming the other way)? Keeps going round it until it's
  // well behind.
  _passing(v, traffic) {
    if (!traffic) return false;
    const fx = Math.sin(v.heading);
    const fz = Math.cos(v.heading);
    const rel = (c) => {
      const rx = c.x - v.x;
      const rz = c.z - v.z;
      return { along: rx * fx + rz * fz, side: rx * fz - rz * fx };
    };
    if (this.passCar) {
      if (!traffic.cars.includes(this.passCar) || rel(this.passCar).along < -9) this.passCar = null;
      else return true;
    }
    for (const c of traffic.cars) {
      if (c.moving) continue;
      const { along, side } = rel(c);
      if (along < 4 || along > 28 || Math.abs(side) > 1.6) continue;
      const oncoming = traffic.cars.some((o) => {
        if (!o.moving || Math.sin(o.yaw) * fx + Math.cos(o.yaw) * fz > -0.5) return false;
        const r = rel(o);
        return r.along > -5 && r.along < 80 && Math.abs(r.side) < 7;
      });
      if (!oncoming) this.passCar = c;
      return !oncoming;
    }
    return false;
  }

  _beginTurn(err) {
    this.mode = "turn";
    this.turnSide = err >= 0 ? 1 : -1;
    this.phase = "forward";
    this.modeTime = 0;
    this.phaseFrom = null;
    this.wedges = 0;
  }

  // Three-point turn: forwards on full lock towards where we need to go, then
  // backwards on the opposite lock, and again, until the car points the right way.
  _turn(v, err, dt, traffic) {
    this.modeTime += dt;
    if (!this.phaseFrom) this.phaseFrom = { x: v.x, z: v.z, still: 0 };
    const moved = Math.hypot(v.x - this.phaseFrom.x, v.z - this.phaseFrom.z);
    // Not getting anywhere (rubbing against something at the side): change direction.
    this.phaseFrom.still = Math.abs(v.forwardSpeed) < 0.3 ? this.phaseFrom.still + dt : 0;
    const wedged = this.phaseFrom.still > 1;
    if (Math.abs(err) < 0.45 || this.modeTime > 40) {
      this.mode = "drive";
      this.stuck = 0;
      return HOLD;
    }
    const side = this.turnSide;
    if (this.phase === "forward") {
      if (this.clearance(v, 1, 3, traffic) < 0.8 || moved > 9 || wedged) {
        // Keeps hitting something turning this way: go round the other way.
        if (wedged && moved < 1 && ++this.wedges >= 2) {
          this.turnSide = -this.turnSide;
          this.wedges = 0;
        }
        this.phase = "back";
        this.phaseFrom = { x: v.x, z: v.z, still: 0 };
      }
      return { steer: 0, steerAngle: side * FULL_LOCK, throttle: v.forwardSpeed < 2.5 ? 0.5 : 0, brake: 0, reverse: 0, handbrake: false, steerAnalog: true };
    }
    if (this.clearance(v, -1, 3, traffic) < 0.8 || moved > 7 || Math.abs(err) < 1.1 || wedged) {
      this.phase = "forward";
      this.phaseFrom = { x: v.x, z: v.z, still: 0 };
    }
    return { steer: 0, steerAngle: -side * FULL_LOCK, throttle: 0, brake: 0, reverse: v.forwardSpeed > -2.5 ? 0.6 : 0, handbrake: false, steerAnalog: true };
  }

  // Backs away from whatever we ran into, swinging the nose towards the road.
  _unstick(v, err, dt, traffic) {
    this.modeTime += dt;
    if (!this.phaseFrom) this.phaseFrom = { x: v.x, z: v.z, still: 0 };
    const moved = Math.hypot(v.x - this.phaseFrom.x, v.z - this.phaseFrom.z);
    this.phaseFrom.still = Math.abs(v.forwardSpeed) < 0.3 ? this.phaseFrom.still + dt : 0;
    if (this.modeTime > 2.6 || moved > 4.5 || this.clearance(v, -1, 2, traffic) < 0.5 || this.phaseFrom.still > 1.2) {
      this.stuck = 0;
      if (Math.abs(err) > 1.2) this._beginTurn(err);
      else this.mode = "drive";
      return HOLD;
    }
    return { steer: 0, steerAngle: -Math.sign(err) * FULL_LOCK * 0.8, throttle: 0, brake: 0, reverse: v.forwardSpeed > -2.5 ? 0.6 : 0, handbrake: false, steerAnalog: true };
  }

  // Returns the controls to apply this frame.
  drive(v, traffic, dt = 1 / 60, rerouted = false) {
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
    // (Only once per frame: far from any road, a fresh route starts just as far away.)
    if (bestD > 25 * 25 && this.navigator && !rerouted && this.mode === "drive") {
      const end = pts[n - 1];
      const fresh = this.navigator.route(v.x, v.z, end.x, end.z);
      if (fresh) {
        const keepMode = this.mode;
        this.start(fresh);
        this.mode = keepMode;
        return this.drive(v, traffic, dt, true);
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
    // In town, keep a little nearer the middle: cars are parked along the kerb.
    const offset = inTown(b.x, b.z, 10) ? LANE_OFFSET - 0.35 : LANE_OFFSET;
    const driveSide = island ? island.def.drive : (b.drive ?? "right");
    let lane = driveSide === "left" ? -offset : offset;
    // Overtaking a car parked in our lane: use the other side of the road.
    if (this._passing(v, traffic)) lane = -lane;
    const tx = b.x + dz * lane;
    const tz = b.z - dx * lane;
    let err = Math.atan2(tx - v.x, tz - v.z) - v.heading;
    while (err > Math.PI) err -= 2 * Math.PI;
    while (err < -Math.PI) err += 2 * Math.PI;

    // Manoeuvres: turning round, or backing out after a bump.
    if (v.impact > this.lastImpact + 0.2 && speed < 4) {
      this.mode = "unstick";
      this.modeTime = 0;
      this.phaseFrom = null;
    }
    this.lastImpact = v.impact;
    if (this.mode === "unstick") return this._unstick(v, err, dt, traffic);
    if (this.mode === "turn") return this._turn(v, err, dt, traffic);
    // Pointing the wrong way (say, parked facing the other way): turn round
    // in the road rather than trying to swing round in one go.
    if (Math.abs(err) > 1.75 && speed < 4) {
      if (speed > 0.6) return { ...HOLD, handbrake: false, brake: 1 };
      this._beginTurn(err);
      return this._turn(v, err, dt, traffic);
    }

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
    // Keep to the speed limit, and wait at red lights.
    target = Math.min(target, speedLimitAt(v.x, v.z) / 3.6);
    const redStop = this.lights ? this.lights.stopAhead(v.x, v.z, v.heading, speed) : Infinity;
    if (redStop < 75) target = Math.min(target, Math.max(0, (redStop - 1) * 0.55));
    // Don't run into a car going the same way in front. (Cars crossing or
    // coming the other way are ignored, or two drivers could wait for each other.)
    if (traffic) {
      const fx = Math.sin(v.heading);
      const fz = Math.cos(v.heading);
      for (const c of traffic.cars) {
        const rx = c.x - v.x;
        const rz = c.z - v.z;
        const along = rx * fx + rz * fz;
        if (c === this.passCar) continue; // going round it
        const sameWay = !c.moving || Math.sin(c.yaw) * fx + Math.cos(c.yaw) * fz > 0.5;
        if (sameWay && along > 0 && along < 30 && Math.abs(rx * fz - rz * fx) < 1.5) target = Math.min(target, Math.max(0, (along - 8) * 0.7));
      }
    }
    // Anything about to cross our path (at a junction, say): give way.
    if (traffic && speed > 0.5) {
      const vx = v.vx;
      const vz = v.vz;
      for (const c of traffic.cars) {
        if (!c.moving || c === this.passCar) continue;
        const px = c.x - v.x;
        const pz = c.z - v.z;
        if (Math.abs(px) > 60 || Math.abs(pz) > 60) continue;
        const wx = Math.sin(c.yaw) * c.speed - vx;
        const wz = Math.cos(c.yaw) * c.speed - vz;
        const w2 = wx * wx + wz * wz;
        if (w2 < 1) continue;
        const t = -(px * wx + pz * wz) / w2;
        if (t <= 0 || t > 3.5) continue;
        const miss = Math.hypot(px + wx * t, pz + wz * t);
        if (miss < 3.1) target = Math.min(target, speed * (t < 1.5 ? 0.2 : 0.6));
      }
    }
    // Off the road or not lined up with it yet (just setting off, or after a
    // bump): go gently, and stop short of anything in the way.
    if (Math.sqrt(bestD) > 4 || Math.abs(err) > 0.5) {
      target = Math.min(target, 6);
      const room = this.clearance(v, 1, 8, traffic);
      if (room < 8) target = Math.min(target, Math.max(0, (room - 0.6) * 1.2));
    }

    if (left < 8 && speed < 1) {
      this.arrived = true;
      this.route = null;
      return HOLD;
    }
    // Wanting to go but not moving: something is in the way, so back out.
    const blocked = target > 1 && speed < 0.4;
    const offRoad = Math.sqrt(bestD) > 4 || Math.abs(err) > 0.5;
    this.stuck = blocked || (offRoad && target < 0.3) ? this.stuck + dt : 0;
    if (this.stuck > 1.2) {
      this.mode = "unstick";
      this.modeTime = 0;
      this.phaseFrom = null;
      this.stuck = 0;
      return HOLD;
    }
    // Waiting (at a light, behind a car): hold the car still.
    if (target < 0.3 && speed < 1.5) return HOLD;
    const throttle = speed < target - 0.4 ? clamp((target - speed) / 4, 0.25, 1) : 0;
    const brake = speed > target + 1.2 ? clamp((speed - target) / 5, 0.15, 1) : 0;
    // Pure pursuit: the wheel angle that arcs the car onto the target point.
    const lookDist = Math.max(4, Math.hypot(tx - v.x, tz - v.z));
    const steerAngle = Math.atan2(2 * v.L * Math.sin(err), lookDist);
    return { steer: 0, steerAngle, throttle, brake, reverse: 0, handbrake: false, steerAnalog: true };
  }
}
