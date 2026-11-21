import { GARAGE } from "./garage.js";
import { PLACES, TITLES, MEDALS, betterMedal, raceButton, raceChip, startPanel, resultCard } from "./raceUi.js";
import { BRAKE_LEVELS, score, metres, stopText, timeAllowed, planRival, stepRival } from "./brakeTest.js";
import { CAR_COLOURS } from "./traffic.js";
import { DRAG_STRIPS } from "./world/layout.js";
import { STAGE, FINISH, BOARD_DISTANCE, laneW, stripPoint, stagingAt, setLamps, drawBoard } from "./world/dragstrips.js";

// Drag races: you against five cars over a half mile on a drag strip. The
// same strips also run brake tests (brakeTest.js): go on green, then stop on
// the finish line; you pick which at the start panel.
// One race at a time: idle -> (loading the other cars) -> staged ->
// countdown -> running -> finished, then Race again or Leave.
//
// The other cars are drawn by the traffic (as cars with `racing: true`, which
// the traffic leaves alone) and moved here, in a straight line, with the same
// sums as your car's physics (vehicle.js) at full throttle.

// Each level: the others' reaction time, and how far behind your best
// possible time (flat out from the very instant of green) each of the five
// finishes, in seconds. Shared out at random every race, so a different car
// is quickest each time, and give or take a little. So a sharp start beats
// them all, and a slow one drops you down the field: on Easy you win unless
// you're very late away; on Medium a good start wins and a fair one is in
// the top three; on Hard only a sharp one wins.
const LEVELS = {
  easy: { name: "Easy", reaction: 0.45, gaps: [0.55, 0.8, 1.05, 1.35, 1.7] },
  medium: { name: "Medium", reaction: 0.3, gaps: [0.25, 0.42, 0.6, 0.8, 1.05] },
  hard: { name: "Hard", reaction: 0.18, gaps: [0.17, 0.24, 0.31, 0.39, 0.5] },
};
const GAP_JITTER = 0.24; // each finish is up to half this sooner or later
const STEP = 1 / 120; // the same physics step as vehicle.js
const ROLLING = 32; // rolling resistance, as in vehicle.js
const RUN = FINISH - STAGE; // the half mile: 805 m
const STAGED_FOR = 1.2; // seconds lined up before the first amber
const AMBER_GAP = 0.5;
const PENALTY = 1; // seconds added for a false start
const GIVE_UP = 75; // still not over the line this long after green: the race is over (the slowest lorry takes about 40 s)
const STOP_SHORT = 24; // everyone stops this far before the end of the run-off
const YOU = 3; // your lane, one of the middle two
const THEIR_LANES = [4, 2, 5, 1, 6]; // the nearest match in power beside you
const NEW_KINDS = 3; // at most this many kinds of vehicle loaded just for a race (each costs graphics memory)
const FAR = 1.2; // rivals with over about three times more (or less) power for their weight than yours are too far off
// Paint for a second (or third) of a kind of vehicle in one race: it
// multiplies the vehicle's own colours, so white leaves them as they are.
const WHITE = [1, 1, 1];
const TINTS = [[0.55, 0.72, 1], [1, 0.6, 0.5], [0.62, 1, 0.62]];

// Forward pull at full throttle, less air and rolling resistance, over mass
// (vehicle.js on a flat road, going straight). `k` scales the engine.
function accel(spec, k, v) {
  const drive = k * Math.min(spec.maxDrive ?? 10500, (spec.power ?? 300000) / Math.max(v, 1));
  return (drive - (spec.drag ?? 0.42) * v * v - ROLLING * v) / (spec.mass ?? 1350);
}

// Seconds to cover the half mile from a standstill.
function runTime(spec, k) {
  let x = 0;
  let v = 0;
  let t = 0;
  while (t < 120) {
    v += accel(spec, k, v) * STEP;
    const nx = x + v * STEP;
    if (nx >= RUN) return t + (STEP * (RUN - x)) / (nx - x);
    x = nx;
    t += STEP;
  }
  return t;
}

// The engine scale that makes another vehicle run the half mile in `time`.
// (Slow: some thirty runs. Done once per rival per race.)
function matchEngine(spec, time) {
  let lo = 0.1;
  let hi = 10;
  for (let i = 0; i < 26; i++) {
    const mid = Math.sqrt(lo * hi);
    if (runTime(spec, mid) > time) lo = mid;
    else hi = mid;
  }
  return Math.sqrt(lo * hi);
}

// From an engine scale `k` that runs the half mile in `t0`, the one that
// runs it in `time` (near it): the time goes as about k to the power -0.4,
// and two quick corrections land within a hundredth of a second.
function nudgeEngine(spec, k, t0, time) {
  for (let i = 0; i < 2; i++) {
    k *= Math.pow(t0 / time, 2.5);
    t0 = runTime(spec, k);
  }
  return k;
}

// The `n` vehicles nearest yours in power for their weight (so a bus races
// buses and vans, and a sports car races fast cars). With `loaded(kind)` (is that kind of
// vehicle on the roads already?), at most three other kinds are picked, and
// none far off in power: past that the nearest come again, kinds loaded just
// for the race first (they can be painted differently, see start()).
export function pickRivals(entry, n = 3, loaded = null) {
  const pw = (g) => g.spec.power / g.spec.mass;
  const mine = pw(entry);
  const near = GARAGE.filter((g) => g !== entry)
    .map((g) => ({ g, d: Math.abs(Math.log(pw(g) / mine)) }))
    .sort((a, b) => a.d - b.d);
  if (!loaded) return near.slice(0, n).map((o) => o.g);
  const kind = (g) => g.model ?? "gt";
  const picks = [];
  const extra = new Set();
  for (const { g, d } of near) {
    if (picks.length >= n || (picks.length && d > FAR)) break;
    if (!loaded(kind(g)) && !extra.has(kind(g))) {
      if (extra.size >= NEW_KINDS) continue;
      extra.add(kind(g));
    }
    picks.push(g);
  }
  const again = [...picks.filter((g) => extra.has(kind(g))), ...picks.filter((g) => !extra.has(kind(g)))];
  for (let i = 0; picks.length < n; i++) picks.push(again[i % again.length]);
  return picks;
}

const DRAG_NOTE = "Race five cars over half a mile (805 m). Wait for the green light, then go!";
const BRAKE_NOTE = "Go on green, then stop with your front bumper as close to the finish line as you can. You must stop before the time runs out. Going past the line counts double.";

const fmt = (t) => `${t.toFixed(2)} s`;
const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const shortName = (s) => {
  const n = s.name.replace("Drag strip · ", "");
  return n[0].toUpperCase() + n.slice(1);
};

export class DragRace {
  // hooks: { entry() -> your garage entry, place(x, z, heading), toast(text),
  //   ready() -> may a race be offered now, onStart(), kinds: { load(id), release(ids) },
  //   show?: the finish (finishShow.js) }
  constructor({ vehicle, traffic, audio, fuel, settings, save, boardTexture, hooks }) {
    Object.assign(this, { vehicle, traffic, audio, fuel, settings, save, boardTexture, hooks });
    this.state = "idle";
    this.strip = null;
    this.rivals = [];
    this.loaded = new Set(); // kinds of vehicle loaded just for this race
    this.lastRuns = {}; // per strip, for the timing board
    this.level = LEVELS[settings.raceLevel] ? settings.raceLevel : "medium";
    this.kind = settings.stripKind === "brake" ? "brake" : "drag"; // a drag race or a brake test (the last one picked)
    this._ctl = { steer: 0, throttle: 0, brake: 1, reverse: 0, handbrake: true, steerAnalog: false };
    this._boardTimer = 0;
    this._boardFor = undefined;
    this._buttonShown = false;
    this._buildUi();
  }

  get active() {
    return this.state !== "idle";
  }

  // --- On screen ---------------------------------------------------------------

  _buildUi() {
    this.button = raceButton(() => this.open());
    this.chipUi = raceChip();
    this.chip = this.chipUi.el;
    this.clockEl = this.chipUi.clock;
    this.placeEl = this.chipUi.place;
    this.panelUi = startPanel({
      title: "Drag race",
      note: DRAG_NOTE,
      kinds: [["drag", "Drag race"], ["brake", "Brake test"]],
      onKind: (k) => {
        this.kind = k;
        this.settings.stripKind = k;
        this.save(this.settings);
        this._showPanel();
      },
      onLevel: (v) => {
        this.level = v;
        this.settings.raceLevel = v;
        this.save(this.settings);
        this._markLevel();
      },
      onStart: () => this.start(),
    });
    this.panel = this.panelUi.el;
    this.resultUi = resultCard({ onAgain: () => this.again(), onLeave: () => this.leave() });
    this.result = this.resultUi.el;
  }

  _markLevel() {
    this.panelUi.markLevel(this.level);
  }

  // Your best on a strip, in words (for the panel and the map list).
  bestText(s) {
    const best = this.settings.races[s.id]?.best;
    if (!best) return "";
    const car = GARAGE.find((g) => g.id === best.car);
    return `Best ${fmt(best.time)}${car ? ` · ${car.name}` : ""}`;
  }

  // Your closest brake test stop on a strip, in words (for the panel and the map list).
  brakeText(s) {
    const best = this.settings.brakes?.[s.id]?.best;
    if (!best) return "";
    const car = GARAGE.find((g) => g.id === best.car);
    return `Closest stop ${best.dist.toFixed(2)} m${car ? ` · ${car.name}` : ""}`;
  }

  // Tapping Race: check there's fuel, then show the panel.
  open() {
    const s = stagingAt(this.vehicle.x, this.vehicle.z);
    if (!s || this.active) return;
    if (this._lowFuel()) return;
    this.strip = s;
    // (The same level as last time, whichever kind of race that was.)
    if (LEVELS[this.settings.raceLevel]) this.level = this.settings.raceLevel;
    this._markLevel();
    this._showPanel();
  }

  // The start panel, for whichever was picked: a drag race or a brake test.
  _showPanel() {
    const s = this.strip;
    this.panelUi.markKind(this.kind);
    if (this.kind === "brake") {
      const best = this.brakeText(s);
      this.panelUi.show({ title: "Brake test", what: BRAKE_NOTE, best: best ? `Your ${best.replace("Closest stop", "closest stop here:").replace(" · ", " in the ")}` : "No brake test here yet." });
    } else {
      const best = this.bestText(s);
      this.panelUi.show({ title: "Drag race", what: DRAG_NOTE, best: best ? `Your ${best.replace("Best", "best here:").replace(" · ", " in the ")}` : "No best time here yet." });
    }
  }

  _lowFuel() {
    if (this.fuel.auto || Math.round(this.fuel.level * 100) > 10) return false;
    this.hooks.toast(this.fuel.electric ? "Too little charge to race. Charge up first (see the map)" : "Too little fuel to race. Fill up first (see the map)");
    return true;
  }

  // --- Starting, again, leaving ----------------------------------------------

  async start() {
    this.panel.hidden = true;
    if (!this.strip || this.active) return;
    this.hooks.onStart();
    this.state = "loading";
    const token = (this._token = {});
    const entry = this.hooks.entry();
    const rivals = pickRivals(entry, THEIR_LANES.length, (id) => !!this.traffic.type(id));
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
    // Their engines are matched to yours (see _stage), so every race is close
    // whatever you drive; how hard sets how near they come.
    this.yourRun = runTime(entry.spec, 1);
    const matched = new Map(); // (a vehicle that comes twice is worked out once)
    const seen = new Map(); // how many of each kind so far
    this.rivals = rivals.map((g, i) => {
      const type = types[i];
      // The concept car comes in any colour; a second of another kind is
      // painted over (only a kind loaded just for this race: the paint would
      // show on every one on the roads too).
      const nth = seen.get(type) ?? 0;
      seen.set(type, nth + 1);
      let colour = CAR_COLOURS[(i * 3 + 1) % CAR_COLOURS.length];
      if (!type.coloured) {
        if (nth && mine.has(type.id)) this.traffic.colourable(type.id);
        colour = nth ? TINTS[(nth - 1) % TINTS.length] : WHITE;
      }
      const car = { moving: true, racing: true, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, speed: 0, stopTimer: 0, type, colour };
      this.traffic.cars.push(car);
      if (!matched.has(g)) matched.set(g, matchEngine(g.spec, this.yourRun));
      return { entry: g, spec: g.spec, match: matched.get(g), lane: THEIR_LANES[i], car, length: type.length ?? 4.6 };
    });
    this._stage();
  }

  // Everyone on the start line, the lights off, the clock at zero.
  _stage() {
    const s = this.strip;
    const level = LEVELS[this.level];
    const g = this.vehicle.car.geometry;
    const front = g.front ?? g.frontZ + 0.95;
    this.front = front;
    const [x, z] = stripPoint(s, STAGE - front - 0.25, laneW(YOU));
    this.hooks.place(x, z, s.heading);
    if (this.kind === "brake") this._stageBrake(level);
    else this._stageDrag(level);
    this.state = "staged";
    this.clock = 0;
    this.greenAt = STAGED_FOR + 3 * AMBER_GAP;
    this.lights = 0;
    this.falseStart = false;
    this.youTime = null;
    this.dnf = false;
    this.top = 0;
    this.prevFront = STAGE - 0.25;
    this.resultIn = null;
    this.place = 0;
    this._shownClock = null;
    this._shownPlace = null;
    // (Brake tests: where you stopped, whether you've got going yet, out of
    // time, and the car braking itself once you're done.)
    this.stopShort = null;
    this.moved = false;
    this.outOfTime = false;
    this.autoBrake = false;
    this._setLights(0);
    this.result.hidden = true;
    this.chip.hidden = false;
    this.button.hidden = true;
    this._buttonShown = false;
    this._drawBoard(s);
  }

  _stageDrag(level) {
    // Who gets which of the level's gaps behind your best time, this race.
    const gaps = shuffle([...level.gaps]);
    this.rivals.forEach((ai, i) => {
      // Off the line about when the level says, a little different every
      // time; its engine set (from the one matched to yours flat out) to
      // cross the line its gap behind your best.
      ai.reaction = Math.max(0.08, level.reaction + (Math.random() - 0.5) * 0.1);
      const finish = this.yourRun + gaps[i % gaps.length] + (Math.random() - 0.5) * GAP_JITTER;
      ai.k = nudgeEngine(ai.spec, ai.match, this.yourRun, Math.max(1, finish - ai.reaction));
      ai.finish = ai.reaction + runTime(ai.spec, ai.k);
      ai.u0 = STAGE - ai.length / 2 - 0.25;
      ai.x = 0;
      ai.v = 0;
      ai.t = 0;
      ai.over = false;
      this._moveRival(ai);
    });
  }

  // A brake test: the others go about as quick as you (their engines matched
  // to yours, give or take), and each will stop its share of the level's
  // gaps from the line. You get the time your car needs, and plenty more.
  _stageBrake(level) {
    const gaps = shuffle([...BRAKE_LEVELS[this.level]]);
    this.rivals.forEach((ai, i) => {
      ai.reaction = Math.max(0.08, level.reaction + (Math.random() - 0.5) * 0.1);
      ai.k = ai.match * (0.94 + Math.random() * 0.12);
      ai.u0 = STAGE - ai.length / 2 - 0.25;
      ai.x = 0;
      ai.v = 0;
      ai.t = 0;
      // (x is how far its front has come from the start line, which it sits 0.25 m behind.)
      planRival(ai, gaps[i % gaps.length], RUN + 0.25);
      this._moveRival(ai);
    });
    const spec = this.hooks.entry().spec;
    this.limit = timeAllowed(RUN + 0.25, (v) => accel(spec, 1, v));
  }

  again() {
    if (this.state !== "finished" || this._lowFuel()) return;
    this.hooks.show?.stop();
    this._stage();
  }

  // Back to driving at the far end of the run-off, facing the way out.
  leave() {
    const s = this.strip;
    this.end();
    if (!s) return;
    const [x, z] = stripPoint(s, s.length - STOP_SHORT - 6, laneW(YOU));
    this.hooks.place(x, z, s.heading + Math.PI);
  }

  // Ends the race wherever it's got to (also when you open the map, get out...).
  end() {
    if (this.state === "idle") return;
    this.hooks.show?.stop();
    this._token = null;
    this.traffic.cars = this.traffic.cars.filter((c) => !c.racing);
    this.rivals = [];
    this.hooks.kinds.release([...this.loaded]);
    this.loaded.clear();
    if (this.strip) setLamps(this.strip, null, null);
    this.state = "idle";
    this.panel.hidden = true;
    this.result.hidden = true;
    this.chip.hidden = true;
  }

  // --- Each frame ------------------------------------------------------------

  // Your car's controls during a race: held on the brake until green (pressing
  // the gas before then is a false start), yours while racing, and braking to
  // a stop by itself once you're over the line.
  controls(input) {
    const c = this._ctl;
    if (this.state === "loading" || this.state === "staged" || this.state === "countdown") {
      // (No false starts in a brake test: it isn't timed from green.)
      if (this.kind === "drag" && this.state === "countdown" && input.throttle > 0 && !this.falseStart) {
        this.falseStart = true;
        this._setLights(this.lights);
        this.hooks.toast("False start! 1 second added");
      }
      c.steer = 0;
      c.steerAnalog = false;
      c.throttle = 0;
      c.brake = 1;
      c.handbrake = true;
      return c;
    }
    if (this.kind === "brake") {
      // Yours until you stop, go over the line or run out of time; then it
      // stands on the brakes by itself (you can still steer).
      if (this.state === "running" && !this.autoBrake) return input;
      c.steer = input.steer;
      c.steerAnalog = input.steerAnalog;
      c.throttle = 0;
      c.brake = 1;
      c.handbrake = this.vehicle.forwardSpeed <= 0.3;
      return c;
    }
    if (this.youTime === null && !this.dnf) return input;
    const v = this.vehicle.forwardSpeed;
    const room = this.strip.length - STOP_SHORT - this._yourFront();
    c.steer = input.steer;
    c.steerAnalog = input.steerAnalog;
    c.throttle = 0;
    c.brake = v > 0.3 ? Math.min(1, Math.max(0.2, (v * v) / (2 * Math.max(4, room)) / 10 + 0.1)) : 1;
    c.handbrake = v <= 0.3;
    return c;
  }

  // How far down the strip your front bumper is (worked out in place: this
  // runs every frame, so no new objects).
  _yourFront() {
    const s = this.strip;
    return (this.vehicle.x - s.x) * s.fx + (this.vehicle.z - s.z) * s.fz + this.front;
  }

  update(dt) {
    if (this.state === "idle") {
      this._idle(dt);
      return;
    }
    if (this.state === "loading") return;
    const s = this.strip;
    this.clock += dt;
    // Wandered off (or got put somewhere else): the race is off.
    const rx = this.vehicle.x - s.x;
    const rz = this.vehicle.z - s.z;
    const u = rx * s.fx + rz * s.fz;
    const w = rx * s.fz - rz * s.fx;
    if (u < -60 || u > s.length + 60 || Math.abs(w) > 60) {
      this.end();
      this.hooks.toast("Race stopped");
      return;
    }
    if (this.state === "staged" || this.state === "countdown") {
      // Three ambers half a second apart, then green.
      const n = Math.min(4, Math.max(0, Math.floor((this.clock - STAGED_FOR) / AMBER_GAP) + 1));
      if (n !== this.lights) {
        this._setLights(n);
        if (this.audio.ctx) this.audio.beep(n === 4);
        if (n >= 1) this.state = "countdown";
        if (n === 4) this.state = "running";
      }
    }
    if (this.state !== "running" && this.state !== "finished") return this._hud();
    const t = this.clock - this.greenAt;
    if (this.kind === "brake") return this._updateBrake(dt, t, u + this.front);
    for (const ai of this.rivals) this._driveRival(ai, t);
    // You: timed from green to your front bumper crossing the finish line.
    const front = u + this.front;
    if (this.youTime === null && !this.dnf) {
      this.top = Math.max(this.top, this.vehicle.speed);
      if (front >= FINISH && this.prevFront < FINISH) {
        const crossed = t - dt + (dt * (FINISH - this.prevFront)) / Math.max(1e-6, front - this.prevFront);
        this.youTime = crossed + (this.falseStart ? PENALTY : 0);
        this._finish();
      } else if (t > GIVE_UP) {
        this.dnf = true;
        this._finish();
      }
    }
    this.prevFront = front;
    if (this.resultIn !== null) {
      this.resultIn -= dt;
      if (this.resultIn <= 0) {
        this.resultIn = null;
        this.result.hidden = false;
      }
    }
    // Where you are in the race, while it's on.
    if (this.state === "running") {
      const mine = front - STAGE;
      let ahead = 0;
      for (const ai of this.rivals) if (ai.x > mine) ahead++;
      this.place = ahead;
    }
    this._hud(t);
  }

  // Moves one rival along: off the line after its reaction time, flat out to
  // the finish, then braking to a stop near the end of the run-off.
  _driveRival(ai, t) {
    const until = t - ai.reaction;
    const stopAt = this.strip.length - STOP_SHORT - STAGE;
    // (Never into the tyre wall, however fast it came over the line.)
    const last = this.strip.length - 3 - STAGE; // (x is how far its front has come from the start line)
    while (ai.t + STEP <= until) {
      let a;
      if (!ai.over) a = accel(ai.spec, ai.k, ai.v);
      else if (ai.v > 0) a = -Math.min(11, Math.max(2, (ai.v * ai.v) / (2 * Math.max(1, stopAt - ai.x))));
      else a = 0;
      ai.v = Math.max(0, ai.v + a * STEP);
      ai.x += ai.v * STEP;
      ai.t += STEP;
      if (!ai.over && ai.x >= RUN) ai.over = true;
      if (ai.over && ai.x >= last) {
        ai.x = last;
        ai.v = 0;
      }
    }
    this._moveRival(ai);
  }

  _moveRival(ai) {
    const s = this.strip;
    const c = ai.car;
    const u = ai.u0 + ai.x;
    const w = laneW(ai.lane);
    c.x = s.x + s.fx * u + s.fz * w;
    c.z = s.z + s.fz * u - s.fx * w;
    c.y = s.height + 0.06;
    c.yaw = s.heading;
    c.pitch = 0;
    c.speed = ai.v;
  }

  // Lights on the gantry and on screen: 0 = off, 1-3 = that amber, 4 = green.
  _setLights(n) {
    this.lights = n;
    const amber = n >= 1 && n <= 3 ? n : 0;
    const go = n === 4;
    setLamps(this.strip, { amber, green: go, red: this.falseStart }, { amber, green: go, red: false }, YOU);
    this.chipUi.lights(n, this.falseStart);
  }

  _hud(t = 0) {
    if (this.kind === "brake") return this._brakeHud(t, this._yourFront());
    // (Only touches the page when what it shows changes.)
    const shown = this.youTime ?? (this.dnf ? null : Math.max(0, t));
    const hundredths = shown === null ? -1 : Math.round(shown * 100);
    if (hundredths !== this._shownClock) {
      this._shownClock = hundredths;
      this.clockEl.textContent = shown === null ? "--" : (hundredths / 100).toFixed(2);
    }
    const place = this.state === "running" || this.state === "finished" ? this.place : -1;
    if (place !== this._shownPlace) {
      this._shownPlace = place;
      this.placeEl.textContent = place < 0 ? "" : PLACES[place];
    }
  }

  // Over the line (or given up): work out the places, save bests, show the card.
  _finish() {
    const s = this.strip;
    this.state = "finished";
    const entry = this.hooks.entry();
    const list = this.rivals.map((ai) => ({ name: ai.entry.name, time: ai.finish, lane: ai.lane }));
    list.push({ name: "You", you: true, time: this.dnf ? Infinity : this.youTime, lane: YOU });
    list.sort((a, b) => a.time - b.time);
    const place = list.findIndex((r) => r.you);
    this.place = place;
    let newBest = false;
    if (!this.dnf) {
      const rec = (this.settings.races[s.id] ??= { best: null, cars: {} });
      rec.cars ??= {};
      const mine = (rec.cars[entry.id] ??= {});
      newBest = !rec.best || this.youTime < rec.best.time;
      if (newBest) rec.best = { time: +this.youTime.toFixed(3), car: entry.id };
      if (!mine.time || this.youTime < mine.time) mine.time = +this.youTime.toFixed(3);
      const medal = MEDALS[place];
      if (medal && (!mine.medal || MEDALS.indexOf(medal) < MEDALS.indexOf(mine.medal))) mine.medal = medal;
      if (medal && (!rec.medal || MEDALS.indexOf(medal) < MEDALS.indexOf(rec.medal))) rec.medal = medal;
      this.save(this.settings);
    }
    this.lastRuns[s.id] = { kind: "drag", list: [...list].sort((a, b) => a.lane - b.lane) };
    this._drawBoard(s);
    this._showResult(list, place, newBest);
    // The finish (finishShow.js): slow motion, your place, a photo, the top
    // three lined up... then it shows this card. Straight to it if you didn't finish.
    this.resultIn = this.hooks.show?.finish("drag", this, list, place, { fmt, newBest }) ? null : 1.3;
  }

  _showResult(list, place, newBest) {
    const units = this.settings.units === "mph" ? ["mph", 2.23694] : ["km/h", 3.6];
    const winner = list[0];
    let gap;
    if (this.dnf) gap = "Didn't finish";
    else if (place === 0) gap = `Won by ${fmt(list[1].time - this.youTime)}`;
    else gap = `${fmt(this.youTime - winner.time)} behind`;
    const notes = [];
    if (this.falseStart) notes.push("False start: 1 second added.");
    if (newBest) notes.push("New best on this strip!");
    this.resultUi.fill({
      place: this.dnf ? -1 : place,
      title: this.dnf ? "You didn't finish" : TITLES[place],
      sub: `${shortName(this.strip)} · ${LEVELS[this.level].name}`,
      stats: [
        ["Your time", this.dnf ? "--" : fmt(this.youTime)],
        ["Top speed", `${Math.round(this.top * units[1])} ${units[0]}`],
        [place === 0 && !this.dnf ? "Gap" : "To the winner", gap],
      ],
      notes,
      rows: list.map((r) => ({ name: r.name, time: Number.isFinite(r.time) ? fmt(r.time) : "--", gap: r !== winner && Number.isFinite(r.time) ? `+${(r.time - winner.time).toFixed(2)}` : "", you: r.you })),
    });
  }

  // --- When there's no race --------------------------------------------------

  _idle(dt) {
    // The Race button, when you're stopped in a staging box.
    const show = this.hooks.ready() && this.vehicle.speed < 0.8 && !!stagingAt(this.vehicle.x, this.vehicle.z);
    if (show !== this._buttonShown) {
      this._buttonShown = show;
      this.button.hidden = !show;
      if (!show) this.panel.hidden = true;
    }
    // The timing boards show the strip you're nearest.
    this._boardTimer -= dt;
    if (this._boardTimer > 0) return;
    this._boardTimer = 1;
    let near = null;
    let nearD = 1500;
    for (const s of DRAG_STRIPS) {
      const d = Math.hypot(s.mapX - this.vehicle.x, s.mapZ - this.vehicle.z);
      if (d < nearD) {
        nearD = d;
        near = s;
      }
    }
    if (near && near !== this._boardFor) this._drawBoard(near);
  }

  // The timing board over the finish: the last run there (a drag race's
  // times, or a brake test's stops), and the best to go with it.
  _drawBoard(s) {
    this._boardFor = s;
    const last = this.lastRuns[s.id];
    const brake = last?.kind === "brake";
    const shown = (r) => (brake ? (Number.isFinite(r.score) ? `${r.score.toFixed(2)} m` : "--") : Number.isFinite(r.time) ? r.time.toFixed(2) : "--");
    const rows = last ? last.list.map((r) => ({ lane: r.lane, name: r.name, time: shown(r), you: r.you })) : [];
    let best;
    if (brake) {
      const b = this.settings.brakes?.[s.id]?.best;
      best = b ? `CLOSEST STOP ${b.dist.toFixed(2)} m` : "BRAKE TEST";
    } else {
      const b = this.settings.races[s.id]?.best;
      best = b ? `BEST ${fmt(b.time)}` : BOARD_DISTANCE;
    }
    drawBoard(this.boardTexture, { title: shortName(s).toUpperCase(), rows, best });
  }

  // --- Brake tests -----------------------------------------------------------

  // Each frame of a brake test, from green: the others, and you (`front` is
  // how far down the strip your front bumper is).
  _updateBrake(dt, t, front) {
    for (const ai of this.rivals) {
      stepRival(ai, t - ai.reaction, (v) => accel(ai.spec, ai.k, v));
      this._moveRival(ai);
    }
    if (this.state === "running") {
      this.top = Math.max(this.top, this.vehicle.speed);
      if (front > STAGE + 3) this.moved = true;
      // Over the line: the car brakes itself, and where it stops counts.
      if (front >= FINISH) this.autoBrake = true;
      if (this.moved && this.vehicle.speed < 0.15) {
        this.stopShort = FINISH - front;
        this._finishBrake();
      } else if (t > this.limit) {
        this.outOfTime = true;
        this._finishBrake();
      }
    }
    if (this.resultIn !== null) {
      this.resultIn -= dt;
      if (this.resultIn <= 0) {
        this.resultIn = null;
        this.result.hidden = false;
      }
    }
    this._brakeHud(t, front);
  }

  // The chip in a brake test: how far to the line (then where you stopped),
  // and the time left (then your place).
  _brakeHud(t, front) {
    let main;
    let side;
    if (this.state === "running" || this.state === "finished") {
      const left = this.stopShort ?? FINISH - front;
      main = this.outOfTime ? "--" : left >= 0 ? metres(left) : `${metres(left)} over`;
      side = this.state === "finished" ? (this.outOfTime ? "Out of time" : PLACES[this.place]) : `${Math.max(0, Math.ceil(this.limit - t))} s left`;
    } else {
      main = metres(FINISH - front);
      side = `${this.limit} s left`;
    }
    if (main !== this._shownClock) {
      this._shownClock = main;
      this.clockEl.textContent = main;
    }
    if (side !== this._shownPlace) {
      this._shownPlace = side;
      this.placeEl.textContent = side;
    }
  }

  // Stopped (or out of time): work out the places, save your closest stop, show the card.
  _finishBrake() {
    const s = this.strip;
    this.state = "finished";
    this.autoBrake = true;
    const entry = this.hooks.entry();
    const mine = this.outOfTime ? Infinity : score(this.stopShort);
    const list = this.rivals.map((ai) => ({ name: ai.entry.name, score: ai.score, short: ai.short, lane: ai.lane }));
    list.push({ name: "You", you: true, score: mine, short: this.stopShort, lane: YOU });
    list.sort((a, b) => a.score - b.score);
    const place = list.findIndex((r) => r.you);
    this.place = place;
    let newBest = false;
    if (!this.outOfTime) {
      // (Kept apart from the drag races' times and medals.)
      const rec = ((this.settings.brakes ??= {})[s.id] ??= { best: null, cars: {} });
      rec.cars ??= {};
      const my = (rec.cars[entry.id] ??= {});
      const d = +mine.toFixed(3);
      newBest = !rec.best || d < rec.best.dist;
      if (newBest) rec.best = { dist: d, car: entry.id };
      if (my.dist === undefined || d < my.dist) my.dist = d;
      const medal = MEDALS[place];
      if (medal) {
        my.medal = betterMedal(my.medal, medal);
        rec.medal = betterMedal(rec.medal, medal);
      }
      this.save(this.settings);
    }
    this.lastRuns[s.id] = { kind: "brake", list: [...list].sort((a, b) => a.lane - b.lane) };
    this._drawBoard(s);
    this._showBrakeResult(list, place, newBest);
    this.resultIn = 1.3;
  }

  _showBrakeResult(list, place, newBest) {
    const units = this.settings.units === "mph" ? ["mph", 2.23694] : ["km/h", 3.6];
    const out = this.outOfTime;
    const notes = [];
    if (out) notes.push(`You had ${this.limit} seconds to stop.`);
    else if (this.stopShort < 0) notes.push("Past the line counts double.");
    if (newBest) notes.push("Your closest stop on this strip!");
    this.resultUi.setPhoto(false);
    this.resultUi.fill({
      place: out ? -1 : place,
      title: out ? "Out of time" : TITLES[place],
      sub: `Brake test · ${shortName(this.strip)} · ${LEVELS[this.level].name}`,
      stats: [
        ["Your stop", out ? "--" : stopText(this.stopShort)],
        ["Score", out ? "--" : `${score(this.stopShort).toFixed(2)} m`],
        ["Top speed", `${Math.round(this.top * units[1])} ${units[0]}`],
      ],
      notes,
      rows: list.map((r) => ({ name: r.name, time: Number.isFinite(r.score) ? `${r.score.toFixed(2)} m` : "--", gap: Number.isFinite(r.score) && r.short < 0 ? "over" : "", you: r.you })),
      again: "Try again",
    });
  }
}
