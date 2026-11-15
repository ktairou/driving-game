import { GARAGE } from "./garage.js";
import { CAR_COLOURS } from "./traffic.js";
import { AutoDriver, raceProfile } from "./navigation.js";
import { pickRivals } from "./race.js";
import { clamp, lerp } from "./noise.js";
import { ROAD_HALF_WIDTH, ROAD_SAMPLE_STEP } from "./world/layout.js";
import { startAt } from "./world/streetRaces.js";
import { LEVEL_NAMES, PLACES, TITLES, MEDALS, betterMedal, raceButton, raceChip, startPanel, resultCard } from "./raceUi.js";

// Street races: you against three cars from a start gate near one landmark
// to a finish near another, through glowing gates along the way. One race at
// a time: idle -> (loading the other cars) -> staged -> countdown -> running
// -> finished, then Race again or Leave.
//
// The other cars are drawn by the traffic (as cars with `racing: true`, which
// the traffic leaves alone). Each is steered by its own self-driver in racing
// mode (navigation.js) along the race route, and moved here with the same
// engine and drag sums as your car (vehicle.js), as a simple body that follows
// the road: no bumping into walls, so nothing can get stuck.

// Each level: how hard the other drivers corner (m/s² sideways) and brake
// (m/s²), how fast they go through towns (m/s), and their engines compared
// with yours (they're matched to your car's power for its weight first).
const LEVELS = {
  easy: { lat: 5.2, brake: 5.5, town: 16, power: 0.9 },
  medium: { lat: 6.6, brake: 6.8, town: 20, power: 1.0 },
  hard: { lat: 8, brake: 8.2, town: 25, power: 1.08 },
};
const TOP = 95; // m/s: no cap of their own beyond what their engines can do
const ROLLING = 32; // rolling resistance, as in vehicle.js
const BRAKE = 11; // m/s² at full brake (vehicle.js: 15000 N per 1350 kg)
const STAGED_FOR = 1.2; // seconds lined up before the first amber
const AMBER_GAP = 0.5;
const PENALTY = 1; // seconds added for a false start
const HOLD_TRAFFIC = 3; // seconds after green the traffic keeps waiting
const GATE_SPACING = 450; // metres between gates, roughly
const OFF_ROUTE = 40; // metres from the route before we say you've left it
const SAY_AGAIN = 8; // seconds between reminders
const STILL = { steerAngle: 0, throttle: 0, brake: 1, handbrake: true };

const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;

export class StreetRace {
  // hooks: { entry() -> your garage entry, place(x, z, heading), toast(text),
  //   ready() -> may a race be offered now, onStart(), guide(route, name) (null
  //   to clear), kinds: { load(id), release(ids) }, earn?(place, level) -> credits }
  constructor({ world, navigator, vehicle, traffic, audio, fuel, settings, save, parts, hooks }) {
    Object.assign(this, { world, navigator, vehicle, traffic, audio, fuel, settings, save, parts, hooks });
    this.state = "idle";
    this.race = null;
    this.plan = null;
    this.rivals = [];
    this.loaded = new Set();
    this.plans = new Map(); // routes and gates per race, worked out the first time
    this.level = LEVELS[settings.raceLevel] ? settings.raceLevel : "medium";
    // You, as the other drivers see you (so they don't drive into you).
    this.youCar = { moving: true, x: 0, z: 0, yaw: 0, speed: 0, type: { length: 4.6 } };
    this.others = [this.youCar];
    this._ctl = { steer: 0, throttle: 0, brake: 1, reverse: 0, handbrake: true, steerAnalog: false };
    this._buttonShown = false;
    this._buildUi();
  }

  get active() {
    return this.state !== "idle";
  }

  // --- On screen ---------------------------------------------------------------

  _buildUi() {
    this.button = raceButton(() => this.open());
    this.chipUi = raceChip({ gates: true });
    this.panelUi = startPanel({
      title: "Street race",
      note: "",
      onLevel: (v) => {
        this.level = v;
        this.settings.raceLevel = v;
        this.save(this.settings);
        this.panelUi.markLevel(v);
      },
      onStart: () => this.start(),
    });
    this.resultUi = resultCard({ onAgain: () => this.again(), onLeave: () => this.leave() });
  }

  // Your best on a race, in words (for the panel and the map list).
  bestText(r) {
    const best = this.settings.races[r.id]?.best;
    if (!best) return "";
    const car = GARAGE.find((g) => g.id === best.car);
    return `Best ${fmt(best.time)}${car ? ` · ${car.name}` : ""}`;
  }

  // Tapping Race at a start gate: check there's fuel, then show the panel.
  open() {
    const r = startAt(this.vehicle.x, this.vehicle.z);
    if (!r || this.active || this._lowFuel()) return;
    this.race = r;
    // (The same level as last time, whichever kind of race that was.)
    if (LEVELS[this.settings.raceLevel]) this.level = this.settings.raceLevel;
    this.panelUi.markLevel(this.level);
    const best = this.bestText(r);
    this.panelUi.show({
      what: `${r.name}, ${(r.length / 1000).toFixed(1)} km. Race three cars there. Drive through every gate on the way. Wait for the green light, then go!`,
      best: best ? `Your ${best.replace("Best", "best:").replace(" · ", " in the ")}` : "No best time here yet.",
    });
  }

  _lowFuel() {
    if (this.fuel.auto || Math.round(this.fuel.level * 100) > 10) return false;
    this.hooks.toast(this.fuel.electric ? "Too little charge to race. Charge up first (see the map)" : "Too little fuel to race. Fill up first (see the map)");
    return true;
  }

  // --- The route and its gates (worked out once per race) --------------------

  _plan(r) {
    if (this.plans.has(r.id)) return this.plans.get(r.id);
    const legs = [r.start, ...r.via, r.finish];
    const points = [];
    for (let k = 0; k + 1 < legs.length; k++) {
      const leg = this.navigator.route(legs[k][0], legs[k][1], legs[k + 1][0], legs[k + 1][1]);
      if (!leg) return null;
      if (points.length) leg.points.shift();
      points.push(...leg.points);
    }
    const finishIdx = points.length - 1;
    // The other cars carry on past the finish, so they cross it at speed.
    const run = this.navigator.route(r.finish[0], r.finish[1], r.runout[0], r.runout[1]);
    const theirs = points.concat(run ? run.points.slice(1) : []);
    // The start line, and gates spread evenly from there to the finish (off junctions).
    let line = 0;
    let lineD = Infinity;
    for (let i = 0; i < Math.min(60, points.length); i++) {
      const d = (points[i].x - r.x) ** 2 + (points[i].z - r.z) ** 2;
      if (d < lineD) {
        lineD = d;
        line = i;
      }
    }
    const count = clamp(Math.round(((finishIdx - line) * ROAD_SAMPLE_STEP) / GATE_SPACING), 4, 8);
    const gates = [];
    for (let k = 1; k <= count; k++) {
      let i = line + Math.round(((finishIdx - line) * k) / count);
      if (k < count) i = this._offJunctions(points, i);
      const a = points[Math.max(0, i - 2)];
      const b = points[Math.min(points.length - 1, i + 2)];
      const l = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const p = points[i];
      gates.push({ index: i, x: p.x, y: p.y, z: p.z, tx: (b.x - a.x) / l, tz: (b.z - a.z) / l, yaw: Math.atan2(b.x - a.x, b.z - a.z) });
    }
    const plan = { points, finishIdx, line, gates, route: { points, length: finishIdx * ROAD_SAMPLE_STEP }, theirs: { points: theirs, length: theirs.length * ROAD_SAMPLE_STEP }, profiles: {} };
    this.plans.set(r.id, plan);
    return plan;
  }

  // A gate spot near route point i that isn't across a junction.
  _offJunctions(points, i) {
    const near = (j) => this.world.network.isNearMeeting(points[j].x, points[j].z, 22);
    if (!near(i)) return i;
    for (let k = 4; k <= 40; k += 4) {
      for (const j of [i + k, i - k]) if (j > 10 && j < points.length - 10 && !near(j)) return j;
    }
    return i;
  }

  // --- Starting, again, leaving ----------------------------------------------

  async start() {
    this.panelUi.el.hidden = true;
    if (!this.race || this.active) return;
    const plan = this._plan(this.race);
    if (!plan) {
      this.hooks.toast("Couldn't find the way for this race");
      return;
    }
    this.plan = plan;
    this.hooks.onStart();
    this.state = "loading";
    const token = (this._token = {});
    const rivals = pickRivals(this.hooks.entry());
    // The rivals' kinds of vehicle (at most three new ones, loaded now if they
    // aren't already on the roads, and let go again after the race).
    const mine = new Set();
    const types = [];
    for (const g of rivals) {
      const id = g.model ?? "gt";
      const had = !!this.traffic.type(id);
      const got = await this.hooks.kinds.load(id);
      if (!had && got === id) mine.add(id);
      types.push(this.traffic.type(got));
    }
    if (this._token !== token) {
      // Called off while loading.
      this.hooks.kinds.release([...mine]);
      return;
    }
    for (const id of mine) this.loaded.add(id);
    this.rivals = rivals.map((g, i) => {
      const type = types[i];
      const length = type.length ?? 4.6;
      const car = { moving: true, racing: true, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, speed: 0, stopTimer: 0, type, colour: CAR_COLOURS[(i * 3 + 2) % CAR_COLOURS.length] };
      // What the self-driver needs to know about the car it drives.
      const body = { x: 0, z: 0, heading: 0, speed: 0, forwardSpeed: 0, vx: 0, vz: 0, impact: 0, steer: 0, L: length * 0.6, a: length * 0.3, b: length * 0.3, halfTrack: (type.halfWidth ?? 1) * 0.85, length };
      return { entry: g, spec: g.spec, car, body, driver: new AutoDriver(this.world, null), k: 1 };
    });
    this._stage();
  }

  // Everyone on the grid, the lights off, the clock at zero.
  _stage() {
    const r = this.race;
    const plan = this.plan;
    const level = LEVELS[this.level];
    // How fast they can go at each point of the route (wet roads: slower).
    const grip = this.vehicle.gripScale;
    const key = `${this.level}-${grip.toFixed(2)}`;
    plan.profiles[key] ??= raceProfile(plan.theirs.points, { lat: level.lat * grip, brake: level.brake * grip, town: level.town, top: TOP });
    const profile = plan.profiles[key];
    const you = r.slots.find((s) => s.you);
    this.hooks.place(you.x, you.z, you.heading);
    const spec = this.hooks.entry().spec;
    const mine = spec.power / spec.mass;
    const theirs = r.slots.filter((s) => !s.you);
    this.rivals.forEach((ai, k) => {
      const s = theirs[k];
      const b = ai.body;
      b.x = s.x;
      b.z = s.z;
      b.heading = s.heading;
      b.speed = b.forwardSpeed = b.vx = b.vz = b.steer = 0;
      // Engines matched to yours for its weight, then the level's share, a
      // little different every time.
      ai.k = clamp(mine / (ai.spec.power / ai.spec.mass), 0.6, 1.8) * level.power * (1 + (Math.random() - 0.5) * 0.04);
      ai.driver.startRace(plan.theirs, { profile, self: ai.car, others: this.others });
      ai.time = null;
      ai.prevAlong = NaN;
      ai.done = false;
      ai.gone = false;
      ai.slow = 0;
      if (!this.traffic.cars.includes(ai.car)) this.traffic.cars.push(ai.car);
      this._moveCar(ai);
    });
    // Traffic out of the way of the grid, and waiting outside it until the start.
    this.traffic.clearAround(r.tx, r.tz, 50);
    this.traffic.hold = { x: r.tx, z: r.tz, r: 30 };
    this.state = "staged";
    this.clock = 0;
    this.greenAt = STAGED_FOR + 3 * AMBER_GAP;
    this.lights = 0;
    this.falseStart = false;
    this.youTime = null;
    this.dnf = false;
    this.top = 0;
    this.next = 0;
    this.youIdx = plan.line;
    this.prevAlong = NaN;
    this.offRoute = false;
    this.offSaid = 0;
    this.searchTimer = 0;
    this.resultIn = null;
    this.place = 0;
    this.giveUp = 60 + r.length / 8;
    this._shown = { clock: null, place: null, gate: null };
    this.chipUi.lights(0, false);
    this.parts.showCheckpoints(plan.gates, 0);
    this.hooks.guide(plan.route, r.name);
    this.resultUi.el.hidden = true;
    this.chipUi.el.hidden = false;
    this.button.hidden = true;
    this._buttonShown = false;
  }

  again() {
    if (this.state !== "finished" || this._lowFuel()) return;
    this._stage();
  }

  // Back to driving, from wherever you've got to.
  leave() {
    this.end();
  }

  // Ends the race wherever it's got to (also when you open the map, get out...).
  end() {
    if (this.state === "idle") return;
    this._token = null;
    this.traffic.cars = this.traffic.cars.filter((c) => !c.racing);
    this.rivals = [];
    this.hooks.kinds.release([...this.loaded]);
    this.loaded.clear();
    this.traffic.hold = null;
    this.parts.hideCheckpoints();
    this.hooks.guide(null);
    this.state = "idle";
    this.panelUi.el.hidden = true;
    this.resultUi.el.hidden = true;
    this.chipUi.el.hidden = true;
  }

  // --- Each frame ------------------------------------------------------------

  // Your car's controls: held on the brake until green (pressing the gas
  // before then is a false start), yours while racing, and slowing to a stop
  // by itself once you're over the line (the steering stays yours).
  controls(input) {
    const c = this._ctl;
    if (this.state === "loading" || this.state === "staged" || this.state === "countdown") {
      if (this.state === "countdown" && input.throttle > 0 && !this.falseStart) {
        this.falseStart = true;
        this.chipUi.lights(this.lights, true);
        this.hooks.toast("False start! 1 second added");
      }
      c.steer = 0;
      c.steerAnalog = false;
      c.throttle = 0;
      c.brake = 1;
      c.handbrake = true;
      return c;
    }
    if (this.youTime === null && !this.dnf) return input;
    const v = this.vehicle.forwardSpeed;
    c.steer = input.steer;
    c.steerAnalog = input.steerAnalog;
    c.throttle = 0;
    c.brake = v > 0.3 ? 0.35 : 1;
    c.handbrake = v <= 0.3;
    return c;
  }

  update(dt) {
    if (this.state === "idle") {
      this._idle();
      return;
    }
    if (this.state === "loading") return;
    this.clock += dt;
    const v = this.vehicle;
    const yc = this.youCar;
    yc.x = v.x;
    yc.z = v.z;
    yc.yaw = v.heading;
    yc.speed = v.speed;
    yc.type.length = v.length;
    if (this.state === "staged" || this.state === "countdown") {
      // Three ambers half a second apart, then green.
      const n = Math.min(4, Math.max(0, Math.floor((this.clock - STAGED_FOR) / AMBER_GAP) + 1));
      if (n !== this.lights) {
        this.lights = n;
        this.chipUi.lights(n, this.falseStart);
        if (this.audio.ctx) this.audio.beep(n === 4);
        if (n >= 1) this.state = "countdown";
        if (n === 4) this.state = "running";
      }
    }
    if (this.state !== "running" && this.state !== "finished") return this._hud(0);
    const t = this.clock - this.greenAt;
    if (this.traffic.hold && t > HOLD_TRAFFIC) this.traffic.hold = null;
    for (const ai of this.rivals) this._driveRival(ai, dt, t);
    if (this.youTime === null && !this.dnf) {
      this.top = Math.max(this.top, v.speed);
      this._track(dt, t);
      if (this.youTime === null && t > this.giveUp) {
        this.dnf = true;
        this._finish();
      }
    }
    if (this.resultIn !== null) {
      this.resultIn -= dt;
      if (this.resultIn <= 0) {
        this.resultIn = null;
        this.resultUi.el.hidden = false;
      }
    }
    // Where you are in the race, while it's on: rivals over the line, or further along.
    if (this.state === "running") {
      let ahead = 0;
      for (const ai of this.rivals) if (ai.time !== null || ai.driver.progress > this.youIdx) ahead++;
      this.place = ahead;
    }
    this._hud(t);
  }

  // Through the next gate (in order), over the finish, and whether you've
  // left the route.
  _track(dt, t) {
    const v = this.vehicle;
    const gates = this.plan.gates;
    const g = gates[this.next];
    const rx = v.x - g.x;
    const rz = v.z - g.z;
    const along = rx * g.tx + rz * g.tz;
    const side = rx * g.tz - rz * g.tx;
    const p = this.prevAlong;
    this.prevAlong = along;
    // (Driven over it, not put past it: a slow frame at speed covers a lot of ground.)
    if (p < 0 && along >= 0 && along - p < 6 + v.speed * dt * 1.5 && Math.abs(side) < ROAD_HALF_WIDTH + 5) {
      if (this.next === gates.length - 1) {
        // Timed to the moment your car's middle crossed the line.
        const crossed = t - dt + (dt * -p) / Math.max(1e-6, along - p);
        this.youTime = crossed + (this.falseStart ? PENALTY : 0);
        this._finish();
        return;
      }
      this.next++;
      this.prevAlong = NaN;
      this.offRoute = false;
      this.parts.showCheckpoints(gates, this.next);
    }
    this._findYou(dt);
  }

  // How far along the route you are (only up to the next gate: skipping one
  // doesn't count), and saying so when you're well off it.
  _findYou(dt) {
    const pts = this.plan.points;
    const v = this.vehicle;
    const until = this.plan.gates[this.next].index;
    let best = this.youIdx;
    let bestD = Infinity;
    for (let i = Math.max(0, this.youIdx - 5); i <= Math.min(until, this.youIdx + 30); i++) {
      const d = (pts[i].x - v.x) ** 2 + (pts[i].z - v.z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (bestD < 30 * 30) {
      this.youIdx = best;
      this.offRoute = false;
      return;
    }
    // Lost the thread: look along the whole stretch to the next gate, now and then.
    this.searchTimer -= dt;
    if (this.searchTimer > 0) return;
    this.searchTimer = 0.3;
    const from = this.next ? this.plan.gates[this.next - 1].index - 20 : 0;
    for (let i = Math.max(0, from); i <= until; i++) {
      const d = (pts[i].x - v.x) ** 2 + (pts[i].z - v.z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (bestD < OFF_ROUTE * OFF_ROUTE) {
      this.youIdx = best;
      this.offRoute = false;
      return;
    }
    if (!this.offRoute || this.clock - this.offSaid > SAY_AGAIN) {
      this.offRoute = true;
      this.offSaid = this.clock;
      const last = this.next === this.plan.gates.length - 1;
      this.hooks.toast(`You're off the route. Follow the blue line to ${last ? "the finish" : `gate ${this.next + 1}`}`);
    }
  }

  // One rival: its self-driver steers, the sums move it, and it's timed over the line.
  _driveRival(ai, dt, t) {
    if (ai.gone) return;
    const b = ai.body;
    const car = ai.car;
    // Bumped by you: it loses a little speed.
    if (car.stopTimer > 0) {
      b.speed *= 0.85;
      car.stopTimer = 0;
    }
    const driver = ai.driver;
    const ctl = driver.active ? driver.drive(b, this.traffic, dt) : STILL;
    if (!driver.active) ai.done = true;
    this._move(ai, ctl, dt);
    if (ai.time === null) {
      const f = this.plan.gates[this.plan.gates.length - 1];
      const rx = b.x - f.x;
      const rz = b.z - f.z;
      const along = rx * f.tx + rz * f.tz;
      const p = ai.prevAlong;
      ai.prevAlong = along;
      if (p < 0 && along >= 0 && along - p < 6 + b.speed * dt * 1.5 && Math.abs(rx * f.tz - rz * f.tx) < ROAD_HALF_WIDTH + 5) ai.time = t - dt + (dt * -p) / Math.max(1e-6, along - p);
    }
    if (driver.active) {
      // Somehow well off the route, or stuck for a long while out of sight: back onto it.
      ai.slow = b.speed < 0.5 ? ai.slow + dt : 0;
      const far = Math.hypot(b.x - this.vehicle.x, b.z - this.vehicle.z) > 80;
      if (driver.offBy > 25 || (ai.slow > 10 && far)) this._putBack(ai, ai.slow > 10 ? 10 : 2);
    } else if (Math.hypot(b.x - this.vehicle.x, b.z - this.vehicle.z) > 150) {
      // Finished, stopped and out of sight: gone home.
      this.traffic.cars = this.traffic.cars.filter((c) => c !== car);
      ai.gone = true;
      return;
    }
    this._moveCar(ai);
  }

  // The car's own sums: engine (as vehicle.js at that throttle), air and
  // rolling resistance, brakes; steering toward the wheel angle asked for, no
  // faster than a real rack, and no more than the tyres allow at speed.
  _move(ai, ctl, dt) {
    const b = ai.body;
    const s = ai.spec;
    const mass = s.mass ?? 1350;
    const v = b.speed;
    let a = -((s.drag ?? 0.42) * v * v + ROLLING * v) / mass;
    if (ctl.throttle > 0) a += (ctl.throttle * ai.k * Math.min(s.maxDrive ?? 10500, (s.power ?? 300000) / Math.max(v, 1))) / mass;
    if (ctl.brake > 0 || ctl.handbrake) a -= (ctl.brake + (ctl.handbrake ? 0.4 : 0)) * BRAKE * this.vehicle.gripScale;
    b.speed = Math.max(0, v + a * dt);
    const maxSteer = clamp((12.5 * b.L) / Math.max(b.speed * b.speed, 1), 0.04, 0.6);
    const target = clamp(ctl.steerAngle ?? 0, -maxSteer, maxSteer);
    const rack = lerp(2.4, 0.6, clamp(b.speed / 35, 0, 1));
    b.steer += clamp(target - b.steer, -rack * dt, rack * dt);
    b.heading += ((b.speed * Math.tan(b.steer)) / b.L) * dt;
    b.vx = Math.sin(b.heading) * b.speed;
    b.vz = Math.cos(b.heading) * b.speed;
    b.x += b.vx * dt;
    b.z += b.vz * dt;
    b.forwardSpeed = b.speed;
  }

  // Back on the route `ahead` points on from where its driver had got to.
  _putBack(ai, ahead) {
    const pts = this.plan.theirs.points;
    const i = Math.min(pts.length - 3, ai.driver.progress + ahead);
    const b = ai.body;
    b.x = pts[i].x;
    b.z = pts[i].z;
    b.heading = Math.atan2(pts[i + 2].x - pts[i].x, pts[i + 2].z - pts[i].z);
    b.speed = Math.min(b.speed, 8);
    b.steer = 0;
    ai.driver.progress = i;
    ai.slow = 0;
  }

  // Where the traffic draws it: on the ground, tilted with the road.
  _moveCar(ai) {
    const b = ai.body;
    const c = ai.car;
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

  _hud(t) {
    // (Only touches the page when what it shows changes.)
    const shown = this.youTime ?? (this.dnf ? null : Math.max(0, t));
    const tenths = shown === null ? -1 : Math.round(shown * 10);
    if (tenths !== this._shown.clock) {
      this._shown.clock = tenths;
      this.chipUi.clock.textContent = shown === null ? "--" : fmt(tenths / 10);
    }
    const place = this.state === "running" || this.state === "finished" ? this.place : -1;
    if (place !== this._shown.place) {
      this._shown.place = place;
      this.chipUi.place.textContent = place < 0 ? "" : PLACES[place];
    }
    const gate = this.youTime === null && !this.dnf ? this.next : -1;
    if (gate !== this._shown.gate) {
      this._shown.gate = gate;
      const n = this.plan.gates.length;
      this.chipUi.gates.textContent = gate < 0 ? "" : gate === n - 1 ? "Finish next" : `Gate ${gate + 1} of ${n - 1}`;
    }
  }

  // Over the line (or out of time): work out the places, save bests, show the card.
  _finish() {
    const r = this.race;
    this.state = "finished";
    this.parts.hideCheckpoints();
    const entry = this.hooks.entry();
    // Everyone over the line in time order, then those still racing, furthest along first.
    const list = this.rivals.map((ai) => ({ name: ai.entry.name, time: ai.time ?? Infinity, along: ai.driver.progress }));
    list.push({ name: "You", you: true, time: this.dnf ? Infinity : this.youTime, along: this.dnf ? -1 : Infinity });
    list.sort((a, b) => a.time - b.time || b.along - a.along);
    const place = this.dnf ? -1 : list.findIndex((x) => x.you);
    this.place = Math.max(0, place);
    let newBest = false;
    let earned = 0;
    if (!this.dnf) {
      const rec = (this.settings.races[r.id] ??= { best: null, cars: {} });
      rec.cars ??= {};
      const mine = (rec.cars[entry.id] ??= {});
      newBest = !rec.best || this.youTime < rec.best.time;
      if (newBest) rec.best = { time: +this.youTime.toFixed(3), car: entry.id };
      if (!mine.time || this.youTime < mine.time) mine.time = +this.youTime.toFixed(3);
      const medal = MEDALS[place];
      if (medal) {
        mine.medal = betterMedal(mine.medal, medal);
        rec.medal = betterMedal(rec.medal, medal);
      }
      earned = this.hooks.earn?.(place, this.level) ?? 0;
      this.save(this.settings);
    }
    this._showResult(list, place, newBest, earned);
    this.resultIn = 1.3;
  }

  _showResult(list, place, newBest, earned) {
    const units = this.settings.units === "mph" ? ["mph", 2.23694] : ["km/h", 3.6];
    const winner = list[0];
    let gap;
    if (this.dnf) gap = "Didn't finish";
    else if (place === 0) gap = Number.isFinite(list[1].time) ? `Won by ${(list[1].time - this.youTime).toFixed(1)} s` : "Way ahead";
    else gap = `${(this.youTime - winner.time).toFixed(1)} s behind`;
    const notes = [];
    if (this.falseStart) notes.push("False start: 1 second added.");
    if (newBest) notes.push("New best on this race!");
    if (earned) notes.push(`+${earned} credits.`);
    this.resultUi.fill({
      place,
      title: this.dnf ? "Out of time" : TITLES[place],
      sub: `${this.race.name} · ${LEVEL_NAMES[this.level]}`,
      stats: [
        ["Your time", this.dnf ? "--" : fmt(this.youTime)],
        ["Top speed", `${Math.round(this.top * units[1])} ${units[0]}`],
        [place === 0 ? "Gap" : "To the winner", gap],
      ],
      notes,
      rows: list.map((x) => ({ name: x.name, time: Number.isFinite(x.time) ? fmt(x.time) : x.you ? "--" : "Still racing", you: x.you })),
    });
  }

  // --- When there's no race --------------------------------------------------

  _idle() {
    // The Race button, when you're stopped at a start gate.
    const show = this.hooks.ready() && this.vehicle.speed < 0.8 && !!startAt(this.vehicle.x, this.vehicle.z);
    if (show !== this._buttonShown) {
      this._buttonShown = show;
      this.button.hidden = !show;
      if (!show) this.panelUi.el.hidden = true;
    }
  }
}
