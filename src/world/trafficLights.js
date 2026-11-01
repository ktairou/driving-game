import { MeshBuilder, StandardMaterial, Color3, Matrix, Quaternion, Vector3 } from "@babylonjs/core";
import { mulberry32 } from "../noise.js";
import { inTown } from "./road.js";
import { ROAD_HALF_WIDTH, ROAD_SAMPLE_STEP } from "./layout.js";

// Speed limits (km/h): 60 where there are houses, 120 everywhere else.
export function speedLimitAt(x, z) {
  return inTown(x, z, 20) ? 60 : 120;
}

// Traffic lights at every crossroads and T-junction in a town. Each one has
// two groups of approaches (one road, then the other) taking turns.
const STOP_BACK = 9; // the stop line, in metres before the middle of the junction
const GREEN = 14;
const AMBER = 3;
const ALL_RED = 1.5;
const HALF = GREEN + AMBER + ALL_RED;
const CYCLE = HALF * 2;
const POLE_H = 2.9;
const HEAD_Y = POLE_H + 0.45;

const LAMP = {
  red: { on: [5, 0.22, 0.12], off: [0.1, 0.012, 0.01] },
  amber: { on: [5, 2.4, 0.2], off: [0.1, 0.05, 0.008] },
  green: { on: [0.25, 4.5, 1.6], off: [0.008, 0.08, 0.04] },
};
const ORDER = ["red", "amber", "green"];

export class TrafficLights {
  constructor(scene, world, colliders) {
    this.world = world;
    this.time = 0;
    this.sites = [];
    this.byRoad = new Map();
    const rand = mulberry32(808);
    const net = world.network;
    const add = (x, z, entries) => {
      const site = { x, z, entries, offset: rand() * CYCLE, shown: [null, null], playerInside: false };
      for (const e of entries) {
        e.site = site;
        if (!this.byRoad.has(e.road)) this.byRoad.set(e.road, []);
        this.byRoad.get(e.road).push(e);
      }
      this.sites.push(site);
    };
    for (const c of net.crossings) {
      if (inTown(c.x, c.z, 40)) add(c.x, c.z, [{ road: c.a, index: c.i, group: 0 }, { road: c.b, index: c.j, group: 1 }]);
    }
    for (const j of net.junctions) {
      const [x, z] = j.road.points[j.end];
      // The side road only has traffic arriving one way: towards its end.
      if (inTown(x, z, 40)) add(x, z, [{ road: j.other, index: j.at, group: 0 }, { road: j.road, index: j.end, group: 1, dir: j.end === 0 ? -1 : 1 }]);
    }

    // One light on a pole at the stop line of every way in, on the kerb side.
    const heads = [];
    for (const site of this.sites) {
      site.heads = [];
      for (const e of site.entries) {
        for (const dir of e.dir ? [e.dir] : [1, -1]) {
          const road = e.road;
          let si = Math.round(e.index - (dir * STOP_BACK) / ROAD_SAMPLE_STEP);
          if (road.closed) si = ((si % road.count) + road.count) % road.count;
          else if (si < 0 || si >= road.count) continue;
          const [px, pz] = road.points[si];
          const [tx, tz] = road.tangents[si];
          const dx = tx * dir;
          const dz = tz * dir;
          const island = world.islandAt(px, pz);
          const side = island && island.def.drive === "left" ? -1 : 1;
          // right of travel = (dz, -dx)
          const x = px + dz * side * (ROAD_HALF_WIDTH + 0.7);
          const z = pz - dx * side * (ROAD_HALF_WIDTH + 0.7);
          const y = world.getHeight(x, z);
          colliders.addCircle(x, z, 0.18);
          // Faces the traffic coming towards it.
          heads.push({ x, y, z, yaw: Math.atan2(-dx, -dz) });
          site.heads.push({ group: e.group, index: heads.length - 1 });
        }
      }
    }

    const metal = new StandardMaterial("signalMetal", scene);
    metal.diffuseColor = new Color3(0.09, 0.1, 0.1);
    metal.specularColor = new Color3(0.25, 0.25, 0.25);
    const pole = MeshBuilder.CreateCylinder("signalPoles", { height: POLE_H, diameter: 0.13, tessellation: 10 }, scene);
    pole.bakeTransformIntoVertices(Matrix.Translation(0, POLE_H / 2, 0));
    pole.material = metal;
    const box = MeshBuilder.CreateBox("signalHeads", { width: 0.36, height: 1.0, depth: 0.26 }, scene);
    box.bakeTransformIntoVertices(Matrix.Translation(0, HEAD_Y, 0));
    box.material = metal;
    const lamp = MeshBuilder.CreateDisc("signalLamps", { radius: 0.11, tessellation: 18 }, scene);
    const lampMat = new StandardMaterial("signalLampMat", scene);
    lampMat.disableLighting = true;
    // Unlit: each lamp's own colour (set per lamp below) is what you see.
    lampMat.emissiveColor = new Color3(1, 1, 1);
    lampMat.backFaceCulling = false;
    lamp.material = lampMat;

    const q = new Quaternion();
    const one = Vector3.One();
    const poleBuf = new Float32Array(heads.length * 16);
    const lampBuf = new Float32Array(heads.length * 3 * 16);
    this.lampColours = new Float32Array(heads.length * 3 * 4);
    heads.forEach((h, i) => {
      Quaternion.RotationYawPitchRollToRef(h.yaw, 0, 0, q);
      const base = Matrix.Compose(one, q, new Vector3(h.x, h.y, h.z));
      base.copyToArray(poleBuf, i * 16);
      ORDER.forEach((name, k) => {
        Matrix.Translation(0, HEAD_Y + 0.3 - k * 0.3, 0.135).multiply(base).copyToArray(lampBuf, (i * 3 + k) * 16);
      });
    });
    pole.thinInstanceSetBuffer("matrix", poleBuf, 16, true);
    box.thinInstanceSetBuffer("matrix", poleBuf.slice(), 16, true);
    lamp.thinInstanceSetBuffer("matrix", lampBuf, 16, true);
    lamp.thinInstanceSetBuffer("color", this.lampColours, 4, false);
    for (const m of [pole, box, lamp]) {
      m.isPickable = false;
      m.receiveShadows = m !== lamp;
      m.alwaysSelectAsActiveMesh = true;
    }
    this.lamp = lamp;
    this.casters = heads.length ? [pole, box] : [];
    if (!heads.length) for (const m of [pole, box, lamp]) m.setEnabled(false);
    this.update(0);
  }

  // "green", "amber" or "red" for one group at a site.
  state(site, group) {
    const t = (((this.time + site.offset) % CYCLE) + CYCLE) % CYCLE;
    const local = group === 0 ? t : (t + HALF) % CYCLE;
    if (local < GREEN) return "green";
    if (local < GREEN + AMBER) return "amber";
    return "red";
  }

  update(dt) {
    this.time += dt;
    let changed = false;
    for (const site of this.sites) {
      for (const group of [0, 1]) {
        const s = this.state(site, group);
        if (site.shown[group] === s) continue;
        site.shown[group] = s;
        changed = true;
        for (const h of site.heads) {
          if (h.group !== group) continue;
          ORDER.forEach((name, k) => {
            const c = name === s ? LAMP[name].on : LAMP[name].off;
            this.lampColours.set([c[0], c[1], c[2], 1], (h.index * 3 + k) * 4);
          });
        }
      }
    }
    if (changed) this.lamp.thinInstanceBufferUpdated("color");
  }

  // Whether a light says stop: red, or amber when there's room to stop.
  _mustStop(state, dist, speed) {
    if (state === "red") return true;
    return state === "amber" && dist > (speed * speed) / (2 * 4) + 1;
  }

  // For a traffic car: metres to the stop line it has to wait at, or Infinity.
  stopDistance(car) {
    let best = Infinity;
    for (const e of this.byRoad.get(car.road) ?? []) {
      if (e.dir && e.dir !== car.dir) continue;
      let ds = (e.index - car.s) * car.dir;
      if (car.road.closed) {
        const n = car.road.count;
        ds = ((ds % n) + n) % n;
      }
      const dist = ds * ROAD_SAMPLE_STEP - STOP_BACK;
      // Already over the line: carry on through.
      if (dist < -0.5 || dist > 70) continue;
      if (this._mustStop(this.state(e.site, e.group), dist, car.speed)) best = Math.min(best, dist);
    }
    return best;
  }

  // The road at a site you're travelling along, from your direction of travel.
  _entryFor(site, fx, fz) {
    let best = null;
    let bestDot = 0.7;
    for (const e of site.entries) {
      const [tx, tz] = e.road.tangents[e.index];
      const dot = Math.abs(tx * fx + tz * fz);
      if (dot > bestDot) {
        bestDot = dot;
        best = e;
      }
    }
    return best;
  }

  // For the self-driver: metres to a stop line ahead it has to wait at, or Infinity.
  stopAhead(x, z, heading, speed) {
    const fx = Math.sin(heading);
    const fz = Math.cos(heading);
    let best = Infinity;
    for (const site of this.sites) {
      const rx = site.x - x;
      const rz = site.z - z;
      const along = rx * fx + rz * fz;
      if (along < STOP_BACK - 0.5 || along > 75 || Math.abs(rx * fz - rz * fx) > 8) continue;
      const e = this._entryFor(site, fx, fz);
      if (e && this._mustStop(this.state(site, e.group), along - STOP_BACK, speed)) best = Math.min(best, along - STOP_BACK);
    }
    return best;
  }

  // True on the frame you drive into a junction while your light is red.
  ranRed(x, z, vx, vz) {
    const speed = Math.hypot(vx, vz);
    let ran = false;
    for (const site of this.sites) {
      const d = Math.hypot(x - site.x, z - site.z);
      if (d > 14) {
        site.playerInside = false;
        continue;
      }
      if (d > 6 || site.playerInside) continue;
      site.playerInside = true;
      if (speed < 3) continue;
      const e = this._entryFor(site, vx / speed, vz / speed);
      if (e && this.state(site, e.group) === "red") ran = true;
    }
    return ran;
  }
}
