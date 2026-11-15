import { clamp } from "./noise.js";

// All sound is made on the fly with the Web Audio API, so there are no
// sound files to download. iPads only allow sound after the first tap,
// so `start()` is called from a touch.

function noiseBuffer(ctx, seconds, brown = false) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (brown) {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    } else d[i] = w;
  }
  return buf;
}

// The kinds of engine sound (each garage entry names one, see garage.js).
// Combustion engines play one recorded-in-code engine cycle, faster as the
// revs rise:
//   offsets/strength: when each cylinder fires in the cycle, and how hard
//   (uneven spacing and strength give the lumpy V8 burble)
//   thump: the low note of each firing (Hz)   crack: its sharp edge
//   clatter: diesel knock, a rattle after each firing
//   tone, open: the muffler's filter, and how far it opens with throttle and revs
//   drive: how hard the sound is squashed (rougher)   volume
// Electric motors have no cycle: a hum and a whine that rise with speed, and
// nothing at all when stopped.
export const ENGINES = {
  // Four cylinders: smooth and a little buzzy.
  everyday: {
    offsets: [0, 0.25, 0.5, 0.75], strength: [1, 0.93, 0.97, 0.9], thump: 95, crack: 0.35, clatter: 0,
    tone: 520, open: 1100, revTone: 0.09, drive: 1.6, volume: 0.85,
  },
  // Eight cylinders: lumpy, louder, brighter, opening right up at high revs.
  sports: {
    offsets: [0, 0.13, 0.245, 0.37, 0.5, 0.635, 0.745, 0.875], strength: [1, 0.82, 0.93, 0.78, 0.97, 0.85, 0.9, 0.8], thump: 70, crack: 0.62, clatter: 0,
    tone: 500, open: 1700, revTone: 0.16, drive: 2.6, volume: 1,
  },
  // Big six-cylinder diesel: deep, slow revving, rough, with knock.
  diesel: {
    offsets: [0, 0.165, 0.34, 0.5, 0.66, 0.835], strength: [1, 0.86, 0.95, 0.83, 0.98, 0.88], thump: 48, crack: 0.3, clatter: 0.75,
    tone: 300, open: 650, revTone: 0.12, drive: 3.4, volume: 1.15,
  },
  electric: { electric: true, volume: 1 },
};

// One full engine cycle (two crank turns) at 1000 rpm for an engine above.
function engineCycle(ctx, e) {
  const cycle = 0.12;
  const len = Math.floor(ctx.sampleRate * cycle);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  e.offsets.forEach((offset, k) => {
    const start = Math.floor(offset * len);
    for (let i = 0; i < len * 0.12; i++) {
      const t = i / ctx.sampleRate;
      const env = Math.exp(-t * 260) * e.strength[k];
      const thump = Math.sin(2 * Math.PI * e.thump * t) * 0.9;
      const crack = (Math.random() * 2 - 1) * e.crack * Math.exp(-t * 900);
      // Diesel knock: a second, rattly burst just after the firing.
      const knock = e.clatter ? (Math.random() * 2 - 1) * e.clatter * Math.exp(-Math.abs(t - 0.004) * 1400) : 0;
      d[(start + i) % len] += (thump + crack + knock) * env;
    }
  });
  return buf;
}

// Squashes the sound: `drive` higher is rougher.
function shaperCurve(drive) {
  const curve = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) curve[i] = Math.tanh((i / 512 - 1) * drive);
  return curve;
}

// Two-note horns, by kind of vehicle (Hz): lorries and buses have deep ones.
const HORNS = { everyday: [415, 520], sports: [470, 590], diesel: [262, 330], electric: [415, 520] };

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.engine = "sports"; // which ENGINES sound the car you drive makes
    this.hornOn = false;
    this.targets = {};
  }

  start() {
    if (this.ctx) {
      if (this.ctx.state !== "running") this.ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 3;
    this.master = ctx.createGain();
    this.master.gain.value = this.enabled && !this.paused ? 0.9 : 0;
    this.master.connect(comp).connect(ctx.destination);
    // Stop all sound when the game goes into the background.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) ctx.suspend();
      else ctx.resume();
    });

    const white = noiseBuffer(ctx, 2);
    const brown = noiseBuffer(ctx, 3, true);
    const loop = (buffer, rate = 1) => {
      const s = ctx.createBufferSource();
      s.buffer = buffer;
      s.loop = true;
      s.playbackRate.value = rate;
      s.start();
      return s;
    };
    const filter = (type, freq, q = 0.7) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      return f;
    };
    const gain = (v = 0) => {
      const g = ctx.createGain();
      g.gain.value = v;
      return g;
    };

    // --- Engine: one pulse loop, played faster as the revs rise ---------------
    // (Its cycle is swapped for the kind of vehicle, see setEngine.)
    this.cycles = {};
    this.engineTone = filter("lowpass", 900, 1.2);
    this.shaper = ctx.createWaveShaper();
    this.engineGain = gain(0);
    this.engineTone.connect(this.shaper).connect(this.engineGain).connect(this.master);
    this.engineSrc = null;
    // Electric motor: a low hum and a higher whine, both rising with speed.
    this.hum = ctx.createOscillator();
    this.hum.type = "sine";
    this.whine = ctx.createOscillator();
    this.whine.type = "triangle";
    this.humGain = gain(0);
    this.whineGain = gain(0);
    const motorTone = filter("lowpass", 2600, 0.8);
    this.hum.connect(this.humGain).connect(motorTone);
    this.whine.connect(this.whineGain).connect(motorTone);
    motorTone.connect(this.master);
    this.hum.start();
    this.whine.start();
    this._loop = loop;
    this.setEngine(this.engine, true);

    // --- Horn: two notes through a filter, silent until pressed --------------
    this.hornNotes = [ctx.createOscillator(), ctx.createOscillator()];
    this.hornGain = gain(0);
    const hornTone = filter("lowpass", 2400, 1);
    for (const o of this.hornNotes) {
      o.type = "square";
      o.connect(hornTone);
      o.start();
    }
    hornTone.connect(this.hornGain).connect(this.master);
    this._hornPitch();

    // --- Car noises ---------------------------------------------------------------
    this.tyreGain = gain(0);
    loop(white).connect(filter("bandpass", 1500, 2.5)).connect(this.tyreGain).connect(this.master);
    this.roadGain = gain(0);
    loop(brown).connect(filter("lowpass", 260)).connect(this.roadGain).connect(this.master);
    // Metal grinding along a wall.
    this.scrapeGain = gain(0);
    loop(white, 1.3).connect(filter("bandpass", 2600, 3)).connect(filter("highpass", 1100)).connect(this.scrapeGain).connect(this.master);

    this.white = white;
    this.brown = brown;
  }

  setEnabled(on) {
    this.enabled = on;
    this._applyVolume();
  }

  // The kind of engine sound (a key of ENGINES), for the vehicle you drive.
  // Can be called before the first tap; it is used once sound starts.
  setEngine(kind, force = false) {
    if (!ENGINES[kind]) kind = "everyday";
    if (kind === this.engine && !force) return;
    this.engine = kind;
    if (!this.ctx) return;
    const e = ENGINES[kind];
    // A new looping source with this engine's cycle (a playing source's
    // sound can't be swapped).
    if (this.engineSrc) {
      this.engineSrc.stop();
      this.engineSrc.disconnect();
      this.engineSrc = null;
    }
    if (!e.electric) {
      this.cycles[kind] ??= engineCycle(this.ctx, e);
      this.engineSrc = this._loop(this.cycles[kind]);
      this.engineSrc.connect(this.engineTone);
      this.shaper.curve = shaperCurve(e.drive);
    }
    this._hornPitch();
  }

  _hornPitch() {
    if (!this.hornNotes) return;
    const [a, b] = HORNS[this.engine] ?? HORNS.everyday;
    this.hornNotes[0].frequency.value = a;
    this.hornNotes[1].frequency.value = b;
  }

  // Held down: the horn sounds.
  setHorn(on) {
    if (on === this.hornOn) return;
    this.hornOn = on;
    if (this.ctx) this._set(this.hornGain.gain, on ? 0.16 : 0, on ? 0.01 : 0.03);
  }

  // Silence everything while a menu is open (the game is paused then).
  setPaused(paused) {
    if (this.paused === paused) return;
    this.paused = paused;
    this._applyVolume();
  }

  _applyVolume() {
    if (this.master) this.master.gain.setTargetAtTime(this.enabled && !this.paused ? 0.9 : 0, this.ctx.currentTime, 0.08);
  }

  _set(param, value, time = 0.08) {
    param.setTargetAtTime(value, this.ctx.currentTime, time);
  }

  // Short one-off noise burst through a filter, e.g. crashes and splashes.
  _burst(type, freq, volume, decay, buffer = this.white, delay = 0) {
    const ctx = this.ctx;
    const s = ctx.createBufferSource();
    s.buffer = buffer;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    const now = ctx.currentTime + delay;
    g.gain.setValueAtTime(volume, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + decay);
    s.connect(f).connect(g).connect(this.master);
    s.start(now, Math.random());
    s.stop(now + decay + 0.05);
  }

  // A thump, crumpling metal, a rattle of bits giving way and, for big
  // hits, a tinkle of glass.
  crash(strength) {
    if (!this.ctx) return;
    const s = clamp(strength, 0, 1);
    this._burst("lowpass", 240, 1.3 * s, 0.4, this.brown);
    this._burst("bandpass", 1200, 0.8 * s, 0.45);
    const bits = 2 + Math.round(s * 6);
    for (let i = 0; i < bits; i++) {
      this._burst("bandpass", 1700 + Math.random() * 2800, (0.3 + Math.random() * 0.25) * s, 0.05 + Math.random() * 0.12, this.white, 0.015 + i * (0.02 + Math.random() * 0.035));
    }
    if (s > 0.55) {
      for (let i = 0; i < 6; i++) this._burst("bandpass", 5200 + Math.random() * 3000, 0.12 * s, 0.08 + Math.random() * 0.1, this.white, 0.05 + Math.random() * 0.45);
    }
  }

  splash() {
    if (!this.ctx) return;
    this._burst("lowpass", 1200, 1, 1.4);
  }

  // A short beep for the drag strip's start lights: lower for each amber,
  // higher and longer for green.
  beep(high = false) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = "square";
    o.frequency.value = high ? 1320 : 660;
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 2600;
    const g = ctx.createGain();
    const now = ctx.currentTime;
    const len = high ? 0.42 : 0.16;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.16, now + 0.01);
    g.gain.setValueAtTime(0.16, now + len - 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, now + len);
    o.connect(f).connect(g).connect(this.master);
    o.start(now);
    o.stop(now + len + 0.02);
  }

  // What the engine should sound like now, for the engine kind in use:
  // playback rate and filter of the cycle, and volumes (Hz and gains for an
  // electric motor). Kept apart from update() so it can be checked without
  // a sound card (the test browser plays nothing).
  // (Written into `out`, so nothing new is made every frame.)
  engineTargets(car, driving, inCabin, out = {}) {
    const e = ENGINES[this.engine];
    const speed = car ? car.speed : 0;
    const load = car ? car.throttle : 0;
    const cabin = inCabin ? 0.8 : 1;
    if (e.electric) {
      // No idle: silent standing still, a hum and a rising whine on the move,
      // louder while pulling.
      const on = driving ? clamp(speed / 1.5, 0, 1) : 0;
      out.rate = 1;
      out.tone = 0;
      out.gain = 0;
      out.hum = 55 + speed * 7;
      out.humGain = on * (0.05 + load * 0.07) * cabin;
      out.whine = 240 + speed * 46;
      out.whineGain = on * (0.012 + load * 0.035 + clamp(speed / 40, 0, 1) * 0.015) * cabin;
      return out;
    }
    // Off once you've got out; only a quiet tick-over when sitting still;
    // louder and brighter with throttle and revs.
    const rpm = car ? car.rpm : 0;
    const idle = !driving ? 0 : 0.035 + clamp(speed / 6, 0, 1) * 0.11;
    out.rate = Math.max(0.5, rpm / 1000);
    out.tone = e.tone + load * e.open + rpm * e.revTone;
    out.gain = driving ? (idle + load * 0.3) * e.volume * cabin : 0;
    out.hum = 55;
    out.humGain = 0;
    out.whine = 240;
    out.whineGain = 0;
    return out;
  }

  // Called every frame. `car` is the vehicle (or null when walking).
  update(dt, { car, onFoot, inCabin }) {
    if (!this.ctx || this.ctx.state !== "running") return;
    const speed = car ? car.speed : 0;
    const driving = car && !onFoot;

    const t = this.engineTargets(car, driving, inCabin, this.targets);
    if (this.engineSrc) this._set(this.engineSrc.playbackRate, t.rate, 0.05);
    this._set(this.engineTone.frequency, t.tone || 400);
    this._set(this.engineGain.gain, t.gain, 0.12);
    this._set(this.hum.frequency, t.hum, 0.05);
    this._set(this.whine.frequency, t.whine, 0.05);
    this._set(this.humGain.gain, t.humGain, 0.1);
    this._set(this.whineGain.gain, t.whineGain, 0.1);

    // Tyres: squeal when sliding sideways, and when spinning or locking
    // (the same scrub that makes smoke and skid marks).
    const slip = car ? clamp((car.slip - 0.1) * 4, 0, 1) : 0;
    const scrub = car ? clamp((car.scrub - 0.25) * 1.6, 0, 1) : 0;
    this._set(this.tyreGain.gain, driving && car.grounded ? Math.max(slip * 0.22 * clamp(speed / 8, 0, 1), scrub * 0.16) : 0);
    this._set(this.scrapeGain.gain, driving ? car.scrape * (0.3 + Math.random() * 0.15) : 0, 0.03);
    this._set(this.roadGain.gain, driving && car.grounded ? clamp(speed / 40, 0, 1) * 0.35 : 0);
  }
}
