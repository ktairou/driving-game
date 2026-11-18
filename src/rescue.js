import { Vector3 } from "@babylonjs/core";
import "./rescue.css";
import { GARAGE } from "./garage.js";
import { AutoDriver } from "./navigation.js";
import { clamp, lerp } from "./noise.js";
import { LANE_OFFSET } from "./world/layout.js";

// Running out of fuel and calling for help. A road service truck sets off from
// a little way along the roads (out of the camera's view when it can), drives
// to you, stops just behind (or beside) you, fills you up for free, then
// drives on and goes once it's out of sight. One call at a time:
//   idle -> loading (its model) -> coming -> filling -> leaving -> idle
//
// The truck is drawn by the traffic (as a car with `rescue: true`, which the
// traffic leaves alone), steered by a self-driver like your car's
// (navigation.js: it keeps to the limits and waits at red lights) and moved
// here with simple sums, like a street race rival (streetRace.js), so it
// follows the roads and can't get stuck on a wall.

const KIND = "worktruck"; // the white "Road service" truck
const SPEC = GARAGE.find((g) => g.id === KIND).spec;
const NEAR = 250; // it sets off between these many metres' drive away...
const FAR = 400;
const REACH = 60; // ...for the road point nearest your car, if the car is this close to it
const SHORT = 3; // road points (2 m each) short of that point it stops when coming up behind you
const GAP = 10; // metres it leaves between its front and your car's back (room to pull out round you)
const ROLLING = 32; // rolling resistance, as in vehicle.js
const BRAKE = 11; // m/s² at full brake (vehicle.js: 15000 N per 1350 kg)
const BACK = 3; // m/s² backing up
const WAIT = 1.5; // seconds stopped before the fill-up starts...
const FILL = 0.25; // ...which adds this much of a tank a second...
const AFTER = 2; // ...then this long before it drives off
const STILL = { steer: 0, steerAngle: 0, throttle: 0, brake: 1, reverse: 0, handbrake: true, steerAnalog: true };
const AXIS_Z = new Vector3(0, 0, 1);

export class Rescue {
  // hooks: { kinds: { load(id), release(ids) }, camera() -> the game camera,
  //   toast(text), call() (the Call for help button), filled() (the tank is full: save it) }
  constructor({ world, navigator, vehicle, traffic, fuel, lights, colliders, hooks }) {
    Object.assign(this, { world, navigator, vehicle, traffic, fuel, hooks });
    this.state = "idle";
    this.car = null; // the truck, as the traffic draws it
    this.halfWidth = 1; // its half width (metres)
    this.loaded = false; // its kind of vehicle was loaded just for this call
    this.driver = new AutoDriver(world, navigator);
    this.driver.lights = lights;
    this.driver.colliders = colliders;
    // What the self-driver needs to know about the truck.
    this.body = { x: 0, z: 0, heading: 0, speed: 0, forwardSpeed: 0, vx: 0, vz: 0, impact: 0, steer: 0, L: 3, a: 1.5, b: 1.5, halfTrack: 0.85, length: 5 };
    // What its driver looks out for: the traffic (not itself) and, once it's
    // done, your car (so it goes round you). Refilled every frame, never remade.
    this.seen = { cars: [] };
    this.you = { moving: false, x: 0, z: 0, yaw: 0, speed: 0, type: { length: 4.6, halfWidth: 1 } };
    this.target = { x: 0, z: 0 }; // where your car was when its way to you was worked out
    this._ctl = { ...STILL }; // its driver's controls, changed (when stopping behind you)
    this.t = 0;
    this.full = null;
    this.blink = 0;
    this.slow = 0;
    this.check = 0;
    this._dir = new Vector3();
    this._buildUi();
  }

  get active() {
    return this.state !== "idle";
  }

  // While it fills you up, your engine stays off (so you can't drive off mid-fill).
  get holding() {
    return this.state === "filling" && this.fuel.level < 1;
  }

  // --- On screen ---------------------------------------------------------------

  _buildUi() {
    const box = document.createElement("div");
    box.className = "rescue";
    box.hidden = true;
    box.innerHTML = `<span class="rescue-text"></span><button class="rescue-call">Call for help</button>`;
    document.getElementById("hud").appendChild(box);
    this.box = box;
    this.textEl = box.querySelector(".rescue-text");
    this.button = box.querySelector(".rescue-call");
    this.button.addEventListener("click", () => this.hooks.call());
    this._kind = -1;
    this._n = -1;
  }

  // The card above the Get out button: "Out of fuel" and a Call for help
  // button while `offer` (empty, and no pump to use), then how help is
  // getting on. Called every frame; only touches the page when what it shows
  // changes (worked out as a kind and a number first, so no words are made).
  hud(offer) {
    let kind = 0;
    let n = 0;
    const s = this.state;
    if (s === "idle") {
      kind = offer ? 1 : 0;
      n = this.fuel.electric ? 1 : 0;
    } else if (s === "loading") kind = 2;
    else if (s === "coming") {
      const d = Math.hypot(this.body.x - this.vehicle.x, this.body.z - this.vehicle.z);
      kind = d > 40 ? 3 : 4;
      n = Math.round(d / 10) * 10;
    } else if (s === "filling") {
      kind = this.t < WAIT ? 4 : this.fuel.level < 1 ? 5 : 6;
      n = Math.round(this.fuel.level * 100);
    }
    if (kind === 4 || kind === 6) n = this.fuel.electric ? 1 : 0;
    if (kind === this._kind && n === this._n) return;
    this._kind = kind;
    this._n = n;
    const e = this.fuel.electric;
    this.box.hidden = kind === 0;
    this.button.hidden = kind !== 1;
    this.box.classList.toggle("asking", kind === 1);
    this.textEl.textContent = ["", e ? "Out of charge" : "Out of fuel", "Calling for help…", `Help is on the way · ${n} m`, "Help is here", `${e ? "Charging" : "Filling up"} · ${n}%`, e ? "Fully charged" : "Full tank"][kind];
  }

  // --- Calling, and calling off ------------------------------------------------

  // The Call for help button (main.js has already ended any race and the self-driving).
  async call() {
    if (this.state === "loading" || this.state === "coming" || this.state === "filling") return;
    const v = this.vehicle;
    const { road, index } = this.world.network.nearest(v.x, v.z);
    const [rx, rz] = road.points[index];
    if (Math.hypot(rx - v.x, rz - v.z) > REACH) {
      this.hooks.toast("Too far from a road for help to reach you. Get back near a road and call again");
      return;
    }
    // Still driving off from last time: it turns back for you.
    if (this.state === "leaving") {
      const route = this._routeTo(this.body.x, this.body.z);
      if (route) {
        this.driver.start(route);
        this.state = "coming";
        this.slow = 0;
        this.check = 1;
        return;
      }
      this._remove();
    }
    this.state = "loading";
    const token = (this._token = {});
    const had = !!this.traffic.type(KIND);
    const got = await this.hooks.kinds.load(KIND);
    if (this._token !== token) {
      // Called off while loading.
      if (!had && got === KIND) this.hooks.kinds.release([KIND]);
      return;
    }
    this.loaded = !had && got === KIND;
    const type = this.traffic.type(got);
    const start = this._start(v.x, v.z, v.heading, -1);
    const route = start && this._routeTo(start.x, start.z);
    if (!route || route.points.length < 3) {
      this.hooks.toast("Help couldn't find a way to you. Try again");
      this._release();
      this.state = "idle";
      return;
    }
    // On the road, in its lane, facing the way it's going.
    const p = route.points;
    const b = this.body;
    const length = type.length ?? 4.6;
    this.halfWidth = type.halfWidth ?? 1;
    Object.assign(b, { L: length * 0.6, a: length * 0.3, b: length * 0.3, halfTrack: (type.halfWidth ?? 1) * 0.85, length, speed: 0, forwardSpeed: 0, vx: 0, vz: 0, steer: 0 });
    b.heading = Math.atan2(p[2].x - p[0].x, p[2].z - p[0].z);
    const lane = this._lane(p[0]);
    b.x = p[0].x + Math.cos(b.heading) * lane;
    b.z = p[0].z - Math.sin(b.heading) * lane;
    this.car = { moving: true, rescue: true, x: b.x, y: 0, z: b.z, yaw: b.heading, pitch: 0, speed: 0, stopTimer: 0, brakeHold: 0, type, colour: [0.92, 0.92, 0.9] };
    this.traffic.cars.push(this.car);
    this._place();
    this.driver.start(route);
    this.state = "coming";
    this.slow = 0;
    this.check = 1;
  }

  // Called off (you took another car, or filled up some other way): it never
  // comes, or drives off again.
  cancel() {
    if (this.state === "loading") {
      this._token = null;
      this.state = "idle";
    } else if (this.state === "coming" || this.state === "filling") this._leave();
  }

  // --- Every frame -------------------------------------------------------------

  update(dt) {
    if (this.state === "idle" || this.state === "loading") return;
    const b = this.body;
    const v = this.vehicle;
    const seen = this.seen.cars;
    seen.length = 0;
    for (const c of this.traffic.cars) if (c !== this.car) seen.push(c);
    if (this.state === "leaving") {
      const y = this.you;
      y.x = v.x;
      y.z = v.z;
      y.yaw = v.heading;
      y.speed = v.speed;
      y.moving = v.speed > 0.5;
      y.type.length = v.length;
      seen.push(y);
    }
    let ctl = this.state !== "filling" && this.driver.active ? this.driver.drive(b, this.seen, dt) : STILL;
    // (Stopping behind you on the way in; never nudging you on the way out.)
    if (this.state === "coming") ctl = this._keepBack(ctl, GAP, Math.max(2.6, this._clear()));
    else if (this.state === "leaving") ctl = this._keepBack(this._pullOut(ctl), 0.6, this._clear() - 0.35);
    this._move(ctl, dt);
    this._place();
    // Brake lights while slowing or waiting; flashing while it's stopped by you.
    const c = this.car;
    if (this.state === "filling") {
      this.blink = (this.blink + dt) % 1;
      c.brakeHold = this.blink < 0.5 ? 1 : 0;
    } else c.brakeHold = ctl.brake > 0 || (ctl.handbrake && b.speed < 0.5) ? 0.4 : Math.max(0, c.brakeHold - dt);
    // Not getting anywhere for a long while (stuck behind something) and out of sight.
    this.slow = b.speed < 0.5 && this.state !== "filling" ? this.slow + dt : 0;
    if (this.state === "coming") this._coming(dt);
    else if (this.state === "filling") this._filling(dt);
    else this._leaving();
  }

  _coming(dt) {
    const b = this.body;
    const v = this.vehicle;
    const d = Math.hypot(b.x - v.x, b.z - v.z);
    // Stopped at the end of its way (or just behind you): there.
    if ((!this.driver.active || d < GAP + 12) && b.speed < 0.3 && d < REACH + 15) {
      this.driver.stop();
      this.state = "filling";
      this.t = 0;
      this.full = null;
      this.blink = 0;
      return;
    }
    // You've moved (rolled on, been put back on the road...): a new way to you.
    this.check -= dt;
    if (this.check <= 0) {
      this.check = 1;
      if (!this.driver.active || Math.hypot(this.target.x - v.x, this.target.z - v.z) > 20) {
        const route = this._routeTo(b.x, b.z);
        if (route && route.points.length >= 3) this.driver.start(route);
      }
    }
    if (this.slow > 15 && this.driver.active && this._offView(b.x, b.z) > 0.1) this._skipAhead(10);
  }

  // Your car ahead, less than `width` metres to either side of its path: it
  // stops `gap` metres short of it, whatever its driver says (its driver
  // doesn't look out for your car on the way in, and must never push it).
  _keepBack(ctl, gap, width) {
    const b = this.body;
    const v = this.vehicle;
    const fx = Math.sin(b.heading);
    const fz = Math.cos(b.heading);
    const rx = v.x - b.x;
    const rz = v.z - b.z;
    const ahead = rx * fx + rz * fz;
    if (ahead <= 0 || ahead > 45 || Math.abs(rx * fz - rz * fx) > width) return ctl;
    const room = ahead - (b.length + v.length) / 2 - gap;
    const target = Math.sqrt(2 * 3 * Math.max(0, room));
    if (b.speed <= target && room > 0.3) return ctl;
    const c = Object.assign(this._ctl, ctl);
    c.throttle = 0;
    c.brake = room > 0.3 ? clamp((b.speed - target) / 3, 0.2, 1) : 1;
    c.handbrake = room <= 0.3 && b.speed < 0.5;
    return c;
  }

  // Driving off from just behind you: out round you slowly at a steady angle,
  // held until it's far enough out to get by (its driver's gentle lane change
  // would clip your car's back corner). Measured across your car, to the side
  // it overtakes on in that country.
  _pullOut(ctl) {
    const b = this.body;
    const v = this.vehicle;
    const hx = Math.sin(v.heading);
    const hz = Math.cos(v.heading);
    const rx = b.x - v.x;
    const rz = b.z - v.z;
    const behind = -(rx * hx + rz * hz);
    const isl = this.world.islandAt(v.x, v.z);
    const way = (isl ? isl.def.drive : "right") === "left" ? 1 : -1; // (1: out to the right)
    const out = (rx * hz - rz * hx) * way;
    const turned = Math.atan2(Math.sin(b.heading - v.heading), Math.cos(b.heading - v.heading));
    if (behind <= 0 || behind > (b.length + v.length) / 2 + GAP + 6 || out >= this._clear() || Math.abs(turned) > 1.2) return ctl;
    const c = Object.assign(this._ctl, ctl);
    c.steerAngle = clamp((way * 0.6 - turned) * 1.5, -0.45, 0.45);
    c.throttle = b.speed < 2.5 ? 0.35 : 0;
    c.brake = b.speed > 3 ? 0.4 : 0;
    c.reverse = 0;
    c.handbrake = false;
    return c;
  }

  // How far apart (middle to middle, across) the truck and your car must be to pass.
  _clear() {
    return this.halfWidth + (this.vehicle.car.geometry.halfWidth ?? 1) + 0.5;
  }

  _filling(dt) {
    this.t += dt;
    const f = this.fuel;
    if (this.t < WAIT) return;
    if (f.level < 1) {
      f.level = Math.min(1, f.level + FILL * dt);
      if (f.level < 1) return;
      this.hooks.filled();
      this.hooks.toast(f.electric ? "Fully charged. Drive safe!" : "Full tank. Drive safe!");
    }
    this.full ??= this.t;
    if (this.t - this.full > AFTER) this._leave();
  }

  // Done (or called off): on along the road, away from you if it can.
  _leave() {
    const b = this.body;
    this.state = "leaving";
    this.slow = 0;
    const start = this._start(b.x, b.z, b.heading, 1);
    const route = start && this.navigator.route(b.x, b.z, start.x, start.z);
    if (route && route.points.length >= 3) this.driver.start(route);
    else this._remove();
  }

  // Gone once out of sight (or far off), or stuck out of sight.
  _leaving() {
    const b = this.body;
    const cam = this.hooks.camera().globalPosition;
    const d = Math.hypot(b.x - cam.x, b.z - cam.z);
    const hidden = this._offView(b.x, b.z) > 0.1;
    if ((hidden && (d > 40 || !this.driver.active || this.slow > 20)) || d > 300) this._remove();
    else if (!this.driver.active) this._leave(); // (at the end of its way, still in view: on again)
  }

  _remove() {
    this.traffic.cars = this.traffic.cars.filter((c) => c !== this.car);
    this.car = null;
    this.driver.stop();
    this._release();
    this.state = "idle";
  }

  _release() {
    if (this.loaded) this.hooks.kinds.release([KIND]);
    this.loaded = false;
  }

  // --- Finding the way ---------------------------------------------------------

  // Which side of the road it drives on there.
  _lane(p) {
    const isl = this.world.islandAt(p.x, p.z);
    return (isl ? isl.def.drive : (p.drive ?? "right")) === "left" ? -LANE_OFFSET : LANE_OFFSET;
  }

  // The way from (x, z) to the road point nearest your car. Coming up behind
  // you it ends a few metres short, so the truck stops behind you; coming the
  // other way it runs right up, so the truck stops alongside, in its own lane.
  _routeTo(x, z) {
    const v = this.vehicle;
    const route = this.navigator.route(x, z, v.x, v.z);
    if (!route) return null;
    const p = route.points;
    const n = p.length;
    if (n > SHORT + 3 && (p[n - 1].x - p[n - 3].x) * Math.sin(v.heading) + (p[n - 1].z - p[n - 3].z) * Math.cos(v.heading) > 0) p.length -= SHORT;
    this.target.x = v.x;
    this.target.z = v.z;
    return route;
  }

  // Where to set off from: a road point NEAR to FAR metres' drive from
  // (x, z), out of the camera's view if any is (behind it best). `heading`
  // and `way`: points behind that heading (way -1) are better, so it comes
  // up behind you; points ahead of it (way 1) come first, so it drives on.
  _start(x, z, heading, way) {
    let best = null;
    let bestScore = Infinity;
    for (const p of this.navigator.around(x, z, NEAR, FAR)) {
      const off = this._offView(p.x, p.z);
      let score = (off > 0.15 ? 0 : 1000) - off * 40 + Math.abs(p.d - 320) * 0.2;
      if (((p.x - x) * Math.sin(heading) + (p.z - z) * Math.cos(heading)) * way < 0) score += way > 0 ? 2000 : 300;
      if (score < bestScore) {
        bestScore = score;
        best = p;
      }
    }
    return best;
  }

  // How far (radians, across) a point is outside the camera's view: below 0 it's in view.
  _offView(x, z) {
    const cam = this.hooks.camera();
    const p = cam.globalPosition;
    const f = this._dir;
    cam.getDirectionToRef(AXIS_Z, f);
    const dx = x - p.x;
    const dz = z - p.z;
    const angle = Math.abs(Math.atan2(dx * f.z - dz * f.x, dx * f.x + dz * f.z));
    return angle - Math.atan(Math.tan(cam.fov / 2) * cam.getEngine().getAspectRatio(cam));
  }

  // Moves it `n` road points further along its way (stuck out of sight).
  _skipAhead(n) {
    const pts = this.driver.route.points;
    const i = Math.min(pts.length - 3, this.driver.progress + n);
    if (i < 0) return;
    const b = this.body;
    b.heading = Math.atan2(pts[i + 2].x - pts[i].x, pts[i + 2].z - pts[i].z);
    const lane = this._lane(pts[i]);
    b.x = pts[i].x + Math.cos(b.heading) * lane;
    b.z = pts[i].z - Math.sin(b.heading) * lane;
    b.speed = b.forwardSpeed = b.vx = b.vz = b.steer = 0;
    this.driver.progress = i;
    this.slow = 0;
  }

  // --- Moving ------------------------------------------------------------------

  // The truck's own sums: engine (as vehicle.js at that throttle), air and
  // rolling resistance, brakes, backing up (to turn round); steering toward
  // the wheel angle asked for, no faster than a real rack.
  _move(ctl, dt) {
    const b = this.body;
    const s = SPEC;
    let v = b.forwardSpeed;
    let push = 0; // the engine (m/s², + forwards)
    let stop = 0; // the brakes (m/s², towards standing still)
    if (ctl.throttle > 0) {
      if (v > -0.8) push += (ctl.throttle * Math.min(s.maxDrive, s.power / Math.max(Math.abs(v), 1))) / s.mass;
      else stop += ctl.throttle * BRAKE;
    }
    if (ctl.reverse > 0) {
      if (v > 0.8) stop += ctl.reverse * BRAKE;
      else if (v > -8) push -= ctl.reverse * BACK;
    }
    if (ctl.brake > 0) stop += ctl.brake * BRAKE;
    if (ctl.handbrake) stop += 0.4 * BRAKE;
    stop += (s.drag * v * v + ROLLING * Math.abs(v)) / s.mass;
    v += push * dt;
    // (Brakes and drag slow it to a standstill, never past it.)
    v = v > 0 ? Math.max(0, v - stop * dt) : Math.min(0, v + stop * dt);
    const speed = Math.abs(v);
    const maxSteer = clamp((12.5 * b.L) / Math.max(speed * speed, 1), 0.04, 0.6);
    const target = clamp(ctl.steerAngle ?? 0, -maxSteer, maxSteer);
    const rack = lerp(2.4, 0.6, clamp(speed / 35, 0, 1));
    b.steer += clamp(target - b.steer, -rack * dt, rack * dt);
    b.heading += ((v * Math.tan(b.steer)) / b.L) * dt;
    b.vx = Math.sin(b.heading) * v;
    b.vz = Math.cos(b.heading) * v;
    b.x += b.vx * dt;
    b.z += b.vz * dt;
    b.forwardSpeed = v;
    b.speed = speed;
  }

  // Where the traffic draws it: on the ground, tilted with the road.
  _place() {
    const b = this.body;
    const c = this.car;
    const fx = Math.sin(b.heading) * b.length * 0.35;
    const fz = Math.cos(b.heading) * b.length * 0.35;
    const front = this.world.getHeight(b.x + fx, b.z + fz);
    const back = this.world.getHeight(b.x - fx, b.z - fz);
    c.x = b.x;
    c.z = b.z;
    c.y = (front + back) / 2 + 0.04;
    c.yaw = b.heading;
    c.pitch = -Math.atan2(front - back, b.length * 0.7);
    c.speed = b.speed;
  }
}
