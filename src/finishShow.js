import { Color3, Color4, DynamicTexture, Mesh, MeshBuilder, ParticleSystem, StandardMaterial, Texture, Vector3, VertexBuffer } from "@babylonjs/core";
import "./finishShow.css";
import { clamp, lerp, smoothstep } from "./noise.js";
import { MEDALS, TITLES, ordinal } from "./raceUi.js";
import { FINISH, HALF, stripPoint, toStrip } from "./world/dragstrips.js";
import { ROAD_HALF_WIDTH, ROAD_SAMPLE_STEP } from "./world/layout.js";

// The finish of a race, drag or street (race.js, streetRace.js):
//  1. Over the line: a second of slow motion, a cut to a camera beside the
//     line, your place in big letters and your time.
//  2. A photo from beside the finish line (speedPhotos.js), framing you and
//     the cars near you; it goes on the result card and into the album.
//  3. Once the top three are over the line (or after a while, if one of them
//     is far behind), they line up side by side, gold, silver and bronze
//     badges over them, fireworks overhead and confetti falling, while the
//     camera slowly circles them. Skip goes straight to the card.
//  4. The result card. Race again / Leave (or the map, the garage, getting
//     out...) call stop(), which puts everything back.
//
// One show at a time. Nothing here runs while no race is finishing. The
// fireworks and confetti (300 particles at most), the badges and their
// small drawn texture are made the first time and kept.

const SLOW = 0.3; // the world's speed in slow motion
const SLOW_FOR = 1; // seconds (real time) of slow motion...
const EASE_BACK = 0.35; // ...then back up to full speed over this long
const PLACE_FOR = 2.9; // the big place text stays this long
const WAIT_MIN = 2.6; // the top three line up no sooner than this after you cross...
const WAIT_MAX = 9; // ...and no later, even if one of them is still racing
const AFTER_LAST = 0.7; // ...and this long after the third of them crosses
const FADE = 0.32; // to black and back, while the cars are moved
const PARTY_FOR = 7.2; // seconds of fireworks and circling camera before the card
const SPARKS = 175; // particles at most: firework sparks...
const ROCKETS = 8; // ...the rockets going up...
const CONFETTI = 117; // ...and confetti (300 in all)
const GRAVITY = 9.81;
const LINES = ["You won!", "Second place", "Third place", "Fourth place", "Fifth place", "Sixth place"];
const placeLine = (i) => TITLES[i] ?? LINES[i] ?? `${ordinal(i + 1)} place`;
// Firework colours: gold, red, green, blue, purple, white, orange, pink.
const COLOURS = [
  [1, 0.8, 0.32],
  [1, 0.28, 0.24],
  [0.36, 1, 0.42],
  [0.34, 0.58, 1],
  [0.78, 0.4, 1],
  [1, 1, 1],
  [1, 0.55, 0.16],
  [1, 0.45, 0.78],
];
// The badges' metal: highlight, middle, shadow; and the ink on them.
const METAL = {
  gold: ["#fff6c4", "#f2c230", "#a87208", "#3a2a02"],
  silver: ["#ffffff", "#ccd3db", "#7b8592", "#1f252c"],
  bronze: ["#ffd9b5", "#cd7c3c", "#7a3d12", "#2c1405"],
};
const BADGE_W = 170; // each badge's part of the texture (px)...
const BADGE_H = 256;
const BADGE_SIZE = 1.35; // ...and its width over a car (m)
const BADGE_UP = 1.12; // its middle this far over the roof (the name plate's foot about 0.35 m)

const el = (tag, cls, html = "") => {
  const e = document.createElement(tag);
  e.className = cls;
  e.innerHTML = html;
  return e;
};

// A soft round dot, white (each particle tints it).
function dotTexture(scene) {
  const t = new DynamicTexture("finishSpark", { width: 32, height: 32 }, scene, false, Texture.BILINEAR_SAMPLINGMODE);
  const c = t.getContext();
  const g = c.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.28, "rgba(255,255,255,0.9)");
  g.addColorStop(0.6, "rgba(255,255,255,0.28)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  c.fillStyle = g;
  c.fillRect(0, 0, 32, 32);
  t.hasAlpha = true;
  t.update();
  return t;
}

// Confetti: eight little coloured pieces side by side; each particle shows one.
const CONFETTI_COLOURS = ["#ffd23f", "#ff4d5e", "#3fa9ff", "#45d483", "#ff7bd1", "#ffffff", "#ff9a3c", "#a26bff"];
function confettiTexture(scene) {
  const t = new DynamicTexture("finishConfetti", { width: 64, height: 32 }, scene, false, Texture.BILINEAR_SAMPLINGMODE);
  const c = t.getContext();
  c.clearRect(0, 0, 64, 32);
  CONFETTI_COLOURS.forEach((col, i) => {
    c.fillStyle = col;
    c.fillRect((i % 4) * 16 + 2, Math.floor(i / 4) * 16 + 3, 12, 10);
  });
  t.hasAlpha = true;
  t.update();
  return t;
}

// A rounded box path (the canvas's own roundRect is newer than some iPads' Safari).
function roundBox(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

// The particle system moves by the time we give it (so it slows, pauses and
// can be run forward by tests like the rest of the game), not the screen's
// frame time. Big steps are cut into small ones.
function ownClock(ps) {
  const stock = ps.updateFunction;
  ps.fsDt = 0;
  ps.updateFunction = (particles) => {
    let left = Math.min(ps.fsDt, 2);
    ps.fsDt = 0;
    while (left > 1e-5) {
      const h = Math.min(left, 1 / 30);
      ps._scaledUpdateSpeed = h;
      stock(particles);
      left -= h;
    }
  };
}

export class FinishShow {
  // hooks: { camera() -> the game camera, handBack() (the game's own camera
  //   takes over again), car() -> your vehicle's model, photo(job)
  //   (speedPhotos.js finish), warm(job) (speedPhotos.js warm), view(record)
  //   (opens a photo in the album), night() -> 0 by day to 1 at night }
  constructor({ scene, world, vehicle, traffic, audio, hooks }) {
    Object.assign(this, { scene, world, vehicle, traffic, audio, hooks });
    this.phase = null; // "slow", "wait", "fade", "party", "card" (null: no show)
    this.timeScale = 1; // the world's speed (main.js scales its frame time by it)
    this.filming = false; // this has the game camera
    this.race = null;
    this.racers = null;
    this.lineup = null; // { x, y, z, heading }: the middle of the top three
    this.lined = false;
    this.photoUrl = null;
    this.photoRec = null;
    this.parts = null; // particles and badges, made the first time
    this.warmFor = null; // a race starting: its photo camera gets ready during the countdown
    this._hold = { x: 0, z: 0, r: 34 }; // traffic waits outside this (street races)
    this._lineCam = new Vector3();
    this._look = new Vector3();
    this._burstAt = new Vector3();
    this._launchAt = new Vector3();
    this._launchVel = new Vector3();
    this._ringA = new Vector3();
    this._ringB = new Vector3();
    this._ring = false;
    this.shells = Array.from({ length: 6 }, () => ({ live: false, at: 0, x: 0, y: 0, z: 0, colour: COLOURS[0], power: 9, count: 40, ring: false }));
    this._buildUi();
  }

  // --- On screen ---------------------------------------------------------------

  _buildUi() {
    const hud = document.getElementById("hud");
    this.hud = hud;
    // (First in the HUD: the black covers the world, not the buttons.)
    this.fadeEl = el("div", "fs-fade");
    hud.prepend(this.fadeEl);
    this.placeEl = el("div", "fs-place", `<div class="fs-big"><span class="fs-num"></span><span class="fs-suf"></span></div><div class="fs-line"></div><div class="fs-time"></div>`);
    this.captionEl = el("div", "fs-caption", `<b></b><span>Top three</span>`);
    this.skipEl = el("button", "fs-skip", "Skip");
    this.skipEl.hidden = true;
    this.skipEl.addEventListener("click", () => this.skip());
    hud.append(this.placeEl, this.captionEl, this.skipEl);
  }

  _showPlace(place, time) {
    const p = this.placeEl;
    const word = ordinal(place + 1);
    p.querySelector(".fs-num").textContent = String(place + 1);
    p.querySelector(".fs-suf").textContent = word.slice(-2).toUpperCase();
    p.querySelector(".fs-line").textContent = placeLine(place);
    p.querySelector(".fs-time").textContent = time;
    p.className = `fs-place ${MEDALS[place] ?? "plain"}`;
    void p.offsetWidth; // (so the animation starts again)
    p.classList.add("show");
    this.placeShown = true;
  }

  _hidePlace() {
    if (!this.placeShown) return;
    this.placeShown = false;
    this.placeEl.classList.add("out");
  }

  // --- Over the line -----------------------------------------------------------

  // Called by a race as you cross the finish (after it has filled in its
  // card): `list` is everyone in finishing order ({ name, time, you }),
  // `place` yours (0 = first), `fmt` its way of writing times. True if the
  // show is on (it shows the card itself); false if you didn't finish.
  finish(kind, race, list, place, { fmt, newBest = false, earned = 0 } = {}) {
    if (race.dnf || !(place >= 0)) return false;
    this.stop();
    const token = (this.token = {});
    this.kind = kind;
    this.race = race;
    this.place = place;
    this.saved = { newBest, earned };
    // Everyone, in the race's own order, with the car the traffic draws for them.
    const left = race.rivals.slice();
    this.racers = list.map((r) => {
      if (r.you) return { you: true, name: "You", car: null, ai: null, spot: null };
      let i = left.findIndex((ai) => ai.entry.name === r.name);
      if (i < 0) i = 0;
      const ai = left.splice(i, 1)[0] ?? null;
      return { you: false, name: r.name, car: ai?.car ?? null, ai, spot: null };
    });
    const time = fmt(race.youTime);
    const from = kind === "drag" ? this._dragSpots(race) : this._streetSpots(race);
    // The photo, this frame: you and whoever is close by.
    const v = this.vehicle;
    const subjects = [v];
    for (const r of this.racers) if (r.car && Math.hypot(r.car.x - v.x, r.car.z - v.z) < 32) subjects.push(r.car);
    race.resultUi.setPhoto(true);
    this.hooks.photo({ from, subjects, race: this.name, pos: ordinal(place + 1), time, medal: MEDALS[place], done: (rec, blob) => this.token === token && this._photo(rec, blob) });
    // Slow motion, the camera by the line, and your place.
    this._showPlace(place, time);
    this.captionEl.querySelector("b").textContent = this.name;
    this.phase = "slow";
    this.t = 0;
    this.readyAt = null;
    this.slowOff = false;
    this.lined = false;
    this.filming = true;
    this.camMode = "line";
    this.skipEl.hidden = false;
    return true;
  }

  // A drag strip: the line camera low by the barrier on your side, a little
  // past the line; the photo from beside the finish gantry; the top three
  // near the end of the run-off, facing back up the strip.
  _dragSpots(race) {
    const s = race.strip;
    const side = toStrip(s, this.vehicle.x, this.vehicle.z).w < 0 ? -1 : 1;
    let [x, z] = stripPoint(s, FINISH + 15, side * (HALF + 1.4));
    this._lineCam.set(x, s.height + 1.7, z);
    [x, z] = stripPoint(s, s.length - 40, 0);
    this.lineup = { x, y: s.height, z, heading: s.heading + Math.PI, across: 11, sweep: [-0.75, 1], flat: true };
    this.name = s.name;
    // (High on the gantry's post, looking back across the line.)
    [x, z] = stripPoint(s, FINISH + 2.5, side * (HALF + 2.1));
    return [x, s.height + 5.6, z];
  }

  // A street race: the same about its finish gate (kept up for the photo);
  // the top three on the road a little way past it, facing on.
  _streetSpots(race) {
    const plan = race.plan;
    const f = plan.gates[plan.gates.length - 1];
    const nx = f.tz;
    const nz = -f.tx;
    const side = (this.vehicle.x - f.x) * nx + (this.vehicle.z - f.z) * nz < 0 ? -1 : 1;
    const ground = (x, z) => this.world.getHeight(x, z);
    let x = f.x + f.tx * 15 + nx * side * (ROAD_HALF_WIDTH + 1.3);
    let z = f.z + f.tz * 15 + nz * side * (ROAD_HALF_WIDTH + 1.3);
    this._lineCam.set(x, ground(x, z) + 1.5, z);
    const pts = plan.theirs.points;
    const j = Math.min(pts.length - 3, plan.finishIdx + Math.round(38 / ROAD_SAMPLE_STEP));
    const a = pts[j - 2];
    const b = pts[j + 2];
    this.lineup = { x: pts[j].x, y: ground(pts[j].x, pts[j].z), z: pts[j].z, heading: Math.atan2(b.x - a.x, b.z - a.z), across: 6.5, sweep: [-0.65, 0.95], flat: false };
    this.name = race.race.name;
    race.parts.showCheckpoints(plan.gates, plan.gates.length - 1);
    // (Up by the gate's post, looking back across the line.)
    x = f.x + f.tx * 5 + nx * side * (ROAD_HALF_WIDTH + 2);
    z = f.z + f.tz * 5 + nz * side * (ROAD_HALF_WIDTH + 2);
    return [x, ground(x, z) + 4.3, z];
  }

  _photo(rec, blob) {
    if (this.photoUrl) URL.revokeObjectURL(this.photoUrl);
    this.photoUrl = URL.createObjectURL(blob);
    this.photoRec = rec;
    this.race.resultUi.setPhoto(true, this.photoUrl, () => this.hooks.view(this.photoRec));
  }

  // A race is starting (main.js, the races' onStart): once everyone is on the
  // line, one picture is drawn and thrown away, so the finish photo's camera
  // and everything in it are ready by the time it's needed.
  warmUp(race) {
    this.warmFor = race;
  }

  _warmUp() {
    const race = this.warmFor;
    if (race.state === "idle") this.warmFor = null;
    if (race.state !== "countdown") return;
    this.warmFor = null;
    const v = this.vehicle;
    const fx = Math.sin(v.heading);
    const fz = Math.cos(v.heading);
    const subjects = [v];
    for (const ai of race.rivals) subjects.push(ai.car);
    this.hooks.warm({ from: [v.x + fx * 12 + fz * 7, v.y + 4.5, v.z + fz * 12 - fx * 7], subjects });
  }

  // --- Each frame (real time; not while the game is paused) ------------------

  update(dt) {
    if (this.warmFor) this._warmUp();
    if (!this.phase) return;
    this.t += dt;
    const t = this.t;
    // Slow for a moment (eased in over a few frames), then back to full speed.
    const slow = this.slowOff ? 0 : t < SLOW_FOR ? smoothstep(0, 0.08, t) : 1 - smoothstep(SLOW_FOR, SLOW_FOR + EASE_BACK, t);
    this.timeScale = lerp(1, SLOW, slow);
    this.audio.pitch = lerp(1, 0.62, slow);
    if (t > PLACE_FOR) this._hidePlace();
    if (this.phase === "slow" && t > SLOW_FOR + EASE_BACK + 0.15) {
      // Back behind your car while it stops.
      this.phase = "wait";
      this._handBack();
    }
    if (this.phase === "slow" || this.phase === "wait") {
      if (this.readyAt === null && this._topDone()) this.readyAt = t;
      if (t >= WAIT_MIN && ((this.readyAt !== null && t >= this.readyAt + AFTER_LAST) || t >= WAIT_MAX)) {
        this.phase = "fade";
        this.fadeT = 0;
        this.fadeEl.classList.add("on");
      }
    } else if (this.phase === "fade") {
      this.fadeT += dt;
      if (this.fadeT >= FADE) {
        this._lineUp();
        this.phase = "party";
        this.fadeEl.classList.remove("on");
      }
    }
    // (A photo that never came: the card stops waiting for it.)
    if (this.phase === "card" && !this.photoUrl && t > this.revealAt + 4) {
      this.revealAt = Infinity;
      this.race.resultUi.setPhoto(false);
    }
    if (!this.lined) return;
    this.orbitT += dt;
    this._pose();
    this._badges();
    for (const ps of this.parts.systems) ps.fsDt += dt;
    if (this.phase === "party") {
      this._fireworks(dt);
      this._confetti(dt);
      if (this.orbitT >= PARTY_FOR) this._reveal();
    }
  }

  // Are the top three over the line yet?
  _topDone() {
    const n = Math.min(3, this.racers.length);
    const race = this.race;
    for (let i = 0; i < n; i++) {
      const r = this.racers[i];
      if (r.you || !r.ai) continue;
      if (this.kind === "drag" ? race.clock - race.greenAt < r.ai.finish : r.ai.time === null && !r.ai.done) return false;
    }
    return true;
  }

  // Skip: straight to the card (the top three stay lined up, if they are).
  skip() {
    if (!this.phase || this.phase === "card") return;
    if (this.phase === "fade") {
      this._lineUp();
      this.fadeEl.classList.remove("on");
    }
    this._reveal();
  }

  // The result card (a street race's filled in again: some may have crossed since).
  _reveal() {
    this.phase = "card";
    this.revealAt = this.t;
    this.slowOff = true;
    this._hidePlace();
    this.captionEl.classList.remove("show");
    this.skipEl.hidden = true;
    if (!this.lined) this._handBack();
    if (this.parts) for (const ps of this.parts.systems) ps.stop();
    if (this.kind === "street") this._refillStreet();
    this.race.resultUi.el.hidden = false;
  }

  _refillStreet() {
    const race = this.race;
    const list = race.rivals.map((ai) => ({ name: ai.entry.name, time: ai.time ?? Infinity, along: ai.driver.progress }));
    list.push({ name: "You", you: true, time: race.youTime, along: Infinity });
    list.sort((a, b) => a.time - b.time || b.along - a.along);
    race._showResult(list, this.place, this.saved.newBest, this.saved.earned);
  }

  // --- The top three, lined up -------------------------------------------------

  _lineUp() {
    const race = this.race;
    if (this.kind === "street") {
      // Who's ahead now: over the line in time order, then furthest along.
      const key = (r) => (r.you ? race.youTime : (r.ai?.time ?? Infinity));
      const along = (r) => (r.you ? Infinity : (r.ai?.driver.progress ?? 0));
      this.racers.sort((a, b) => key(a) - key(b) || along(b) - along(a));
      // The traffic kept clear of them.
      this._hold.x = this.lineup.x;
      this._hold.z = this.lineup.z;
      this.traffic.clearAround(this.lineup.x, this.lineup.z, 45);
    }
    const L = this.lineup;
    const fx = Math.sin(L.heading);
    const fz = Math.cos(L.heading);
    // Far enough apart for the widest of them (a bus is wider than a car).
    let wide = 1;
    for (const r of this.racers) wide = Math.max(wide, r.you ? (this.hooks.car().geometry.halfWidth ?? 1) : (r.car?.type.halfWidth ?? 1));
    const gap = Math.max(2.9, 2 * wide + 0.9);
    // Gold in the middle and a little ahead, silver on its left and bronze on
    // its right (seen from in front); the rest in rows behind them.
    this.racers.forEach((r, i) => {
      let along;
      let across;
      if (i < 3) [along, across] = [[1.6, 0], [0, gap], [0, -gap]][i];
      else {
        // (Up to three a row, each row centred.)
        const k = i - 3;
        const row = Math.floor(k / 3);
        const inRow = Math.min(3, this.racers.length - 3 - row * 3);
        along = -16 - 7 * row;
        across = ((k % 3) - (inRow - 1) / 2) * gap;
      }
      const x = L.x + fx * along + fz * across;
      const z = L.z - fx * across + fz * along;
      const length = r.you ? this.vehicle.length : (r.car?.type.length ?? 4.6);
      let y = L.y + 0.06;
      let pitch = 0;
      if (!L.flat) {
        const front = this.world.getHeight(x + fx * length * 0.35, z + fz * length * 0.35);
        const back = this.world.getHeight(x - fx * length * 0.35, z - fz * length * 0.35);
        y = (front + back) / 2 + 0.04;
        pitch = -Math.atan2(front - back, length * 0.7);
      }
      r.spot = { x, y, z, pitch, top: y + this._height(r) };
      if (r.you) {
        this.vehicle.place(x, z, L.heading);
        r.spot.top = this.vehicle.y + this._height(r);
      }
    });
    this.lined = true;
    this.orbitT = 0;
    this.camMode = "orbit";
    this.filming = true;
    this.hud.classList.add("hud-finale");
    this.captionEl.classList.add("show");
    this._pose();
    this._startParts();
  }

  // How tall a racer's vehicle is (for its badge).
  _height(r) {
    return clamp((r.you ? this.hooks.car().geometry.height : r.car?.type.height) ?? 1.45, 1, 4.4);
  }

  // The races move their cars every frame: they're put back in the line-up
  // after that (and before the traffic draws them), and the traffic is kept
  // waiting (a street race lets it go once its start is behind it).
  _pose() {
    const heading = this.lineup.heading;
    for (const r of this.racers) {
      const c = r.car;
      if (!c || !r.spot) continue;
      c.x = r.spot.x;
      c.y = r.spot.y;
      c.z = r.spot.z;
      c.yaw = heading;
      c.pitch = r.spot.pitch;
      c.speed = 0;
      // (A street race lets a finished car go home once it's far from you.)
      if (!this.traffic.cars.includes(c)) this.traffic.cars.push(c);
    }
    if (this.kind === "street") this.traffic.hold = this._hold;
  }

  // --- The camera --------------------------------------------------------------

  // Moves the game camera (main.js, instead of the chase camera, while `filming`).
  film(dt) {
    const cam = this.hooks.camera();
    cam.minZ = 0.1;
    cam.upVector.set(0, 1, 0);
    if (this.camMode === "line") {
      // By the finish line, following your car past it.
      const v = this.vehicle;
      cam.position.copyFrom(this._lineCam);
      this._look.set(v.x + v.vx * 0.04, v.y + 0.75, v.z + v.vz * 0.04);
      cam.setTarget(this._look);
      const d = Vector3.Distance(cam.position, this._look);
      cam.fov = clamp(2 * Math.atan(6.5 / Math.max(d, 3)), 0.32, 1.05);
      return;
    }
    // Slowly round the front of the top three, from one front corner to the
    // other, rising and drawing back as it goes. (Not round the sides: from
    // there the cars, side by side, hide each other. Longer along them than
    // across, to keep off a street's pavements.) Looking a little up, so the
    // fireworks are in the picture.
    const L = this.lineup;
    const e = smoothstep(0, PARTY_FOR, this.orbitT);
    const a = lerp(L.sweep[0], L.sweep[1], e) + Math.max(0, this.orbitT - PARTY_FOR) * 0.04;
    const fx = Math.sin(L.heading);
    const fz = Math.cos(L.heading);
    const along = Math.cos(a) * lerp(11.5, 14, e);
    const across = Math.sin(a) * L.across;
    const x = L.x + fx * along + fz * across;
    const z = L.z + fz * along - fx * across;
    const y = Math.max(L.y + lerp(1.7, 4.2, e), this.world.getHeight(x, z) + 0.8);
    cam.position.set(x, y, z);
    this._look.set(L.x + fx * 0.8, L.y + 2.3, L.z + fz * 0.8);
    cam.setTarget(this._look);
    cam.fov = 0.9;
  }

  _handBack() {
    if (!this.filming) return;
    this.filming = false;
    this.hooks.handBack();
  }

  // --- Badges, fireworks and confetti ------------------------------------------

  _makeParts() {
    const scene = this.scene;
    const dot = dotTexture(scene);
    const spark = (name, cap) => {
      const ps = new ParticleSystem(name, cap, scene);
      ps.particleTexture = dot;
      ps.billboardMode = ParticleSystem.BILLBOARDMODE_STRETCHED;
      ps.emitRate = 0;
      ps.manualEmitCount = 0;
      ps.minEmitPower = 1;
      ps.maxEmitPower = 1;
      ps.minAngularSpeed = 0;
      ps.maxAngularSpeed = 0;
      ownClock(ps);
      return ps;
    };
    // Sparks: out fast from the burst, slowing, drooping, fading.
    const sparks = spark("finishSparks", SPARKS);
    sparks.emitter = this._burstAt;
    sparks.minLifeTime = 1.15;
    sparks.maxLifeTime = 1.9;
    sparks.minScaleY = 2.2;
    sparks.maxScaleY = 3.4;
    sparks.gravity = new Vector3(0, -3.2, 0);
    sparks.addDragGradient(0, 0);
    sparks.addDragGradient(0.3, 0.6);
    sparks.addDragGradient(1, 0.86);
    sparks.startPositionFunction = (wm, pos) => pos.copyFrom(this._burstAt);
    sparks.startDirectionFunction = (wm, dir) => this._sparkDir(dir);
    // A rocket: one bright streak up to where its shell bursts.
    const rockets = spark("finishRockets", ROCKETS);
    rockets.emitter = this._launchAt;
    rockets.minSize = 0.16;
    rockets.maxSize = 0.2;
    rockets.minScaleY = 5;
    rockets.maxScaleY = 6;
    rockets.gravity = new Vector3(0, -GRAVITY, 0);
    rockets.color1 = new Color4(1, 0.86, 0.55, 1);
    rockets.color2 = new Color4(1, 0.75, 0.4, 1);
    rockets.colorDead = new Color4(1, 0.7, 0.3, 0.5);
    rockets.startPositionFunction = (wm, pos) => pos.copyFrom(this._launchAt);
    rockets.startDirectionFunction = (wm, dir) => dir.copyFrom(this._launchVel);
    // Confetti: coloured pieces drifting down over the cars, turning as they fall.
    const confetti = new ParticleSystem("finishConfetti", CONFETTI, scene, null, true);
    confetti.particleTexture = confettiTexture(scene);
    confetti.spriteCellWidth = 16;
    confetti.spriteCellHeight = 16;
    confetti.startSpriteCellID = 0;
    confetti.endSpriteCellID = 7;
    confetti.spriteRandomStartCell = true;
    confetti.spriteCellChangeSpeed = 0;
    confetti.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    confetti.emitter = this._burstAt; // (not used: it starts where startPositionFunction says)
    confetti.emitRate = 0;
    confetti.manualEmitCount = 0;
    confetti.minLifeTime = 4.4;
    confetti.maxLifeTime = 5.4;
    confetti.minSize = 0.16;
    confetti.maxSize = 0.24;
    confetti.minScaleX = 1;
    confetti.maxScaleX = 1;
    confetti.minScaleY = 0.45;
    confetti.maxScaleY = 0.75;
    confetti.minInitialRotation = 0;
    confetti.maxInitialRotation = Math.PI * 2;
    confetti.minAngularSpeed = -5;
    confetti.maxAngularSpeed = 5;
    confetti.minEmitPower = 1;
    confetti.maxEmitPower = 1;
    confetti.gravity = new Vector3(0, -0.32, 0);
    this.confettiLight = [new Color4(1, 1, 1, 1), new Color4(1, 1, 1, 1), new Color4(1, 1, 1, 0)];
    confetti.addColorGradient(0, this.confettiLight[0]);
    confetti.addColorGradient(0.84, this.confettiLight[1]);
    confetti.addColorGradient(1, this.confettiLight[2]);
    confetti.startPositionFunction = (wm, pos) => {
      const L = this.lineup;
      pos.set(L.x + (Math.random() - 0.5) * 14, L.y + 8.5 + Math.random() * 2.5, L.z + (Math.random() - 0.5) * 14);
    };
    confetti.startDirectionFunction = (wm, dir) => dir.set((Math.random() - 0.5) * 0.8, -0.9 - Math.random() * 0.6, (Math.random() - 0.5) * 0.8);
    ownClock(confetti);

    // Badges: three medals with places and names, drawn into one small texture.
    const tex = new DynamicTexture("finishBadges", { width: 512, height: BADGE_H }, scene, true, Texture.TRILINEAR_SAMPLINGMODE);
    tex.hasAlpha = true;
    const mat = new StandardMaterial("finishBadgeMat", scene);
    mat.disableLighting = true;
    mat.emissiveTexture = tex;
    mat.opacityTexture = tex;
    mat.diffuseColor = new Color3(0, 0, 0);
    mat.specularColor = new Color3(0, 0, 0);
    mat.fogEnabled = false;
    mat.backFaceCulling = false;
    const badges = [0, 1, 2].map((i) => {
      const m = MeshBuilder.CreatePlane(`finishBadge${i}`, { width: BADGE_SIZE, height: (BADGE_SIZE * BADGE_H) / BADGE_W }, scene);
      const u0 = (i * BADGE_W) / 512;
      const u1 = ((i + 1) * BADGE_W) / 512;
      m.setVerticesData(VertexBuffer.UVKind, [u0, 0, u1, 0, u1, 1, u0, 1]);
      m.material = mat;
      m.billboardMode = Mesh.BILLBOARDMODE_ALL;
      m.isPickable = false;
      m.setEnabled(false);
      return m;
    });
    this.parts = { sparks, rockets, confetti, systems: [sparks, rockets, confetti], tex, badges };
  }

  // The medals, with whose they are under them (redrawn once a race).
  _drawBadges() {
    const c = this.parts.tex.getContext();
    c.clearRect(0, 0, 512, BADGE_H);
    for (let i = 0; i < 3; i++) {
      const r = this.racers[i];
      if (!r) continue;
      const [hi, mid, lo, ink] = METAL[MEDALS[i]];
      const ox = i * BADGE_W;
      const cx = ox + BADGE_W / 2;
      const cy = 86;
      const R = 72;
      // The disc: lit from the top left, with a darker rim and a fine ring inside.
      const g = c.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
      g.addColorStop(0, hi);
      g.addColorStop(0.45, mid);
      g.addColorStop(1, lo);
      c.beginPath();
      c.arc(cx, cy, R, 0, Math.PI * 2);
      c.fillStyle = g;
      c.fill();
      c.lineWidth = 5;
      c.strokeStyle = lo;
      c.stroke();
      c.beginPath();
      c.arc(cx, cy, R - 11, 0, Math.PI * 2);
      c.lineWidth = 2.5;
      c.strokeStyle = "rgba(255,255,255,0.55)";
      c.stroke();
      // The place: "1" big, "ST" small beside it.
      const word = ordinal(i + 1);
      c.fillStyle = ink;
      c.textBaseline = "alphabetic";
      c.font = "italic 900 92px -apple-system, 'Segoe UI', Roboto, sans-serif";
      const nw = c.measureText(word.slice(0, -2)).width;
      c.font = "italic 900 32px -apple-system, 'Segoe UI', Roboto, sans-serif";
      const sw = c.measureText(word.slice(-2).toUpperCase()).width;
      const x0 = cx - (nw + sw + 2) / 2;
      c.font = "italic 900 92px -apple-system, 'Segoe UI', Roboto, sans-serif";
      c.textAlign = "left";
      c.fillText(word.slice(0, -2), x0, cy + 32);
      c.font = "italic 900 32px -apple-system, 'Segoe UI', Roboto, sans-serif";
      c.fillText(word.slice(-2).toUpperCase(), x0 + nw + 2, cy - 4);
      // The name plate.
      roundBox(c, ox + 8, 178, BADGE_W - 16, 46, 14);
      c.fillStyle = "rgba(10, 14, 20, 0.85)";
      c.fill();
      c.fillStyle = r.you ? "#ffcf4a" : "#ffffff";
      c.textAlign = "center";
      c.textBaseline = "middle";
      let size = 24;
      do c.font = `700 ${size}px -apple-system, 'Segoe UI', Roboto, sans-serif`;
      while (c.measureText(r.name).width > BADGE_W - 34 && --size > 12);
      c.fillText(r.name, cx, 202, BADGE_W - 30);
    }
    this.parts.tex.update();
  }

  _startParts() {
    if (!this.parts) this._makeParts();
    const p = this.parts;
    const night = this.hooks.night();
    // At night the sparks glow (added light); by day they'd fade into the
    // bright sky that way, so they're drawn solid and a little bigger.
    const glow = night > 0.45;
    for (const ps of [p.sparks, p.rockets]) ps.blendMode = glow ? ParticleSystem.BLENDMODE_ADD : ParticleSystem.BLENDMODE_STANDARD;
    p.sparks.minSize = glow ? 0.3 : 0.5;
    p.sparks.maxSize = glow ? 0.42 : 0.66;
    // Confetti isn't lit by anything but the day.
    const k = 1 - 0.7 * night;
    for (const col of this.confettiLight) col.set(k, k, k, col.a);
    for (const ps of p.systems) {
      ps.reset();
      ps.fsDt = 0;
      ps.manualEmitCount = 0;
      ps.start();
    }
    for (const s of this.shells) s.live = false;
    this.nextShell = 0.35;
    this.confettiDebt = 0;
    this._drawBadges();
    for (let i = 0; i < 3; i++) p.badges[i].setEnabled(!!this.racers[i]);
    this._badges();
  }

  // Each badge floats over its car, popping in one after the other.
  _badges() {
    const t = this.orbitT;
    for (let i = 0; i < 3; i++) {
      const r = this.racers[i];
      if (!r) continue;
      const m = this.parts.badges[i];
      const s = r.spot;
      const k = clamp((t - 0.35 - (2 - i) * 0.25) / 0.45, 0, 1);
      // (Overshoots a little before it settles.)
      const pop = k <= 0 ? 0.001 : 1 + 2.2 * (k - 1) ** 3 + 1.2 * (k - 1) ** 2;
      m.scaling.setAll(Math.max(0.001, pop));
      m.position.set(s.x, s.top + BADGE_UP + Math.sin(t * 2.1 + i * 1.7) * 0.08, s.z);
    }
  }

  // A rocket every half second or so, bursting a second later behind the
  // cars as the camera sees them, low enough to be in the picture.
  _fireworks(dt) {
    const p = this.parts;
    this.nextShell -= dt;
    // (A rocket or burst asked for is made at the next drawing, which takes
    // the count back to 0: until then, the next one waits.)
    if (this.nextShell <= 0 && this.orbitT < PARTY_FOR - 1.4 && !p.rockets.manualEmitCount) {
      this.nextShell = 0.45 + Math.random() * 0.35;
      this._launch();
    }
    if (p.sparks.manualEmitCount) return;
    for (const s of this.shells) {
      if (!s.live || this.orbitT < s.at) continue;
      s.live = false;
      this._burst(s);
      return; // (one burst per frame: they share the sparks' colours)
    }
  }

  _launch() {
    const shell = this.shells.find((s) => !s.live);
    if (!shell) return;
    const L = this.lineup;
    const cam = this.hooks.camera().position;
    let dx = L.x - cam.x;
    let dz = L.z - cam.z;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    const back = 16 + Math.random() * 16;
    const side = (Math.random() - 0.5) * 30;
    shell.x = L.x + dx * back - dz * side;
    shell.z = L.z + dz * back + dx * side;
    shell.y = L.y + 7 + Math.random() * 6;
    const tb = 0.95 + Math.random() * 0.3;
    shell.at = this.orbitT + tb;
    shell.live = true;
    shell.colour = COLOURS[(Math.random() * COLOURS.length) | 0];
    shell.power = 8 + Math.random() * 4;
    shell.count = 40 + ((Math.random() * 14) | 0);
    shell.ring = Math.random() < 0.3;
    // Its rocket: from the ground below (a little to one side), there just in time.
    const lx = shell.x + (Math.random() - 0.5) * 4;
    const lz = shell.z + (Math.random() - 0.5) * 4;
    const ly = Math.max(L.y, this.world.getHeight(lx, lz)) + 0.5;
    this._launchAt.set(lx, ly, lz);
    this._launchVel.set((shell.x - lx) / tb, (shell.y - ly + 0.5 * GRAVITY * tb * tb) / tb, (shell.z - lz) / tb);
    const r = this.parts.rockets;
    r.minLifeTime = r.maxLifeTime = tb;
    r.manualEmitCount = 1;
  }

  _burst(s) {
    const ps = this.parts.sparks;
    const c = s.colour;
    this._burstAt.set(s.x, s.y, s.z);
    ps.color1.set(c[0], c[1], c[2], 1);
    ps.color2.set(lerp(c[0], 1, 0.4), lerp(c[1], 1, 0.4), lerp(c[2], 1, 0.4), 1);
    ps.colorDead.set(c[0] * 0.6, c[1] * 0.45, c[2] * 0.4, 0);
    ps.minEmitPower = s.power * 0.75;
    ps.maxEmitPower = s.power;
    // A ring: sparks out in one tilted flat circle, not every way.
    this._ring = s.ring;
    if (s.ring) {
      const tilt = 0.35 + Math.random() * 0.6;
      const turn = Math.random() * Math.PI * 2;
      this._ringA.set(Math.cos(turn), 0, Math.sin(turn));
      this._ringB.set(-Math.sin(turn) * Math.cos(tilt), Math.sin(tilt), Math.cos(turn) * Math.cos(tilt));
    }
    ps.manualEmitCount = s.count;
  }

  // Which way a new spark goes (any way at all, or round a ring), at unit speed.
  _sparkDir(dir) {
    const a = Math.random() * Math.PI * 2;
    if (this._ring) {
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      dir.set(this._ringA.x * ca + this._ringB.x * sa, this._ringA.y * ca + this._ringB.y * sa, this._ringA.z * ca + this._ringB.z * sa);
      return;
    }
    const y = Math.random() * 2 - 1;
    const r = Math.sqrt(1 - y * y);
    dir.set(r * Math.cos(a), y, r * Math.sin(a));
  }

  // About 24 pieces a second (the particle cap keeps it to about a hundred at once).
  _confetti(dt) {
    if (this.orbitT > PARTY_FOR - 1) return;
    this.confettiDebt += 24 * dt;
    const n = Math.floor(this.confettiDebt);
    if (!n) return;
    this.confettiDebt -= n;
    this.parts.confetti.manualEmitCount += n;
  }

  // --- Putting everything back -------------------------------------------------

  // Race again, Leave, or the race ended some other way (map, garage, getting
  // out, reset...): the camera, time, sound, cars, traffic and screen as before.
  stop() {
    if (!this.phase) return;
    this.phase = null;
    this.token = null;
    this.timeScale = 1;
    this.audio.pitch = 1;
    this._handBack();
    this.placeShown = false;
    this.placeEl.className = "fs-place";
    this.captionEl.classList.remove("show");
    this.skipEl.hidden = true;
    this.fadeEl.classList.remove("on");
    this.hud.classList.remove("hud-finale");
    if (this.parts) {
      for (const ps of this.parts.systems) {
        ps.reset();
        ps.stop();
      }
      for (const b of this.parts.badges) b.setEnabled(false);
    }
    if (this.traffic.hold === this._hold) this.traffic.hold = null;
    this.race?.resultUi.setPhoto(false);
    if (this.photoUrl) URL.revokeObjectURL(this.photoUrl);
    this.photoUrl = null;
    this.photoRec = null;
    this.lined = false;
    this.racers = null;
    this.race = null;
  }
}
