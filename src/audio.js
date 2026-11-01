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

// One full engine cycle (two crank turns) of an eight-cylinder engine at
// 1000 rpm: eight combustion pulses with slightly uneven spacing and
// strength, which gives the lumpy V8 burble. Played faster for higher revs.
function engineCycle(ctx) {
  const cycle = 0.12;
  const len = Math.floor(ctx.sampleRate * cycle);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  const offsets = [0, 0.13, 0.245, 0.37, 0.5, 0.635, 0.745, 0.875];
  const strength = [1, 0.82, 0.93, 0.78, 0.97, 0.85, 0.9, 0.8];
  for (let k = 0; k < 8; k++) {
    const start = Math.floor(offsets[k] * len);
    for (let i = 0; i < len * 0.12; i++) {
      const t = i / ctx.sampleRate;
      const env = Math.exp(-t * 260) * strength[k];
      const thump = Math.sin(2 * Math.PI * 70 * t) * 0.9;
      const crack = (Math.random() * 2 - 1) * 0.55 * Math.exp(-t * 900);
      d[(start + i) % len] += (thump + crack) * env;
    }
  }
  return buf;
}

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.enabled = true;
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
    this.engineSrc = loop(engineCycle(ctx));
    this.engineTone = filter("lowpass", 900, 1.2);
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 512 - 1) * 2.4;
      curve[i] = Math.tanh(x);
    }
    shaper.curve = curve;
    this.engineGain = gain(0);
    this.engineSrc.connect(this.engineTone).connect(shaper).connect(this.engineGain).connect(this.master);

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

  // Called every frame. `car` is the vehicle (or null when walking).
  update(dt, { car, onFoot, inCabin }) {
    if (!this.ctx || this.ctx.state !== "running") return;
    const speed = car ? car.speed : 0;
    const driving = car && !onFoot;

    // Engine: off once you've got out; only a quiet tick-over when sitting
    // still; louder and brighter with throttle and revs.
    const rpm = car ? car.rpm : 0;
    const load = car ? car.throttle : 0;
    const moving = clamp(speed / 6, 0, 1);
    const idle = !driving ? 0 : 0.035 + moving * 0.11; // nearly silent when stopped
    this._set(this.engineSrc.playbackRate, Math.max(0.5, rpm / 1000), 0.05);
    this._set(this.engineTone.frequency, 400 + load * 1300 + rpm * 0.1);
    this._set(this.engineGain.gain, driving ? (idle + load * 0.3) * (inCabin ? 0.8 : 1) : 0, 0.12);

    const slip = car ? clamp((car.slip - 0.1) * 4, 0, 1) : 0;
    this._set(this.tyreGain.gain, driving && car.grounded ? slip * 0.22 * clamp(speed / 8, 0, 1) : 0);
    this._set(this.scrapeGain.gain, driving ? car.scrape * (0.3 + Math.random() * 0.15) : 0, 0.03);
    this._set(this.roadGain.gain, driving && car.grounded ? clamp(speed / 40, 0, 1) * 0.35 : 0);
  }
}
