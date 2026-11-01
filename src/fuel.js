import { MeshBuilder, Mesh, StandardMaterial, Color3, Vector3 } from "@babylonjs/core";
import { clamp } from "./noise.js";
import { toStation } from "./world/stations.js";

// How much fuel (or battery) your car has left, and filling it up at a
// station: you get out, walk to the pump, carry the nozzle (or charging cable)
// to the car, fill up, put it back and get in again.

export const FUEL_FLOOR = 0.1; // it never drops below this; you just keep being told to fill up
const DRAIN = 1 / 500; // a full tank lasts about 12 minutes of ordinary driving
const WALK = 1.35; // walking speed, m/s

export class Fuel {
  constructor(level = 1) {
    this.level = clamp(level, FUEL_FLOOR, 1);
    this.electric = false;
    this.auto = false;
    this._warn = 0;
  }

  // Returns a warning to show, or null.
  update(dt, vehicle, driving) {
    if (this.auto) {
      // "Auto": tops itself up, so it never runs low.
      this.level = Math.min(1, this.level + dt * 0.03);
      return null;
    }
    if (driving) {
      // Uses more with your foot down and at speed; an electric car uses
      // next to nothing while standing still.
      const idle = this.electric ? 0.02 : 0.2;
      const use = (idle + (1 - idle) * vehicle.throttle) * clamp(vehicle.speed / 22, 0.15, 1.6);
      this.level = Math.max(FUEL_FLOOR, this.level - dt * use * DRAIN);
    }
    if (this.level > 0.2) {
      this._warn = 0;
      return null;
    }
    this._warn -= dt;
    if (this._warn > 0) return null;
    const empty = this.level <= FUEL_FLOOR + 0.001;
    this._warn = empty ? 25 : 60;
    if (this.electric) return empty ? "Battery nearly flat! Charge up at a station (see the map)" : "Battery low: charge up at a station soon";
    return empty ? "Fuel nearly empty! Fill up at a station (see the map)" : "Fuel low: fill up at a station soon";
  }
}

// The stopping place at a pump the car is standing in, if any.
export function pumpSpotAt(stations, vehicle) {
  for (const s of stations) {
    if (Math.abs(vehicle.x - s.x) > 40 || Math.abs(vehicle.z - s.z) > 40) continue;
    const { u, w } = toStation(s, vehicle.x, vehicle.z);
    const along = Math.sin(vehicle.heading) * s.tx + Math.cos(vehicle.heading) * s.tz;
    if (Math.abs(along) < 0.75) continue;
    for (const spot of s.spots) {
      if (Math.abs(u - spot.u) < 2.4 && Math.abs(w - spot.w) < 1.6) return { station: s, spot };
    }
  }
  return null;
}

const v3 = (x, y, z) => new Vector3(x, y, z);

export class Refuel {
  constructor(scene, world, people) {
    this.scene = scene;
    this.world = world;
    this.people = people;
    this.active = false;

    // The petrol nozzle and the charging plug you carry.
    const dark = new StandardMaterial("nozzleMat", scene);
    dark.diffuseColor = new Color3(0.05, 0.05, 0.05);
    const grip = new StandardMaterial("nozzleGrip", scene);
    grip.diffuseColor = new Color3(0.02, 0.32, 0.34);
    const white = new StandardMaterial("plugMat", scene);
    white.diffuseColor = new Color3(0.85, 0.86, 0.86);
    const green = new StandardMaterial("plugGlow", scene);
    green.emissiveColor = new Color3(0.2, 0.9, 0.5);
    green.disableLighting = true;
    const part = (name, opts, mat, x, y, z) => {
      const m = MeshBuilder.CreateBox(name, opts, scene);
      m.position.set(x, y, z);
      m.material = mat;
      return m;
    };
    // Built pointing along +z (the spout end), held at the origin.
    this.nozzle = Mesh.MergeMeshes([part("n1", { width: 0.06, height: 0.14, depth: 0.08 }, grip, 0, -0.05, -0.06), part("n2", { width: 0.05, height: 0.05, depth: 0.2 }, dark, 0, 0.02, 0.04), part("n3", { width: 0.03, height: 0.03, depth: 0.16 }, dark, 0, 0.0, 0.2)], true, true, undefined, false, true);
    this.plug = Mesh.MergeMeshes([part("p1", { width: 0.07, height: 0.15, depth: 0.08 }, white, 0, -0.05, -0.05), part("p2", { width: 0.06, height: 0.06, depth: 0.14 }, white, 0, 0.02, 0.06), part("p3", { width: 0.065, height: 0.065, depth: 0.02 }, green, 0, 0.02, 0.13)], true, true, undefined, false, true);
    for (const m of [this.nozzle, this.plug]) {
      m.isPickable = false;
      m.setEnabled(false);
      m.rotationQuaternion = null;
    }
    this.hoseMat = new StandardMaterial("hoseMat", scene);
    this.hoseMat.diffuseColor = new Color3(0.04, 0.04, 0.045);
    this.hose = null;
    this._path = Array.from({ length: 12 }, () => new Vector3());
  }

  get busy() {
    return this.active;
  }

  // Begins the whole fill-up. `onDone` runs when you're back in the car.
  start({ station, vehicle, fuel, onDone }) {
    const electric = fuel.electric;
    const h = vehicle.heading;
    const f = v3(Math.sin(h), 0, Math.cos(h));
    const r = v3(Math.cos(h), 0, -Math.sin(h));
    const car = v3(vehicle.x, vehicle.y, vehicle.z);
    // Which side of the car the pump island is on (+1 = right).
    const isl = station.devices[0];
    const islandSide = (isl.x - car.x) * r.x + (isl.z - car.z) * r.z > 0 ? 1 : -1;
    const at = (side, back, y = 0) => car.add(r.scale(side)).add(f.scale(back)).add(v3(0, y, 0));
    const filler = at(islandSide * 0.98, -1.3, 0.8);
    const fillerStand = at(islandSide * 1.62, -1.3);
    // The nearest pump (or charger) of the right kind.
    const type = electric ? "electric" : "petrol";
    let device = null;
    for (const d of station.devices) {
      if (d.type !== type) continue;
      if (!device || Math.hypot(d.x - filler.x, d.z - filler.z) < Math.hypot(device.x - filler.x, device.z - filler.z)) device = d;
    }
    const toLane = r.scale(-islandSide);
    const devicePos = v3(device.x, car.y, device.z);
    const deviceStand = devicePos.add(toLane.scale(0.95));
    const outlet = devicePos.add(toLane.scale(0.3)).add(v3(0, electric ? 1.05 : 1.15, 0));
    const door = at(-1.3, 0.25);
    // Walk round the back of the car if the pump is on the other side from the door.
    const round = islandSide > 0 ? [at(-1.4, -3), at(1.6, -3)] : [];
    const faceDevice = Math.atan2(-toLane.x, -toLane.z);
    const faceCar = Math.atan2(toLane.x, toLane.z);
    this.steps = [
      { walk: [door, ...round, deviceStand] },
      { wait: 0.9, face: faceDevice, carry: "take" },
      { walk: [fillerStand], carry: "hand" },
      { wait: 0.6, face: faceCar, carry: "plug" },
      { fill: true, face: faceCar, carry: "plug" },
      { wait: 0.6, face: faceCar, carry: "hand" },
      { walk: [deviceStand], carry: "hand" },
      { wait: 0.8, face: faceDevice, carry: "hang" },
      { walk: [...round.slice().reverse(), door] },
    ];
    Object.assign(this, { electric, fuel, filler, outlet, car, onDone, active: true, step: 0, t: 0, point: 0, r, f, toLane });
    this.held = electric ? this.plug : this.nozzle;
    const p = this.people.player;
    p.x = door.x;
    p.z = door.z;
    p.y = car.y;
    p.heading = Math.atan2(-r.x, -r.z);
    p.speed = 0;
    p.hidden = false;
    // The hose (or cable) from the pump to whatever you're holding.
    this.hose?.dispose();
    this.hose = MeshBuilder.CreateTube("hose", { path: this._sag(outlet, outlet.add(v3(0, -0.5, 0))), radius: electric ? 0.018 : 0.022, tessellation: 6, updatable: true }, this.scene);
    this.hose.material = this.hoseMat;
    this.hose.isPickable = false;
    this.hose.setEnabled(false);
    // A fixed camera behind the car, looking along the gap between the car
    // and the pumps, where all the action is.
    this.camPos = car.add(f.scale(-6.8)).add(r.scale(islandSide * 1.75)).add(v3(0, 2.3, 0));
    this.camTarget = car.add(f.scale(0.6)).add(r.scale(islandSide * 1.9)).add(v3(0, 0.75, 0));
  }

  // Points along a hose hanging between a and b.
  _sag(a, b) {
    const n = this._path.length;
    const dist = Vector3.Distance(a, b);
    const sag = 0.25 + dist * 0.12;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      Vector3.LerpToRef(a, b, t, this._path[i]);
      this._path[i].y -= sag * 4 * t * (1 - t);
    }
    return this._path;
  }

  _hand() {
    const hand = this.people.body?.nodes.get("Bip01 R Hand");
    if (hand) return hand.getAbsolutePosition().clone();
    const p = this.people.player;
    return v3(p.x + Math.cos(p.heading) * 0.25, p.y + 0.85, p.z - Math.sin(p.heading) * 0.25);
  }

  skip() {
    if (!this.active) return;
    this.fuel.level = 1;
    this._finish();
  }

  _finish() {
    this.active = false;
    this.nozzle.setEnabled(false);
    this.plug.setEnabled(false);
    this.hose?.setEnabled(false);
    this.people.player.hidden = true;
    this.people.player.speed = 0;
    this.onDone?.();
  }

  // Status text for the screen while it's happening.
  get status() {
    const pct = Math.round(this.fuel.level * 100);
    if (this.steps[this.step]?.fill) return `${this.electric ? "Charging" : "Filling up"} · ${pct}%`;
    return this.electric ? "Charging the car" : "Filling up";
  }

  update(dt) {
    if (!this.active) return;
    const p = this.people.player;
    const step = this.steps[this.step];
    this.t += dt;
    let next = false;
    if (step.walk) {
      const target = step.walk[this.point];
      const dx = target.x - p.x;
      const dz = target.z - p.z;
      const d = Math.hypot(dx, dz);
      const move = WALK * dt;
      p.speed = WALK;
      p.heading = turn(p.heading, Math.atan2(dx, dz), 8 * dt);
      if (d <= move) {
        p.x = target.x;
        p.z = target.z;
        this.point++;
        if (this.point >= step.walk.length) next = true;
      } else {
        p.x += (dx / d) * move;
        p.z += (dz / d) * move;
      }
    } else {
      p.speed = 0;
      p.heading = turn(p.heading, step.face, 6 * dt);
      if (step.fill) {
        this.fuel.level = Math.min(1, this.fuel.level + dt * (this.electric ? 0.13 : 0.2));
        if (this.fuel.level >= 1) next = true;
      } else if (this.t >= step.wait) next = true;
    }
    p.y = this.car.y;

    // What you're holding and where the hose goes.
    const carry = step.carry;
    const held = this.held;
    const showHeld = carry === "hand" || carry === "plug" || (carry === "take" && this.t > 0.4) || (carry === "hang" && this.t < 0.4);
    held.setEnabled(showHeld);
    this.hose.setEnabled(showHeld);
    if (showHeld) {
      if (carry === "plug") {
        // In the filler, pointing into the car.
        held.position.copyFrom(this.filler).addInPlace(this.toLane.scale(0.12));
        held.rotation.set(0.45, Math.atan2(-this.toLane.x, -this.toLane.z), 0);
      } else {
        held.position.copyFrom(this._hand());
        held.rotation.set(0.35, p.heading, 0);
      }
      const back = held.position.subtract(v3(Math.sin(held.rotation.y), 0, Math.cos(held.rotation.y)).scale(0.12));
      MeshBuilder.CreateTube("hose", { path: this._sag(this.outlet, back), instance: this.hose });
    }

    if (next) {
      this.step++;
      this.t = 0;
      this.point = 0;
      if (this.step >= this.steps.length) this._finish();
    }
  }

  // Places the camera for the scene.
  camera(cam) {
    cam.position.copyFrom(this.camPos);
    cam.setTarget(this.camTarget);
  }
}

function turn(a, b, max) {
  let d = b - a;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return a + clamp(d, -max, max);
}
