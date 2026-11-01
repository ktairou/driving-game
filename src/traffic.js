import { Matrix, Quaternion, Vector3 } from "@babylonjs/core";
import { clamp, lerp, mulberry32 } from "./noise.js";
import { inTown } from "./world/road.js";
import { ISLANDS, LANE_OFFSET, ROAD_HALF_WIDTH, ROAD_SAMPLE_STEP } from "./world/layout.js";

export const CAR_COLOURS = [
  [0.75, 0.05, 0.04], [0.92, 0.92, 0.9], [0.06, 0.06, 0.07], [0.1, 0.22, 0.55], [0.55, 0.57, 0.6],
  [0.85, 0.6, 0.08], [0.08, 0.35, 0.18], [0.45, 0.04, 0.1], [0.2, 0.42, 0.62], [0.95, 0.4, 0.05],
];

const DRAW_RANGE = 480; // cars further than this from the camera aren't drawn
const CAR_RADIUS = 1.0;

// Point and direction at a fractional sample position along a road.
function sampleRoad(road, s) {
  const n = road.count;
  let i0;
  let t;
  if (road.closed) {
    const w = ((s % n) + n) % n;
    i0 = Math.floor(w);
    t = w - i0;
  } else {
    const c = clamp(s, 0, n - 1.0001);
    i0 = Math.floor(c);
    t = c - i0;
  }
  const i1 = road.closed ? (i0 + 1) % n : Math.min(n - 1, i0 + 1);
  const a = road.points[i0];
  const b = road.points[i1];
  const x = lerp(a[0], b[0], t);
  const z = lerp(a[1], b[1], t);
  const y = lerp(road.heights[i0], road.heights[i1], t);
  const ta = road.tangents[i0];
  const tb = road.tangents[i1];
  const tx = lerp(ta[0], tb[0], t);
  const tz = lerp(ta[1], tb[1], t);
  const l = Math.hypot(tx, tz) || 1;
  const slope = (road.heights[i1] - road.heights[i0]) / ROAD_SAMPLE_STEP;
  return { x, y, z, tx: tx / l, tz: tz / l, slope };
}

// Cars driving round the roads by themselves, plus cars parked in towns.
// All of them are drawn as one instanced mesh.
export class Traffic {
  constructor(scene, world, mesh, quality) {
    this.world = world;
    this.mesh = mesh;
    this.rand = mulberry32(1234);
    this.cars = [];
    this.maxInstances = quality.traffic + quality.parked + 4;
    this.matrices = new Float32Array(this.maxInstances * 16);
    this.colours = new Float32Array(this.maxInstances * 4);
    mesh.thinInstanceSetBuffer("matrix", this.matrices, 16, false);
    mesh.thinInstanceSetBuffer("color", this.colours, 4, false);
    mesh.thinInstanceCount = 0;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.receiveShadows = true;

    // Junction lookup: which samples of a loop lead onto a connector.
    this.junctionsByRoad = new Map();
    for (const j of world.network.junctions) {
      if (!this.junctionsByRoad.has(j.other)) this.junctionsByRoad.set(j.other, []);
      this.junctionsByRoad.get(j.other).push(j);
    }

    const roads = world.network.roads;
    for (let k = 0; k < quality.traffic; k++) {
      const road = roads[k % roads.length];
      const s = this.rand() * (road.count - 1);
      this._addMoving(road, s, this.rand() < 0.5 ? 1 : -1);
    }
    this._addParked(quality.parked);
  }

  _colour() {
    return CAR_COLOURS[Math.floor(this.rand() * CAR_COLOURS.length)];
  }

  _addMoving(road, s, dir) {
    const car = {
      moving: true,
      road,
      s,
      dir,
      speed: 8,
      cruise: 13 + this.rand() * 8,
      lane: 0,
      stopTimer: 0,
      colour: this._colour(),
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      pitch: 0,
    };
    this._place(car, 0);
    car.lane = car.laneTarget;
    this.cars.push(car);
    return car;
  }

  _addParked(count) {
    // Along the kerb of each town's main street.
    const spots = [];
    for (const isl of ISLANDS) {
      const s = isl.town.street;
      for (let x = s.x0 + 14; x < s.x1 - 14; x += 22) {
        for (const side of [-1, 1]) {
          const px = x + (this.rand() - 0.5) * 6;
          const pz = s.z + side * (ROAD_HALF_WIDTH - 1.05);
          if (!this.world.network.isNearMeeting(px, pz, 14)) spots.push({ isl, x: px, z: pz, side });
        }
      }
    }
    for (let i = spots.length - 1; i > 0; i--) {
      const j = Math.floor(this.rand() * (i + 1));
      [spots[i], spots[j]] = [spots[j], spots[i]];
    }
    for (const sp of spots.slice(0, count)) {
      // Park facing the way traffic flows on that side of the road.
      const flowEast = (sp.isl.drive === "left") === (sp.side > 0);
      this.addParked(sp.x, sp.z, flowEast ? Math.PI / 2 : -Math.PI / 2, this._colour());
    }
  }

  addParked(x, z, yaw, colour) {
    const car = { moving: false, x, z, y: this.world.getHeight(x, z), yaw, pitch: 0, colour };
    this.cars.push(car);
    return car;
  }

  remove(car) {
    this.cars = this.cars.filter((c) => c !== car);
  }

  // Lane: drive on the left in Britain, on the right everywhere else.
  _place(car, dt) {
    const p = sampleRoad(car.road, car.s);
    const dx = p.tx * car.dir;
    const dz = p.tz * car.dir;
    const island = this.world.islandAt(p.x, p.z);
    const drive = island ? island.def.drive : car.road.drive;
    car.laneTarget = drive === "left" ? -LANE_OFFSET : LANE_OFFSET;
    car.lane = dt ? lerp(car.lane, car.laneTarget, 1 - Math.exp(-dt * 0.6)) : car.laneTarget;
    // right of travel = (dz, -dx)
    car.x = p.x + dz * car.lane;
    car.z = p.z - dx * car.lane;
    car.y = p.y + 0.04;
    car.yaw = Math.atan2(dx, dz);
    car.pitch = -Math.atan(p.slope * car.dir);
  }

  // How sharply the road bends over the next stretch (radians per metre).
  _bend(car) {
    const a = sampleRoad(car.road, car.s);
    const b = sampleRoad(car.road, car.s + car.dir * 15);
    const d = Math.abs(Math.atan2(a.tx * b.tz - a.tz * b.tx, a.tx * b.tx + a.tz * b.tz));
    return d / 30;
  }

  update(dt, player, camera) {
    const moving = this.cars.filter((c) => c.moving);
    for (const car of moving) {
      // Target speed: cruising, slower in towns and on bends.
      let target = inTown(car.x, car.z, 10) ? 9 : car.cruise;
      const bend = this._bend(car);
      if (bend > 0.001) target = Math.min(target, Math.sqrt(3.5 / bend));
      // Keep a gap to anything ahead in the same lane, including the player.
      const fx = Math.sin(car.yaw);
      const fz = Math.cos(car.yaw);
      const ahead = (ox, oz, r) => {
        const rx = ox - car.x;
        const rz = oz - car.z;
        const along = rx * fx + rz * fz;
        const side = Math.abs(rx * fz - rz * fx);
        return along > 0 && along < 28 && side < r ? along : Infinity;
      };
      let gap = Infinity;
      // Only queue behind cars going the same way (or parked in the lane).
      for (const o of this.cars) {
        if (o === car) continue;
        if (o.moving && Math.sin(o.yaw) * fx + Math.cos(o.yaw) * fz < 0.5) continue;
        gap = Math.min(gap, ahead(o.x, o.z, 1.5));
      }
      if (player) gap = Math.min(gap, ahead(player.x, player.z, 1.8));
      if (gap < 28) target = Math.min(target, Math.max(0, (gap - 7) * 0.8));
      if (car.stopTimer > 0) {
        car.stopTimer -= dt;
        target = 0;
      }
      const rate = car.speed < target ? 2.6 : 7;
      car.speed = car.speed + clamp(target - car.speed, -rate * dt, rate * dt);

      car.prevS = car.s;
      car.s += (car.dir * car.speed * dt) / ROAD_SAMPLE_STEP;
      this._handleEnds(car);
      this._place(car, dt);
    }

    // Draw the nearby ones.
    const cx = camera.globalPosition.x;
    const cz = camera.globalPosition.z;
    let n = 0;
    const m = Matrix.Identity();
    const q = new Quaternion();
    const pos = new Vector3();
    const one = Vector3.One();
    for (const car of this.cars) {
      if (n >= this.maxInstances) break;
      if (Math.abs(car.x - cx) > DRAW_RANGE || Math.abs(car.z - cz) > DRAW_RANGE) continue;
      Quaternion.RotationYawPitchRollToRef(car.yaw, car.pitch, 0, q);
      pos.set(car.x, car.y, car.z);
      Matrix.ComposeToRef(one, q, pos, m);
      m.copyToArray(this.matrices, n * 16);
      this.colours.set([car.colour[0], car.colour[1], car.colour[2], 1], n * 4);
      n++;
    }
    this.mesh.thinInstanceCount = n;
    this.mesh.thinInstanceBufferUpdated("matrix");
    this.mesh.thinInstanceBufferUpdated("color");
  }

  _handleEnds(car) {
    const road = car.road;
    const n = road.count;
    if (road.closed) {
      // Maybe turn off onto a connector at a junction we just passed.
      const list = this.junctionsByRoad.get(road);
      if (list) {
        const prev = car.prevS ?? car.s;
        for (const j of list) {
          const w = ((car.s % n) + n) % n;
          const pw = ((prev % n) + n) % n;
          const crossed = car.dir > 0 ? pw < j.at && w >= j.at : pw > j.at && w <= j.at;
          if (crossed && this.rand() < 0.35) {
            car.road = j.road;
            car.s = j.end;
            car.dir = j.end === 0 ? 1 : -1;
            return;
          }
        }
      }
      return;
    }
    // Reached the end of a connector: join the loop at that end.
    if (car.s < 0 || car.s > n - 1) {
      const atStart = car.s < 0;
      const j = this.world.network.junctions.find((jj) => jj.road === road && jj.end === (atStart ? 0 : n - 1));
      if (!j) {
        car.dir = -car.dir;
        car.s = clamp(car.s, 0, n - 1);
        return;
      }
      car.road = j.other;
      car.s = j.at;
      car.dir = this.rand() < 0.5 ? 1 : -1;
    }
  }

  // Circles other things should bump into: two per car.
  colliders() {
    const out = [];
    for (const c of this.cars) {
      const fx = Math.sin(c.yaw);
      const fz = Math.cos(c.yaw);
      out.push({ x: c.x + fx * 1.0, z: c.z + fz * 1.0, r: CAR_RADIUS, car: c });
      out.push({ x: c.x - fx * 1.0, z: c.z - fz * 1.0, r: CAR_RADIUS, car: c });
    }
    return out;
  }

  nearest(x, z, within) {
    let best = null;
    let bestD = within;
    for (const c of this.cars) {
      const d = Math.hypot(c.x - x, c.z - z);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }
}
