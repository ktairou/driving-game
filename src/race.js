import { GARAGE } from "./garage.js";
import { PLACES, TITLES, MEDALS, raceButton, raceChip, startPanel, resultCard } from "./raceUi.js";
import { CAR_COLOURS } from "./traffic.js";
import { DRAG_STRIPS } from "./world/layout.js";
import { STAGE, FINISH, laneW, stripPoint, stagingAt, setLamps, drawBoard } from "./world/dragstrips.js";

// Drag races: you against three cars over a quarter mile on a drag strip.
// One race at a time: idle -> (loading the other cars) -> staged ->
// countdown -> running -> finished, then Race again or Leave.
//
// The other cars are drawn by the traffic (as cars with `racing: true`, which
// the traffic leaves alone) and moved here, in a straight line, with the same
// sums as your car's physics (vehicle.js) at full throttle.

// Each level: the others' reaction time and engine power. `slack`: on Hard
// their engines are matched to run a shade slower than yours flat out, or
// with a quicker start and more power they couldn't be beaten at all.
const LEVELS = {
  easy: { name: "Easy", reaction: 0.45, power: 0.88, slack: 1 },
  medium: { name: "Medium", reaction: 0.3, power: 0.97, slack: 1 },
  hard: { name: "Hard", reaction: 0.18, power: 1.04, slack: 1.02 },
};
const STEP = 1 / 120; // the same physics step as vehicle.js
const ROLLING = 32; // rolling resistance, as in vehicle.js
const RUN = FINISH - STAGE; // the quarter mile: 402 m
const STAGED_FOR = 1.2; // seconds lined up before the first amber
const AMBER_GAP = 0.5;
const PENALTY = 1; // seconds added for a false start
const GIVE_UP = 45; // still not over the line this long after green: the race is over
const STOP_SHORT = 24; // everyone stops this far before the end of the run-off
const YOU = 2; // your lane
const THEIR_LANES = [1, 3, 4];

// Forward pull at full throttle, less air and rolling resistance, over mass
// (vehicle.js on a flat road, going straight). `k` scales the engine.
function accel(spec, k, v) {
  const drive = k * Math.min(spec.maxDrive ?? 10500, (spec.power ?? 300000) / Math.max(v, 1));
  return (drive - (spec.drag ?? 0.42) * v * v - ROLLING * v) / (spec.mass ?? 1350);
}

// Seconds to cover the quarter mile from a standstill.
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

// The engine scale that makes another vehicle run the quarter mile in `time`.
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

// The three vehicles nearest yours in power for their weight (so a bus races
// buses and vans, and a sports car races fast cars). Locked ones too: the
// other drivers don't need to buy them.
export function pickRivals(entry) {
  const pw = (g) => g.spec.power / g.spec.mass;
  const mine = pw(entry);
  return GARAGE.filter((g) => g !== entry)
    .map((g) => ({ g, d: Math.abs(Math.log(pw(g) / mine)) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map((o) => o.g);
}

const fmt = (t) => `${t.toFixed(2)} s`;
const shortName = (s) => {
  const n = s.name.replace("Drag strip · ", "");
  return n[0].toUpperCase() + n.slice(1);
};

export class DragRace {
  // hooks: { entry() -> your garage entry, place(x, z, heading), toast(text),
  //   ready() -> may a race be offered now, onStart(), kinds: { load(id), release(ids) },
  //   earn?(place, level) -> credits won }
  constructor({ vehicle, traffic, audio, fuel, settings, save, boardTexture, hooks }) {
    Object.assign(this, { vehicle, traffic, audio, fuel, settings, save, boardTexture, hooks });
    this.state = "idle";
    this.strip = null;
    this.rivals = [];
    this.loaded = new Set(); // kinds of vehicle loaded just for this race
    this.lastRuns = {}; // per strip, for the timing board
    this.level = LEVELS[settings.raceLevel] ? settings.raceLevel : "medium";
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
      note: "Race three cars over a quarter mile (402 m). Wait for the green light, then go!",
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

  // Tapping Race: check there's fuel, then show the panel.
  open() {
    const s = stagingAt(this.vehicle.x, this.vehicle.z);
    if (!s || this.active) return;
    if (this._lowFuel()) return;
    this.strip = s;
    // (The same level as last time, whichever kind of race that was.)
    if (LEVELS[this.settings.raceLevel]) this.level = this.settings.raceLevel;
    this._markLevel();
    const best = this.bestText(s);
    this.panelUi.show({ best: best ? `Your ${best.replace("Best", "best here:").replace(" · ", " in the ")}` : "No best time here yet." });
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
    const rivals = pickRivals(entry);
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
    this.rivals = rivals.map((g, i) => {
      const type = types[i];
      const car = { moving: true, racing: true, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, speed: 0, stopTimer: 0, type, colour: CAR_COLOURS[(i * 3 + 1) % CAR_COLOURS.length] };
      this.traffic.cars.push(car);
      return { entry: g, spec: g.spec, match: {}, lane: THEIR_LANES[i], car, length: type.length ?? 4.6 };
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
    for (const ai of this.rivals) {
      // Its engine scaled to run the quarter mile flat out as fast as yours
      // (times the level's slack; worked out once per level).
      ai.match[this.level] ??= matchEngine(ai.spec, this.yourRun * level.slack);
      // A little different every time.
      ai.reaction = Math.max(0.08, level.reaction + (Math.random() - 0.5) * 0.1);
      ai.k = ai.match[this.level] * level.power * (1 + (Math.random() - 0.5) * 0.03);
      ai.finish = ai.reaction + runTime(ai.spec, ai.k);
      ai.u0 = STAGE - ai.length / 2 - 0.25;
      ai.x = 0;
      ai.v = 0;
      ai.t = 0;
      ai.over = false;
      this._moveRival(ai);
    }
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
    this._setLights(0);
    this.result.hidden = true;
    this.chip.hidden = false;
    this.button.hidden = true;
    this._buttonShown = false;
    this._drawBoard(s);
  }

  again() {
    if (this.state !== "finished" || this._lowFuel()) return;
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
      if (this.state === "countdown" && input.throttle > 0 && !this.falseStart) {
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
    setLamps(this.strip, { amber, green: go, red: this.falseStart }, { amber, green: go, red: false });
    this.chipUi.lights(n, this.falseStart);
  }

  _hud(t = 0) {
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
    let earned = 0;
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
      earned = this.hooks.earn?.(place, this.level) ?? 0;
      this.save(this.settings);
    }
    this.lastRuns[s.id] = [...list].sort((a, b) => a.lane - b.lane);
    this._drawBoard(s);
    this._showResult(list, place, newBest, earned);
    this.resultIn = 1.3;
  }

  _showResult(list, place, newBest, earned) {
    const units = this.settings.units === "mph" ? ["mph", 2.23694] : ["km/h", 3.6];
    const winner = list[0];
    let gap;
    if (this.dnf) gap = "Didn't finish";
    else if (place === 0) gap = `Won by ${fmt(list[1].time - this.youTime)}`;
    else gap = `${fmt(this.youTime - winner.time)} behind`;
    const notes = [];
    if (this.falseStart) notes.push("False start: 1 second added.");
    if (newBest) notes.push("New best on this strip!");
    if (earned) notes.push(`+${earned} credits.`);
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
      rows: list.map((r) => ({ name: r.name, time: Number.isFinite(r.time) ? fmt(r.time) : "--", you: r.you })),
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

  _drawBoard(s) {
    this._boardFor = s;
    const last = this.lastRuns[s.id];
    const rows = last ? last.map((r) => ({ lane: r.lane, name: r.name, time: Number.isFinite(r.time) ? r.time.toFixed(2) : "--", you: r.you })) : [];
    const best = this.settings.races[s.id]?.best;
    drawBoard(this.boardTexture, { title: shortName(s).toUpperCase(), rows, best: best ? `BEST ${fmt(best.time)}` : "QUARTER MILE · 402 m" });
  }
}
